//! application/standardize_task.rs —— 导入自动标准化转换的后台串行队列 (2026-08-19)
//!
//! 用户拍板: 体检 block 的书不再拒绝导入, 而是登记后由后台用 pymupdf 兜底解析
//! (prep 侧 --standardize-book) 再试一次, 过程和结果显示在书卡上。
//!
//! 与 job_orchestrator::pump_queue 的区别: 那条队列是"一次跑一本"的备料串行队列
//! (显存安全), 这里是一条独立的单例队列, 只处理 books.standardize_status='pending'
//! 的原书 —— 兜底解析要开 pymupdf 进程, 同一时刻也只处理一本, 不并发 (导入 10 本
//! block 书不会并发起 10 个进程)。

use crate::store;

/// 单例状态: 同一时刻只处理一本书 (不是"每本书一个线程")。
#[derive(Default)]
pub struct StandardizeState {
    pub running: std::sync::Mutex<bool>,
}

/// apply_report 的输出: 一本书落 done 还是 failed。
#[derive(Debug, PartialEq, Eq)]
pub struct StandardizeOutcome {
    /// "done" | "failed" (状态机取值是三端契约, 不能改)
    pub status: String,
    /// 给人看的结果 (done/failed 都要填)
    pub note: String,
    /// done 时 = report 文件本身 (book 字段就在同一个 JSON 里, 不是单独文件)
    pub cache_path: Option<String>,
}

