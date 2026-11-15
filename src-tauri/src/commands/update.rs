//! commands/update.rs —— D4 (2026-11-15): 「检查更新」命令
//!
//! 只在用户点按钮时联网一次, 边界见 `infrastructure/update_check.rs` 顶部说明。

use crate::infrastructure::update_check;

/// 检查应用本体有没有新版本。
/// async + spawn_blocking: 网络请求是阻塞 I/O, 同步命令跑在主线程会把窗口卡住
/// (components_health 同款教训)。
/// 返回 { current, latest (无发布时为 null), newer, url }。
#[tauri::command]
pub async fn app_check_update() -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: app_check_update");
    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = tauri::async_runtime::spawn_blocking(update_check::fetch_latest)
        .await
        .map_err(|e| format!("检查更新执行失败: {e}"))??;
    Ok(match latest {
        Some(r) => serde_json::json!({
            "current": current,
            "latest": r.tag,
            "newer": update_check::is_newer(&r.tag, &current),
            "url": r.url,
        }),
        None => serde_json::json!({
            "current": current, "latest": null, "newer": false, "url": "",
        }),
    })
}
