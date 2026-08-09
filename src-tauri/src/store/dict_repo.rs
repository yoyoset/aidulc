//! store/dict_repo.rs —— 个人词典唯一写者
//! V1 (2026-08-09): 加 user 维度, key = {user}:{profile}:{lemma} (同 vocab_repo)。

use crate::store::Db;
use rusqlite::params;

pub struct DictRepo<'a> {
    db: &'a Db,
}

impl<'a> DictRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(
        &self,
        key: &str,
        payload: &serde_json::Value,
        user_id: &str,
        profile_id: &str,
    ) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        let word = payload
            .get("word")
            .and_then(|w| w.as_str())
            .unwrap_or(key)
            .to_string();
        let lemma = payload
            .get("lemma")
            .and_then(|w| w.as_str())
            .unwrap_or(key)
            .to_lowercase();
        let full_key = format!("{}:{}:{}", user_id, profile_id, key.to_lowercase());
        conn.execute(
            "INSERT INTO dictionary (key, word, lemma, pos, payload, profile_id, user_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(key) DO UPDATE SET
                word = excluded.word, lemma = excluded.lemma, pos = excluded.pos,
                payload = excluded.payload",
            params![
                full_key,
                word,
                lemma,
                payload.get("pos").and_then(|p| p.as_str()).unwrap_or(""),
                serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string()),
                profile_id,
                user_id
            ],
        )
        .map_err(|e| format!("写词典失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, key: &str, user_id: &str, profile_id: &str) -> Option<serde_json::Value> {
        let full_key = format!("{}:{}:{}", user_id, profile_id, key.to_lowercase());
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT payload FROM dictionary WHERE key = ?1",
            [&full_key],
            |r| {
                let s: String = r.get(0)?;
                Ok(serde_json::from_str(&s).unwrap_or(serde_json::Value::Null))
            },
        )
        .ok()
    }

    /// I-A: 某 user 某 profile 全部词典条目 (生词本/词典浏览用)
    pub fn list_by_profile(
        &self,
        user_id: &str,
        profile_id: &str,
    ) -> Vec<(String, serde_json::Value)> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT lemma, payload FROM dictionary WHERE user_id = ?1 AND profile_id = ?2 ORDER BY lemma")
            .unwrap();
        stmt.query_map(params![user_id, profile_id], |r| {
            let lemma: String = r.get(0)?;
            let payload: String = r.get(1)?;
            Ok((
                lemma,
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// I-A: 按词搜索 (前缀/包含)
    pub fn search(
        &self,
        user_id: &str,
        profile_id: &str,
        q: &str,
    ) -> Vec<(String, serde_json::Value)> {
        let conn = self.db.conn.lock().unwrap();
        let like = format!("%{}%", q.to_lowercase());
        let mut stmt = conn
            .prepare("SELECT lemma, payload FROM dictionary WHERE user_id = ?1 AND profile_id = ?2 AND lemma LIKE ?3 ORDER BY lemma")
            .unwrap();
        stmt.query_map(params![user_id, profile_id, like], |r| {
            let lemma: String = r.get(0)?;
            let payload: String = r.get(1)?;
            Ok((
                lemma,
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            ))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// I-A: 删除条目
    pub fn remove(&self, key: &str, user_id: &str, profile_id: &str) -> Result<(), String> {
        let full_key = format!("{}:{}:{}", user_id, profile_id, key.to_lowercase());
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM dictionary WHERE key = ?1", [&full_key])
            .map_err(|e| format!("删词典条目失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_dc_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = DictRepo::new(&db);
        let payload =
            serde_json::json!({"word": "Bank", "pos": "NOUN", "meanings": ["银行", "河岸"]});
        repo.upsert("bank", &payload, "me", "default").unwrap();
        let got = repo.get("bank", "me", "default").unwrap();
        assert_eq!(got["word"], "Bank");
        assert_eq!(got["meanings"][0], "银行");
    }

    #[test]
    fn list_and_search_by_profile() {
        let db = temp_db();
        let repo = DictRepo::new(&db);
        repo.upsert(
            "bank",
            &serde_json::json!({"word": "bank"}),
            "me",
            "default",
        )
        .unwrap();
        repo.upsert(
            "break",
            &serde_json::json!({"word": "break"}),
            "me",
            "default",
        )
        .unwrap();
        repo.upsert("bank", &serde_json::json!({"word": "bank"}), "me", "kid")
            .unwrap();
        assert_eq!(repo.list_by_profile("me", "default").len(), 2);
        assert_eq!(repo.list_by_profile("me", "kid").len(), 1, "profile 隔离");
        let hits = repo.search("me", "default", "ba");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "bank");
    }

    #[test]
    fn user_isolation_same_profile() {
        // V1 (2026-08-09): 同 profile 不同 user 的词典条目互不覆盖
        let db = temp_db();
        let repo = DictRepo::new(&db);
        repo.upsert(
            "bank",
            &serde_json::json!({"word": "bank", "meaning": "我的"}),
            "me",
            "default",
        )
        .unwrap();
        repo.upsert(
            "bank",
            &serde_json::json!({"word": "bank", "meaning": "孩子的"}),
            "u-kid",
            "default",
        )
        .unwrap();
        assert_eq!(
            repo.get("bank", "me", "default").unwrap()["meaning"],
            "我的"
        );
        assert_eq!(
            repo.get("bank", "u-kid", "default").unwrap()["meaning"],
            "孩子的"
        );
        assert_eq!(repo.list_by_profile("me", "default").len(), 1);
        assert_eq!(repo.list_by_profile("u-kid", "default").len(), 1);
    }

    #[test]
    fn remove_entry() {
        let db = temp_db();
        let repo = DictRepo::new(&db);
        repo.upsert(
            "bank",
            &serde_json::json!({"word": "bank"}),
            "me",
            "default",
        )
        .unwrap();
        repo.remove("bank", "me", "default").unwrap();
        assert!(repo.get("bank", "me", "default").is_none());
    }
}
