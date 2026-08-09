//! store/sync_state_repo.rs —— sync_state 唯一写者 (V6, 2026-08-09)
//!
//! 每 user 一行: last_push_at (上次成功推送的时间, 用于算 N 条待推) +
//! last_pull_rev (上次拉取的 rev, 用于增量 `?since=`)。离线时本地照常写,
//! 恢复网络后按 last_push_at 找待推词条、按 last_pull_rev 增量拉取。

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncState {
    pub user_id: String,
    pub last_push_at: i64,
    pub last_pull_rev: i64,
    pub updated_at: i64,
}

pub struct SyncStateRepo<'a> {
    db: &'a Db,
}

impl<'a> SyncStateRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn get(&self, user_id: &str) -> Option<SyncState> {
        let conn = self.db.conn.lock().unwrap();
        let s = conn
            .query_row(
                "SELECT user_id, last_push_at, last_pull_rev, updated_at FROM sync_state WHERE user_id = ?1",
                [user_id],
                |r| {
                    Ok(SyncState {
                        user_id: r.get(0)?,
                        last_push_at: r.get(1)?,
                        last_pull_rev: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                },
            )
            .ok();
        drop(conn);
        s
    }

    pub fn upsert(&self, s: &SyncState) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_state (user_id, last_push_at, last_pull_rev, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id) DO UPDATE SET
                last_push_at = excluded.last_push_at,
                last_pull_rev = excluded.last_pull_rev,
                updated_at = excluded.updated_at",
            params![s.user_id, s.last_push_at, s.last_pull_rev, s.updated_at],
        )
        .map_err(|e| format!("写 sync_state 失败: {e}"))?;
        drop(conn);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_syncst_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn get_missing_returns_none() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        assert!(repo.get("nobody").is_none());
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        let s = SyncState {
            user_id: "me".into(),
            last_push_at: 100,
            last_pull_rev: 5,
            updated_at: 100,
        };
        repo.upsert(&s).unwrap();
        let got = repo.get("me").unwrap();
        assert_eq!(got, s);
        // 更新覆盖
        let mut s2 = s.clone();
        s2.last_push_at = 200;
        s2.last_pull_rev = 9;
        repo.upsert(&s2).unwrap();
        assert_eq!(repo.get("me").unwrap().last_push_at, 200);
        assert_eq!(repo.get("me").unwrap().last_pull_rev, 9);
    }

    #[test]
    fn isolated_by_user() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        repo.upsert(&SyncState {
            user_id: "me".into(),
            last_push_at: 1,
            last_pull_rev: 1,
            updated_at: 1,
        })
        .unwrap();
        repo.upsert(&SyncState {
            user_id: "u-kid".into(),
            last_push_at: 2,
            last_pull_rev: 2,
            updated_at: 2,
        })
        .unwrap();
        assert_eq!(repo.get("me").unwrap().last_push_at, 1);
        assert_eq!(repo.get("u-kid").unwrap().last_push_at, 2);
    }
}
