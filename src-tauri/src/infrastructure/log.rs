//! infra/log.rs —— 应用日志 (用户反馈排查全靠它)
//!
//! 位置: 应用数据目录 aidulc.log (日志目录由 main.rs 传入, 保持可测试)。
//! 格式: 时间戳 LEVEL [模块] 消息 (每行一条, 追加写)。
//! 用途: 前端 JS 错误 / Rust 命令失败 / 任务队列事件全部落盘。

use std::io::Write;
use std::sync::Mutex;
use std::sync::OnceLock;

static LOGGER: OnceLock<Mutex<Option<LogFile>>> = OnceLock::new();

struct LogFile {
    path: std::path::PathBuf,
    file: std::fs::File,
}

pub fn init(log_dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(log_dir).map_err(|e| format!("建日志目录失败: {e}"))?;
    let path = log_dir.join("aidulc.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("开日志文件失败: {e}"))?;
    let _ = LOGGER.set(Mutex::new(Some(LogFile { path, file })));
    info("log", "日志已初始化");
    Ok(())
}

/// 当前日志文件路径 (给前端"打开日志"用)
pub fn log_path() -> Option<String> {
    let slot = LOGGER.get()?;
    let guard = slot.lock().unwrap();
    guard.as_ref().map(|l| l.path.to_string_lossy().to_string())
}

fn write_line(level: &str, module: &str, msg: &str) {
    if let Some(m) = LOGGER.get() {
        let mut guard = m.lock().unwrap();
        if let Some(l) = guard.as_mut() {
            let ts = crate::store::now_ms_for_store();
            let line = format!("{ts} {level} [{module}] {msg}\n");
            let _ = l.file.write_all(line.as_bytes());
            let _ = l.file.flush();
        }
    }
}

pub fn info(module: &str, msg: &str) {
    write_line("INFO", module, msg);
}
pub fn warn(module: &str, msg: &str) {
    write_line("WARN", module, msg);
}
pub fn error(module: &str, msg: &str) {
    write_line("ERROR", module, msg);
}

/// 前端错误日志 (命令)
pub fn log_from_frontend(level: String, module: String, message: String) -> Result<(), String> {
    match level.as_str() {
        "error" => error(&module, &message),
        "warn" => warn(&module, &message),
        _ => info(&module, &message),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_writes_lines() {
        let dir = std::env::temp_dir().join(format!("aidulc_log_{}", std::process::id()));
        init(&dir).unwrap();
        info("test", "hello 你好");
        error("test", "boom");
        let path = log_path().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("INFO [test] hello 你好"), "got: {content}");
        assert!(content.contains("ERROR [test] boom"), "got: {content}");
        let _ = std::fs::remove_dir_all(&dir);
        // 复位单例 (避免影响其它测试)
        LOGGER.set(Mutex::new(None)).ok();
    }

    #[test]
    fn frontend_log_route() {
        log_from_frontend("error".into(), "frontend".into(), "TypeError: x".into()).unwrap();
        log_from_frontend("warn".into(), "frontend".into(), "slow".into()).unwrap();
        log_from_frontend("info".into(), "frontend".into(), "started".into()).unwrap();
    }
}
