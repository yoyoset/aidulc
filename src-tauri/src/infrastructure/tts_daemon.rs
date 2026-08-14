//! infrastructure/tts_daemon.rs —— 常驻语音合成守护 (K29, 2026-08-14)
//!
//! 用户拍板"生词本发音要跟正文朗读同一套引擎, 且要预热"——之前查词面板/生词本的发音
//! 按钮走浏览器 SpeechSynthesisUtterance(系统机械音), 跟正文朗读的离线 TTS 引擎完全
//! 是两套。这里不改正文朗读, 只给生词本发音接上同一个 Kokoro 引擎; 每次冷启动侧车+
//! 加载模型要几秒, 跟词典守护(dict_daemon.rs)遇到的问题一模一样, 直接照抄那套已经
//! 验证过的常驻守护模式(懒启动/空闲回收/超时安全读/stderr 尾部上屏), 协议对称。
//!
//! 协议 (tts_server.py): 每行 stdin 一个 JSON 请求 {"word","voice","speed"},
//!   每行 stdout 一个 JSON 响应 {"ok":true,"result":{"wav_base64":...}} 或 {"ok":false,"error":...}。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// 单次合成读响应上限: 单词/短语合成比查词略快, 但留同样的余量应对慢机/忙时
const SYNTH_TIMEOUT: Duration = Duration::from_secs(30);

static DAEMON_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct TtsDaemon {
    gen: u64,
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<String>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    model: String,
    last_used: Instant,
}

fn registry() -> &'static Mutex<Option<TtsDaemon>> {
    static REG: OnceLock<Mutex<Option<TtsDaemon>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(None))
}

/// 杀掉当前守护进程, 释放侧车占用的显存。备料任务启动前调用(任务要独占显存,
/// 跟 dict_daemon::stop() 在 jobs::spawn::spawn_prep 里的调用点是同一个理由)。
pub fn stop() {
    if let Ok(mut reg) = registry().lock() {
        if let Some(mut d) = reg.take() {
            let _ = d.child.kill();
            let _ = d.child.wait();
        }
    }
}

