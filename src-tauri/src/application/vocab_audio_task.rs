//! application/vocab_audio_task.rs —— 生词本「补全发音」的后台任务
//!
//! 2026-08-17 (用户反馈"我跑了一个补全发音但是任务没有"): 原实现在前端 vocab_view.js
//! 里用一个 `for (const w of words) await ttsCacheWord(w)` 循环逐词调命令 —— 没有任务、
//! 没有进度、没有取消, 只有开头和结尾两个 toast; 几百个词跑几分钟中间毫无反馈, 而且
//! 用户一切走页面这个循环就断了, 断在哪里也无从得知。
//!
//! 这里把它挪到 Rust 侧的后台线程: 有进度、能取消、切走页面不中断, 处理中页能看到它。
//!
//! **刻意不进 jobs 表 / pump_queue**: 那条队列是"一次只跑一本书"的严格串行(显存安全,
//! 见 pipeline/runner.py 的 LLM/TTS 不同驻), 而补发音走的是常驻语音守护(tts_daemon),
//! 是另一种资源。塞进同一条队列会让它排在几小时的备料后面, 与"点一下马上开始"的预期
//! 相反。所以它是一个独立的单例后台任务, 只借用处理中页的展示位。
use serde::Serialize;
use std::sync::{Arc, Mutex};

/// 单例进度快照。前端轮询 `vocab_audio_status` 或收 `vocab-audio-progress` 事件。
#[derive(Clone, Debug, Default, Serialize)]
pub struct VocabAudioProgress {
    pub running: bool,
    pub total: usize,
    /// 已处理(= synthesized + skipped + failed), 进度条分子
    pub done: usize,
    /// 本次真的合成了几个
    pub synthesized: usize,
    /// 已有缓存直接跳过几个(幂等, 不重复合成)
    pub skipped: usize,
    pub failed: usize,
    /// 当前正在合成的词(展示用)
    pub current: String,
    /// 收尾原因: "" 未结束 / "done" 跑完 / "canceled" 用户取消 / 其它 = 错误摘要
    pub outcome: String,
    pub finished_at: i64,
}

#[derive(Default)]
pub struct VocabAudioState {
    pub progress: Mutex<VocabAudioProgress>,
    /// 取消标志: 只由 vocab_audio_cancel 置位, 工作线程每词检查一次
    pub cancel: Mutex<bool>,
}

/// 一个词处理完之后怎么记账(纯函数, 可单测 —— 这是这个模块里唯一有分支逻辑的部分)。
#[derive(Debug, PartialEq, Eq)]
pub enum WordOutcome {
    Synthesized,
    Skipped,
    Failed,
}

pub fn apply_outcome(p: &mut VocabAudioProgress, word: &str, outcome: WordOutcome) {
    p.done += 1;
    p.current = word.to_string();
    match outcome {
        WordOutcome::Synthesized => p.synthesized += 1,
        WordOutcome::Skipped => p.skipped += 1,
        WordOutcome::Failed => p.failed += 1,
    }
}

/// 收尾: 落终态。`outcome` 见字段说明。
pub fn finish(p: &mut VocabAudioProgress, outcome: &str, now_ms: i64) {
    p.running = false;
    p.current = String::new();
    p.outcome = outcome.to_string();
    p.finished_at = now_ms;
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 启动。已经在跑就直接返回当前进度(不重复起第二个线程)。
/// 语音模型没配好时不假装开始, 直接返回错误让前端说人话。
pub fn start(
    app: tauri::AppHandle,
    state: Arc<VocabAudioState>,
    prep_path: std::path::PathBuf,
    data_dir: std::path::PathBuf,
    tts_model: String,
    words: Vec<String>,
) -> Result<VocabAudioProgress, String> {
    {
        let p = state.progress.lock().unwrap();
        if p.running {
            return Ok(p.clone());
        }
    }
    if tts_model.is_empty() || !std::path::Path::new(&tts_model).exists() {
        return Err("还没有配置语音模型, 先去模型中心装一个再补发音".into());
    }
    let words: Vec<String> = words
        .into_iter()
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return Err("生词本为空, 无需补全".into());
    }

    {
        let mut p = state.progress.lock().unwrap();
        *p = VocabAudioProgress {
            running: true,
            total: words.len(),
            ..Default::default()
        };
    }
    *state.cancel.lock().unwrap() = false;

    let snapshot = state.progress.lock().unwrap().clone();
    std::thread::spawn(move || {
        run_loop(app, state, prep_path, data_dir, tts_model, words);
    });
    Ok(snapshot)
}

