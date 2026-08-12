//! application/wizard_service.rs —— 首次运行向导状态机 (H3)
//!
//! 6 步: 1语言 → 2数据目录 → 3硬件 → 4模型发现 → 5依赖清单 → 6完成
//! 状态落 wizard_state 表, 每步可跳过, 重启续走。

use crate::store::Db;

pub const TOTAL_STEPS: i64 = 6;

pub fn get_state(db: &Db) -> (i64, String) {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT step, status FROM wizard_state WHERE id = 'first-run'",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )
    .unwrap_or((0, "not_started".into()))
}

pub fn set_step(db: &Db, step: i64, status: &str) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO wizard_state (id, step, status, updated_at)
         VALUES ('first-run', ?1, ?2, strftime('%s','now')*1000)
         ON CONFLICT(id) DO UPDATE SET step = excluded.step, status = excluded.status,
            updated_at = excluded.updated_at",
        rusqlite::params![step, status],
    )
    .map_err(|e| format!("写向导状态失败: {e}"))?;
    Ok(())
}

/// N1 (2026-08-12): 重置向导状态 → 回到第一步, 供"重新运行首次向导"入口用。
/// 走完的向导用户换机器/换数据目录时需要能再进一次。
pub fn reset(db: &Db) -> Result<(), String> {
    set_step(db, 0, "pending")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_wiz_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn initial_state() {
        let db = temp_db();
        let (step, status) = get_state(&db);
        assert_eq!(step, 0);
        assert_eq!(status, "not_started");
    }

    #[test]
    fn step_advance_and_done() {
        let db = temp_db();
        set_step(&db, 3, "in_progress").unwrap();
        assert_eq!(get_state(&db).0, 3);
        set_step(&db, 6, "done").unwrap();
        assert_eq!(get_state(&db).1, "done");
    }

    #[test]
    fn overwrite_state() {
        let db = temp_db();
        set_step(&db, 2, "in_progress").unwrap();
        set_step(&db, 4, "in_progress").unwrap();
        assert_eq!(get_state(&db).0, 4);
    }
}