fn spawn(prep_path: &std::path::Path, model: &str, language: &str) -> Result<TtsDaemon, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(prep_path);
    cmd.args([
        "--tts-server",
        "--tts-model",
        model,
        "--tts-language",
        language,
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("启动语音守护失败: {e}"))?;
    let stdin = child.stdin.take().ok_or("无法取得语音守护 stdin")?;
    let stdout = child.stdout.take().ok_or("无法取得语音守护 stdout")?;
    let stderr = child.stderr.take().ok_or("无法取得语音守护 stderr")?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    {
        let buf = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut b = buf.lock().unwrap();
                        b.push_back(line.trim_end().to_string());
                        if b.len() > 8 {
                            b.pop_front();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let d = TtsDaemon {
        gen: DAEMON_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        child,
        stdin,
        rx,
        stderr_tail: stderr_tail.clone(),
        model: model.to_string(),
        last_used: Instant::now(),
    };
    match d.rx.recv_timeout(START_TIMEOUT) {
        Ok(ready) => {
            if ready.trim().is_empty() {
                let tail = stderr_tail_string(&d);
                return Err(format!("语音守护启动失败 (进程未输出就绪行){}", tail));
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(
                "语音守护启动超时 (侧车未就绪, 可稍后重试; 仍失败请在设置·组件健康检查侧车)".into(),
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let tail = stderr_tail_string(&d);
            return Err(format!("语音守护启动失败 (侧车提前退出){}", tail));
        }
    }
    let wgen = d.gen;
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_TIMEOUT);
        let mut reg = registry().lock().unwrap();
        let still_same = reg.as_ref().map(|x| x.gen == wgen).unwrap_or(false);
        let still_idle = reg
            .as_ref()
            .map(|x| x.last_used.elapsed() >= IDLE_TIMEOUT)
            .unwrap_or(false);
        if still_same && still_idle {
            if let Some(mut old) = reg.take() {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
    });
    Ok(d)
}

fn stderr_tail_string(d: &TtsDaemon) -> String {
    let lines: Vec<String> = d.stderr_tail.lock().unwrap().iter().cloned().collect();
    if lines.is_empty() {
        String::new()
    } else {
        format!(": {}", lines.join(" | "))
    }
}

/// 合成一个词/短语: 懒启动/重建守护 → 写一行请求 → 带超时读一行响应。
/// 返回 base64 编码的 WAV 数据(前端拼成 data: URL 直接播放, 不落盘也不用管理临时文件)。
pub fn synth(
    prep_path: &std::path::Path,
    model: &str,
    language: &str,
    word: &str,
    voice: &str,
    speed: f64,
) -> Result<String, String> {
    synth_with_timeout(
        prep_path,
        model,
        language,
        word,
        voice,
        speed,
        SYNTH_TIMEOUT,
    )
}

fn synth_with_timeout(
    prep_path: &std::path::Path,
    model: &str,
    language: &str,
    word: &str,
    voice: &str,
    speed: f64,
    timeout: Duration,
) -> Result<String, String> {
    let mut reg = registry()
        .lock()
        .map_err(|_| "语音守护注册表被占用".to_string())?;
    let stale = reg
        .as_ref()
        .map(|d| d.model != model || d.last_used.elapsed() > IDLE_TIMEOUT)
        .unwrap_or(true);
    if stale {
        if let Some(mut old) = reg.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        *reg = Some(spawn(prep_path, model, language)?);
    }
    let req = serde_json::json!({ "word": word, "voice": voice, "speed": speed });
    {
        let d = reg.as_mut().expect("已确保存在");
        writeln!(d.stdin, "{}", req).map_err(|e| format!("写语音守护请求失败: {e}"))?;
        d.stdin.flush().ok();
        d.last_used = Instant::now();
    }

    let line = {
        let d = reg.as_mut().expect("已确保存在");
        match d.rx.recv_timeout(timeout) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut hung = reg.take().expect("已确保存在");
                let _ = hung.child.kill();
                let _ = hung.child.wait();
                return Err("语音守护响应超时, 已重置守护进程".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = reg.take();
                return Err("语音守护进程已退出".to_string());
            }
        }
    };
    if line.trim().is_empty() {
        return Err("语音守护进程已退出".to_string());
    }
    let v: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("语音守护响应非法: {e}"))?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        v.get("result")
            .and_then(|r| r.get("wav_base64"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "语音守护响应缺少 wav_base64".to_string())
    } else {
        Err(v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("语音合成失败")
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_is_idempotent() {
        stop();
        stop();
    }

    #[test]
    fn idle_timeout_constant_is_sane() {
        assert!(
            IDLE_TIMEOUT >= Duration::from_secs(60),
            "空闲回收不能太短, 否则刚加载就回收"
        );
    }

    #[test]
    fn hung_daemon_times_out_and_is_reset() {
        // 照 dict_daemon.rs 同款单测: 假守护输出 ready 后挂起, 从不响应请求。
        let dir = std::env::temp_dir().join(format!(
            "aidulc_ttsd_fake_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\necho {\"ok\":true,\"ready\":true}\r\nping -n 30 127.0.0.1 >nul\r\n",
        )
        .unwrap();

        let t0 = Instant::now();
        let r = synth_with_timeout(
            &fake,
            "fake-model",
            "en",
            "bank",
            "af_heart",
            1.0,
            Duration::from_millis(300),
        );
        let elapsed = t0.elapsed();
        stop();

        let msg = r.expect_err("永不响应的守护必须超时失败");
        assert!(msg.contains("超时"), "应为超时文案: {msg}");
        assert!(
            elapsed < Duration::from_secs(5),
            "应在短超时内返回, 实耗 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_exiting_early_surfaces_stderr_not_timeout() {
        let dir = std::env::temp_dir().join(format!(
            "aidulc_ttsd_early_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("early_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\necho unrecognized arguments: --tts-model 1>&2\r\n",
        )
        .unwrap();

        let r = synth_with_timeout(
            &fake,
            "fake-model",
            "en",
            "bank",
            "af_heart",
            1.0,
            Duration::from_secs(5),
        );
        stop();
        let msg = r.expect_err("秒退的守护必须失败");
        assert!(
            msg.contains("启动失败") || msg.contains("提前退出"),
            "应报启动失败而非超时: {msg}"
        );
        assert!(
            !msg.contains("超时 (侧车未就绪)"),
            "不应该是误导的启动超时文案: {msg}"
        );
        assert!(
            msg.contains("unrecognized arguments"),
            "stderr 报错应上屏: {msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