fn run_loop(
    app: tauri::AppHandle,
    state: Arc<VocabAudioState>,
    prep_path: std::path::PathBuf,
    data_dir: std::path::PathBuf,
    tts_model: String,
    words: Vec<String>,
) {
    use tauri::Emitter;
    let target_dir = data_dir.join("tts_cache");
    let _ = std::fs::create_dir_all(&target_dir);

    for w in words {
        if *state.cancel.lock().unwrap() {
            let mut p = state.progress.lock().unwrap();
            finish(&mut p, "canceled", now_ms());
            let _ = app.emit("vocab-audio-progress", p.clone());
            return;
        }
        let target = crate::commands::dictionary::tts_cache_path(&data_dir, &w);
        let outcome = if target.is_file() {
            WordOutcome::Skipped
        } else {
            match synth_one(&prep_path, &tts_model, &w, &target) {
                Ok(()) => WordOutcome::Synthesized,
                Err(_) => WordOutcome::Failed,
            }
        };
        {
            let mut p = state.progress.lock().unwrap();
            apply_outcome(&mut p, &w, outcome);
            // 每词发一次事件: 词一多(几百个)也就几百条, 前端只更新一行进度, 不昂贵;
            // 攒批发反而会让"当前正在处理哪个词"看起来卡住。
            let _ = app.emit("vocab-audio-progress", p.clone());
        }
    }
    let mut p = state.progress.lock().unwrap();
    finish(&mut p, "done", now_ms());
    let _ = app.emit("vocab-audio-progress", p.clone());
}

fn synth_one(
    prep_path: &std::path::Path,
    tts_model: &str,
    word: &str,
    target: &std::path::Path,
) -> Result<(), String> {
    let b64 = crate::infrastructure::tts_daemon::synth(
        prep_path, tts_model, "en", word, "af_heart", 1.0,
    )?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .map_err(|e| format!("解码语音 base64 失败: {e}"))?;
    std::fs::write(target, bytes).map_err(|e| format!("写语音缓存失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_outcome_counts_three_kinds_separately() {
        let mut p = VocabAudioProgress {
            total: 3,
            ..Default::default()
        };
        apply_outcome(&mut p, "cat", WordOutcome::Synthesized);
        apply_outcome(&mut p, "dog", WordOutcome::Skipped);
        apply_outcome(&mut p, "owl", WordOutcome::Failed);
        assert_eq!(p.done, 3, "三种结果都要算进已处理(进度条才会走到头)");
        assert_eq!((p.synthesized, p.skipped, p.failed), (1, 1, 1));
        assert_eq!(p.current, "owl");
    }

    #[test]
    fn skipped_is_not_failed() {
        // 幂等跳过(已有缓存)是正常情况, 不该污染失败计数——否则"补全发音"跑第二遍
        // 会显示全部失败。
        let mut p = VocabAudioProgress::default();
        for w in ["a", "b"] {
            apply_outcome(&mut p, w, WordOutcome::Skipped);
        }
        assert_eq!(p.failed, 0);
        assert_eq!(p.skipped, 2);
    }

    #[test]
    fn finish_clears_running_and_current() {
        let mut p = VocabAudioProgress {
            running: true,
            current: "cat".into(),
            ..Default::default()
        };
        finish(&mut p, "canceled", 1234);
        assert!(!p.running);
        assert_eq!(
            p.current, "",
            "收尾要清掉'当前词', 否则 UI 停在最后一个词上像卡死"
        );
        assert_eq!(p.outcome, "canceled");
        assert_eq!(p.finished_at, 1234);
    }
}
