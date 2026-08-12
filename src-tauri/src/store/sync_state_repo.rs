//! store/sync_state_repo.rs —— sync_state 唯一写者 (V6, 2026-08-09; M3 复合主键 2026-08-13)
//!
//! 每 (user, endpoint) 一行: last_push_at (上次成功推送的时间, 用于算 N 条待推) +
//! last_pull_rev (上次拉取的 rev, 用于增量 `?since=`)。离线时本地照常写,
//! 恢复网络后按 last_push_at 找待推词条、按 last_pull_rev 增量拉取。
//! endpoint_key (UX A1, 2026-08-11): 这份进度属于哪个服务端
//! (worker_url + auth_device 返回的服务端 user_id)。换 URL / 换 token 后不匹配或为空
//! → 视为从未同步、全量重推 (宁可多推, 不可少推)。
//! UX5 #3 (M3, 2026-08-13): 主键从 user_id 改为复合 (user_id, endpoint_key) ——
//! 一个主体可同时启用多个后端, 每格独立进度; enabled 列标记该格是否参与"立即同步"。

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncState {
    pub user_id: String,
    /// 该行同步进度所属的服务端 (worker_url|server_user_id); 空 = 从未同步过
    pub endpoint_key: String,
    pub last_push_at: i64,
    pub last_pull_rev: i64,
    /// M3: 该 (user, endpoint) 是否参与「立即同步」(0/1)
    pub enabled: bool,
    pub updated_at: i64,
}

pub struct SyncStateRepo<'a> {
    db: &'a Db,
}