/// 纯函数: 读 --standardize-book 输出的 report JSON, 决定 status/note/cache_path。
/// 绝不 panic —— 畸形/空 JSON 一律落 failed。
/// verdict 取值 (与 Python 侧约定): ok | warn | block; ok/warn → done, 其它 → failed。
pub fn apply_report(report_text: &str, report_path: &str) -> StandardizeOutcome {
    let parsed: serde_json::Value = match serde_json::from_str(report_text) {
        Ok(v) => v,
        Err(e) => {
            return StandardizeOutcome {
                status: "failed".into(),
                note: format!("转换尝试失败: 报告解析失败 ({e})"),
                cache_path: None,
            }
        }
    };
    let verdict = parsed.get("verdict").and_then(|v| v.as_str()).unwrap_or("");
    if verdict == "ok" || verdict == "warn" {
        let chapters = parsed.get("chapters").and_then(|c| c.as_i64()).unwrap_or(0);
        let sentences = parsed
            .get("sentences")
            .and_then(|s| s.as_i64())
            .unwrap_or(0);
        StandardizeOutcome {
            status: "done".into(),
            note: format!("{chapters}章{sentences}句, 已可正常处理"),
            cache_path: Some(report_path.to_string()),
        }
    } else {
        let note = parsed
            .get("issues")
            .and_then(|i| i.as_array())
            .and_then(|arr| arr.first())
            .and_then(|i| i.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("兜底解析仍不达标")
            .to_string();
        StandardizeOutcome {
            status: "failed".into(),
            note,
            cache_path: None,
        }
    }
}

/// 队列泵是否应立即返回 (已经在跑)。单独抽出可测: pump 需要 AppHandle, 不好在单测里
/// 起真 tauri runtime, 而"running=true 短路"这条守卫是最需要锁死的分支。
pub fn should_skip_pump(state: &StandardizeState) -> bool {
    *state.running.lock().unwrap()
}

/// 同步 spawn 侧车 --standardize-book, 等待退出 (这条线程本身已是后台线程)。
/// 参照 commands/book_audit.rs::audit_one_blocking 的 Command 写法。
fn run_standardize(
    prep_path: &std::path::Path,
    source_path: &str,
    report_path: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(prep_path);
    cmd.arg("--standardize-book")
        .arg(source_path)
        .arg("--out")
        .arg(report_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let status = cmd
        .status()
        .map_err(|e| format!("启动标准化转换失败: {e}"))?;
    if !status.success() {
        return Err(format!(
            "标准化转换子进程退出码 {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "未知".into())
        ));
    }
    Ok(())
}

/// 队列泵: 串行处理一条 pending。已在跑 → 直接返回; 无 pending → 返回。
pub fn pump_standardize_queue(
    app: tauri::AppHandle,
    cfg: &crate::PrepConfig,
    state: &StandardizeState,
    db: &store::Db,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    // 1. 已经在跑 → 直接返回 (同一时刻只处理一本)
    if should_skip_pump(state) {
        return Ok(());
    }
    // 2. 取最早一条 pending (SQL 层面 ORDER BY created_at LIMIT 1)
    let repo = store::books_repo::BooksRepo::new(db);
    let next = match repo.next_pending_standardize() {
        Some(b) => b,
        None => return Ok(()),
    };

    // 3. running=true + 这本书 running + emit (卡片立刻显示"转换中")
    *state.running.lock().unwrap() = true;
    {
        let mut b = next.clone();
        b.standardize_status = "running".into();
        b.standardize_note = None;
        b.standardize_cache_path = None;
        b.updated_at = store::now_ms_for_store();
        let _ = repo.upsert(&b);
    }
    let _ = app.emit("library-changed", serde_json::json!({}));

    // 4. 后台线程做真正的工作 (普通线程即可, 不占 GPU/模型)
    let book_id = next.id.clone();
    let source_path = next.source_path.clone();
    let prep_path = cfg.prep_path.clone();
    let data_dir = app
        .try_state::<crate::DataPaths>()
        .map(|d| d.data_dir.clone())
        .unwrap_or_default();
    let app2 = app.clone();
    std::thread::spawn(move || {
        use tauri::{Emitter, Manager};
        let cache_dir = data_dir.join("standardize_cache");
        let _ = std::fs::create_dir_all(&cache_dir);
        let report_path = cache_dir.join(format!("{book_id}.json"));

        let outcome = match run_standardize(&prep_path, &source_path, &report_path) {
            Err(e) => StandardizeOutcome {
                status: "failed".into(),
                note: format!("转换尝试失败: {e}"),
                cache_path: None,
            },
            Ok(()) => match std::fs::read_to_string(&report_path) {
                Err(e) => StandardizeOutcome {
                    status: "failed".into(),
                    note: format!("转换尝试失败: 读报告失败 ({e})"),
                    cache_path: None,
                },
                Ok(text) => apply_report(&text, &report_path.to_string_lossy()),
            },
        };

        if let Some(db) = app2.try_state::<store::Db>() {
            let repo = store::books_repo::BooksRepo::new(db.inner());
            if let Some(mut b) = repo.get(&book_id) {
                b.standardize_status = outcome.status;
                b.standardize_note = Some(outcome.note);
                b.standardize_cache_path = outcome.cache_path;
                b.updated_at = store::now_ms_for_store();
                let _ = repo.upsert(&b);
            }
        }
        let _ = app2.emit("library-changed", serde_json::json!({}));

        // running=false → 处理下一条 pending (参照 pump_queue 递归处理队列的写法)
        if let Some(state) = app2.try_state::<StandardizeState>() {
            *state.running.lock().unwrap() = false;
        }
        if let (Some(cfg), Some(db), Some(state)) = (
            app2.try_state::<crate::PrepConfig>(),
            app2.try_state::<store::Db>(),
            app2.try_state::<StandardizeState>(),
        ) {
            let _ = pump_standardize_queue(app2.clone(), cfg.inner(), state.inner(), db.inner());
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_report_ok_maps_to_done_with_chapter_sentence_note() {
        let out = apply_report(
            r#"{"verdict":"ok","chapters":10,"sentences":200}"#,
            "C:/cache/book.json",
        );
        assert_eq!(out.status, "done");
        assert!(
            out.note.contains("10章200句"),
            "note 应含章节句数: {}",
            out.note
        );
        assert_eq!(
            out.cache_path.as_deref(),
            Some("C:/cache/book.json"),
            "done 时 cache_path = report 文件本身"
        );
    }

    #[test]
    fn apply_report_warn_also_maps_to_done() {
        // 判据约定: ok/warn 都算"兜底后达标", 都能走创建译本
        let out = apply_report(
            r#"{"verdict":"warn","chapters":5,"sentences":80,"issues":[{"message":"x"}]}"#,
            "C:/cache/book.json",
        );
        assert_eq!(out.status, "done");
        assert!(out.cache_path.is_some());
    }

    #[test]
    fn apply_report_block_uses_first_issue_message() {
        let out = apply_report(
            r#"{"verdict":"block","issues":[{"message":"解析结果过少"}]}"#,
            "C:/cache/book.json",
        );
        assert_eq!(out.status, "failed");
        assert_eq!(out.note, "解析结果过少");
        assert_eq!(out.cache_path, None);
    }

    #[test]
    fn apply_report_block_without_issues_falls_back_to_generic_note() {
        let out = apply_report(r#"{"verdict":"block"}"#, "C:/cache/book.json");
        assert_eq!(out.status, "failed");
        assert_eq!(out.note, "兜底解析仍不达标");
        assert_eq!(out.cache_path, None);
    }

    #[test]
    fn apply_report_malformed_or_empty_is_failed_without_panic() {
        for text in ["", "not json", "{", "{\"verdict\":42}"] {
            let out = apply_report(text, "C:/cache/book.json");
            assert_eq!(out.status, "failed", "输入 {text:?} 应落 failed");
            assert!(out.cache_path.is_none());
        }
    }

    #[test]
    fn pump_returns_immediately_when_already_running() {
        // 假设的"已经在跑"场景: running=true 时守卫应短路, pump 不会去查库/起线程。
        let state = StandardizeState::default();
        *state.running.lock().unwrap() = true;
        assert!(
            should_skip_pump(&state),
            "running=true 时 pump 第一步就该短路返回"
        );
        *state.running.lock().unwrap() = false;
        assert!(!should_skip_pump(&state), "空闲时应放行");
    }
}
