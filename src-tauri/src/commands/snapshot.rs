//! commands/snapshot.rs —— S2 (2026-11-15): 数据库快照的列出与恢复
//!
//! 快照由 `infrastructure/snapshot.rs` 每天建一份 (放在默认数据目录, 不在数据根里)。
//! 这里只暴露两个命令; 恢复是"暂存 + 下次启动开库前替换", 见该文件的 S2 说明。

use crate::infrastructure::snapshot;

/// 列出可恢复的快照 (最新在前)。
#[tauri::command]
pub fn snapshot_list() -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: snapshot_list");
    let dir = crate::services::config::user_data_dir();
    let items: Vec<serde_json::Value> = snapshot::list_snapshots(&dir)
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "date": s.date,
                "size": s.size,
                "vocab_count": s.vocab_count,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "snapshots": items,
        // 已经暂存、等重启生效的恢复 (前端据此提示"重启后生效")
        "pending": snapshot::pending_restore_path(&dir).is_file(),
    }))
}

/// 暂存一次恢复, 重启后生效。不会动当前数据库。
#[tauri::command]
pub fn snapshot_restore(date: String) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: snapshot_restore {date}"));
    let dir = crate::services::config::user_data_dir();
    snapshot::stage_restore(&dir, &date)?;
    Ok(serde_json::json!({ "staged": true, "date": date, "needs_restart": true }))
}
