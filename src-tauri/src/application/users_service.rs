//! application/users_service.rs —— 删除空用户 (身份模型 V1, 2026-08-14)
//!
//! 只允许删除"空用户": 该 user_id 在 7 张数据表里都没有任何行才允许删;
//! 且至少保留一个用户 (不能删到 0 个)。users 表本身的唯一写者仍是 users_repo,
//! 这里只做跨表只读校验 (COUNT), 命中哪张表就用人话报哪张。

use crate::store::{users_repo::UsersRepo, Db};

/// 7 张需要"名下无数据"校验的表: (表名, 人话表名)。人话表名用于错误信息,
/// 不把英文表名暴露给用户。
const DATA_TABLES: [(&str, &str); 7] = [
    ("vocab", "生词"),
    ("dictionary", "词典"),
    ("highlights", "摘录"),
    ("reading_state", "阅读进度"),
    ("reading_daily", "阅读时长"),
    ("reader_settings", "阅读器设置"),
    ("sync_state", "同步状态"),
];

/// 删除空用户: 最后剩下的一个用户不能删; 名下任一数据表有行也不能删。
/// 全部为空才真正执行 UsersRepo::delete。
pub fn delete_if_empty(db: &Db, id: &str) -> Result<(), String> {
    let users = UsersRepo::new(db).list();
    if users.len() <= 1 {
        return Err("至少保留一个用户, 不能删除最后一个".into());
    }

    let conn = db.conn.lock().unwrap();
    for (table, label) in DATA_TABLES {
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE user_id = ?1"),
                [id],
                |r| r.get(0),
            )
            .map_err(|e| format!("查 {label} 行数失败: {e}"))?;
        if count > 0 {
            return Err(format!("该用户名下还有数据(在 {label} 表), 不能删除"));
        }
    }
    drop(conn);

    UsersRepo::new(db).delete(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::vocab::VocabEntry;
    use crate::store::users_repo::User;
    use crate::store::vocab_repo::VocabRepo;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_db() -> Db {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("aidulc_usvc_test_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    /// 造第二个用户 (迁移只 seed 默认用户 me, 测试需先造一个才能删)。
    fn add_user(db: &Db, id: &str, name: &str) {
        let now = crate::store::now_ms_for_store();
        UsersRepo::new(db)
            .upsert(&User {
                id: id.into(),
                name: name.into(),
                created_at: now,
                updated_at: now,
            })
            .unwrap();
    }

    fn seed_vocab(db: &Db, user_id: &str) {
        let now = crate::store::now_ms_for_store();
        let e = VocabEntry {
            word: "test".into(),
            lemma: "test".into(),
            pos: "NOUN".into(),
            meaning: "测试".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: serde_json::Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: now,
            updated_at: now,
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        };
        VocabRepo::new(db)
            .upsert_content(e, user_id, "default")
            .unwrap();
    }

    #[test]
    fn empty_user_can_be_deleted() {
        let db = temp_db();
        add_user(&db, "u-tmp", "临时");
        delete_if_empty(&db, "u-tmp").unwrap();
        let ids: Vec<String> = UsersRepo::new(&db)
            .list()
            .iter()
            .map(|u| u.id.clone())
            .collect();
        assert!(
            !ids.contains(&"u-tmp".to_string()),
            "空用户应被删掉: {ids:?}"
        );
    }

    #[test]
    fn user_with_vocab_rejected() {
        let db = temp_db();
        add_user(&db, "u-kid", "孩子");
        seed_vocab(&db, "u-kid");
        let err = delete_if_empty(&db, "u-kid").unwrap_err();
        assert!(
            err.contains("生词"),
            "错误信息应说明是因为生词数据, 实得: {err}"
        );
        // 被拒绝后用户应还在
        let ids: Vec<String> = UsersRepo::new(&db)
            .list()
            .iter()
            .map(|u| u.id.clone())
            .collect();
        assert!(ids.contains(&"u-kid".to_string()));
    }

    #[test]
    fn cannot_delete_last_user_even_if_empty() {
        let db = temp_db();
        // 迁移 seed 的默认用户是唯一一个 → 哪怕名下无数据也不能删
        let err = delete_if_empty(&db, "me").unwrap_err();
        assert!(
            err.contains("不能删除最后一个"),
            "应拦下最后一个用户的删除, 实得: {err}"
        );
    }
}
