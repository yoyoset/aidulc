//! store/users_repo.rs —— users 唯一写者 (身份模型 V1, 2026-08-09)
//!
//! user = "谁", profile = "用什么讲解策略" —— 两套表互不替代 (设计裁决冲突 4)。
//! V1 迁移把所有现有数据归到一个 user "me" (三项已定 ③: 迁移不拆人, 不许猜
//! kid profile 的词属于孩子)。本 repo 只管 users 表本身; 数据表的 user_id 列由
//! 各自 repo 读写 (vocab_repo/dict_repo/reading_repo/highlights_repo)。

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// 默认 user id (迁移回填 + 未配置时的兜底)。将来服务端签发真实 user_id 后,
/// 本地默认用户会绑定到服务端签发值 (V5/V6), 但本地表内 id 保持稳定。
pub const DEFAULT_USER_ID: &str = "me";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct UsersRepo<'a> {
    db: &'a Db,
}

impl<'a> UsersRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Vec<User> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, updated_at FROM users ORDER BY created_at")
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok(User {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        rows
    }

    // get: 仅测试用 (S4 起 upsert 已由 users_create 命令接线; get 仍无调用方)
    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<User> {
        let conn = self.db.conn.lock().unwrap();
        let u = conn
            .query_row(
                "SELECT id, name, created_at, updated_at FROM users WHERE id = ?1",
                [id],
                |r| {
                    Ok(User {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                },
            )
            .ok();
        drop(conn);
        u
    }

    // S4 (2026-08-10): 新建成员接线 (users_create 命令)。保留 as 内部方法, 不新增 repo。
    pub fn upsert(&self, u: &User) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, updated_at = excluded.updated_at",
            params![u.id, u.name, u.created_at, u.updated_at],
        )
        .map_err(|e| format!("写 users 失败: {e}"))?;
        drop(conn);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_usr_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn default_user_seeded_by_migration() {
        let db = temp_db();
        let repo = UsersRepo::new(&db);
        let users = repo.list();
        assert!(
            users.iter().any(|u| u.id == DEFAULT_USER_ID),
            "迁移 v20 应 seed 默认用户 me, 实得: {:?}",
            users.iter().map(|u| u.id.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn create_and_list_second_user() {
        let db = temp_db();
        let repo = UsersRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        repo.upsert(&User {
            id: "u-kid".into(),
            name: "孩子".into(),
            created_at: now,
            updated_at: now,
        })
        .unwrap();
        let ids: Vec<String> = repo.list().iter().map(|u| u.id.clone()).collect();
        assert!(ids.contains(&"u-kid".to_string()));
        assert!(ids.contains(&DEFAULT_USER_ID.to_string()));
        let kid = repo.get("u-kid").unwrap();
        assert_eq!(kid.name, "孩子");
    }

    #[test]
    fn rename_updates_name_only() {
        let db = temp_db();
        let repo = UsersRepo::new(&db);
        let me = repo.get(DEFAULT_USER_ID).unwrap();
        let mut renamed = me.clone();
        renamed.name = "爸爸".into();
        renamed.updated_at = crate::store::now_ms_for_store();
        repo.upsert(&renamed).unwrap();
        let got = repo.get(DEFAULT_USER_ID).unwrap();
        assert_eq!(got.name, "爸爸");
        assert_eq!(got.created_at, me.created_at, "created_at 不应被改名动");
    }
}
