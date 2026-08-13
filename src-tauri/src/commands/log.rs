//! commands/log.rs —— 前端日志命令 (用户反馈排查)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 commands/reader.rs 拆出。

/// 前端错误/警告落盘 (全局 error/unhandledrejection 捕获)
#[tauri::command]
pub fn log_from_frontend(level: String, module: String, message: String) -> Result<(), String> {
    crate::infrastructure::log::log_from_frontend(level, module, message)
}

/// 当前日志文件路径 (设置页"打开日志")
#[tauri::command]
pub fn log_path() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "path": crate::infrastructure::log::log_path() }))
}