impl<'a> SyncStateRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn get(&self, user_id: &str, endpoint_key: &str) -> Option<SyncState> {
        let conn = self.db.conn.lock().unwrap();
        let s = conn
            .query_row(
                "SELECT user_id, endpoint_key, last_push_at, last_pull_rev, enabled, updated_at
                 FROM sync_state WHERE user_id = ?1 AND endpoint_key = ?2",
                params![user_id, endpoint_key],
                |r| {
                    Ok(SyncState {
                        user_id: r.get(0)?,
                        endpoint_key: r.get(1)?,
                        last_push_at: r.get(2)?,
                        last_pull_rev: r.get(3)?,
                        enabled: r.get::<_, i64>(4)? != 0,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .ok();
        drop(conn);
        s
    }

    /// 该 user 的全部 (user, endpoint) 行 (M3: 后端勾选状态 / 多后端进度)。
    /// 目前仅测试引用; 保留供前端"按后端看进度"扩展。
    #[allow(dead_code)]
    pub fn get_for_user(&self, user_id: &str) -> Vec<SyncState> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT user_id, endpoint_key, last_push_at, last_pull_rev, enabled, updated_at
                 FROM sync_state WHERE user_id = ?1 ORDER BY endpoint_key",
            )
            .unwrap();
        let rows = stmt
            .query_map([user_id], |r| {
                Ok(SyncState {
                    user_id: r.get(0)?,
                    endpoint_key: r.get(1)?,
                    last_push_at: r.get(2)?,
                    last_pull_rev: r.get(3)?,
                    enabled: r.get::<_, i64>(4)? != 0,
                    updated_at: r.get(5)?,
                })
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        rows
    }

    /// M3: 只读该 (user, endpoint) 的 enabled 标记。返回 (有行, enabled)。
    pub fn enabled_flag(&self, user_id: &str, endpoint_key: &str) -> (bool, bool) {
        let conn = self.db.conn.lock().unwrap();
        let row: Option<(i64,)> = conn
            .query_row(
                "SELECT enabled FROM sync_state WHERE user_id = ?1 AND endpoint_key = ?2",
                params![user_id, endpoint_key],
                |r| Ok((r.get(0)?,)),
            )
            .ok();
        drop(conn);
        match row {
            Some((en,)) => (true, en != 0),
            None => (false, false),
        }
    }

    /// M3: 勾选/取消「同步此后端」。
    pub fn set_enabled(
        &self,
        user_id: &str,
        endpoint_key: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_state (user_id, endpoint_key, last_push_at, last_pull_rev, enabled, updated_at)
             VALUES (?1, ?2, 0, 0, ?3, ?4)
             ON CONFLICT(user_id, endpoint_key) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![user_id, endpoint_key, enabled as i64, crate::store::now_ms_for_store()],
        )
        .map_err(|e| format!("写同步启用状态失败: {e}"))?;
        drop(conn);
        Ok(())
    }

    pub fn upsert(&self, s: &SyncState) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_state (user_id, endpoint_key, last_push_at, last_pull_rev, enabled, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id, endpoint_key) DO UPDATE SET
                last_push_at = excluded.last_push_at,
                last_pull_rev = excluded.last_pull_rev,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                s.user_id,
                s.endpoint_key,
                s.last_push_at,
                s.last_pull_rev,
                s.enabled as i64,
                s.updated_at
            ],
        )
        .map_err(|e| format!("写 sync_state 失败: {e}"))?;
        drop(conn);
        Ok(())
    }

    /// 删除某 user 的全部同步行 (F4 强制全量重推 / 断开同步用)。
    pub fn delete_for_user(&self, user_id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM sync_state WHERE user_id = ?1", [user_id])
            .map_err(|e| format!("清同步状态失败: {e}"))?;
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

    fn state(user: &str, ep: &str, push: i64, rev: i64, enabled: bool) -> SyncState {
        SyncState {
            user_id: user.into(),
            endpoint_key: ep.into(),
            last_push_at: push,
            last_pull_rev: rev,
            enabled,
            updated_at: push,
        }
    }

    #[test]
    fn get_missing_returns_none() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        assert!(repo.get("nobody", "https://a.workers.dev|me").is_none());
    }

    #[test]
    fn upsert_get_roundtrip_per_endpoint() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        // M3: 同 user 两个后端各自独立进度
        repo.upsert(&state("me", "https://a.workers.dev|me", 100, 5, true))
            .unwrap();
        repo.upsert(&state("me", "https://b.workers.dev|me", 200, 9, false))
            .unwrap();
        assert_eq!(
            repo.get("me", "https://a.workers.dev|me")
                .unwrap()
                .last_push_at,
            100
        );
        assert_eq!(
            repo.get("me", "https://b.workers.dev|me")
                .unwrap()
                .last_push_at,
            200
        );
        assert_eq!(
            repo.get("me", "https://a.workers.dev|me").unwrap().enabled,
            true
        );
        assert_eq!(
            repo.get("me", "https://b.workers.dev|me").unwrap().enabled,
            false
        );
        // 覆盖更新
        let mut s2 = state("me", "https://a.workers.dev|me", 300, 12, true);
        repo.upsert(&s2).unwrap();
        assert_eq!(
            repo.get("me", "https://a.workers.dev|me")
                .unwrap()
                .last_push_at,
            300
        );
        // get_for_user 返回全部
        assert_eq!(repo.get_for_user("me").len(), 2);
        s2.last_push_at = 301;
        assert_eq!(repo.get_for_user("me")[0].last_push_at, 300);
    }

    #[test]
    fn enabled_flag_and_set() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        assert_eq!(
            repo.enabled_flag("me", "https://a.workers.dev|me"),
            (false, false)
        );
        repo.set_enabled("me", "https://a.workers.dev|me", true)
            .unwrap();
        assert_eq!(
            repo.enabled_flag("me", "https://a.workers.dev|me"),
            (true, true)
        );
        repo.set_enabled("me", "https://a.workers.dev|me", false)
            .unwrap();
        assert_eq!(
            repo.enabled_flag("me", "https://a.workers.dev|me"),
            (true, false)
        );
        // 独立于其它 user
        assert_eq!(
            repo.enabled_flag("u-kid", "https://a.workers.dev|me"),
            (false, false)
        );
    }

    #[test]
    fn isolated_by_user() {
        let db = temp_db();
        let repo = SyncStateRepo::new(&db);
        repo.upsert(&state("me", "https://a.workers.dev|me", 1, 1, true))
            .unwrap();
        repo.upsert(&state("u-kid", "https://a.workers.dev|kid", 2, 2, true))
            .unwrap();
        assert_eq!(
            repo.get("me", "https://a.workers.dev|me")
                .unwrap()
                .last_push_at,
            1
        );
        assert_eq!(
            repo.get("u-kid", "https://a.workers.dev|kid")
                .unwrap()
                .last_push_at,
            2
        );
        // 同 endpoint_key 不同 user 互不影响
        repo.upsert(&state("u-kid", "https://a.workers.dev|me", 9, 9, false))
            .unwrap();
        assert_eq!(
            repo.get("me", "https://a.workers.dev|me")
                .unwrap()
                .last_push_at,
            1
        );
        assert_eq!(repo.get_for_user("me").len(), 1);
    }
}
