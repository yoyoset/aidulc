//! store/vocab_repo.rs —— 生词唯一写者 (3.4 所有权表)
//!
//! M1: AIDU 无损兼容。存储以 canonical JSON payload 为准 (表内 payload 列),
//! 保留 deepData/lastReview/lastGrade/浮点 interval 等全部 AIDU 字段。
//! 查询/更新通过 payload, 不再依赖散列列。
//!
//! 写路径语义 (与 aidu vocabService 对齐):
//! - content upsert: 保留旧 SRS (stage/interval/easeFactor/nextReview/reviews/lastReview/lastGrade)
//! - sync import: 允许远端较新 updatedAt 覆盖本地 (包括 SRS)
//! - 只有 SRS owner 能改 SRS 字段 (aidulc v1 不做复习, 保留给 aidu 扩展)

use crate::domain::vocab::{normalize_vocab_entry, VocabEntry};
use crate::store::Db;
use rusqlite::params;

pub struct VocabRepo<'a> {
    db: &'a Db,
}

/// SRS 字段 (content upsert 时保留旧值)
const SRS_FIELDS: [&str; 7] = [
    "stage",
    "interval",
    "easeFactor",
    "nextReview",
    "reviews",
    "lastReview",
    "lastGrade",
];

impl<'a> VocabRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    /// V1 (2026-08-09): key = {user}:{profile}:{lemma}。user 维度加入后, 同 profile
    /// 不同用户的词不再撞主键 (迁移 v20 已把存量 key 重写成 me:profile:lemma)。
    fn full_key(user_id: &str, profile_id: &str, lemma: &str) -> String {
        format!("{}:{}:{}", user_id, profile_id, lemma.to_lowercase())
    }

    /// content upsert: 保留旧 SRS (M1 语义, 与 aidu vocabService.updateEntry 对齐)
    pub fn upsert_content(
        &self,
        e: VocabEntry,
        user_id: &str,
        profile_id: &str,
    ) -> Result<Option<VocabEntry>, String> {
        let Some(norm) = normalize_vocab_entry(e) else {
            return Err("条目缺 word 和 lemma".into());
        };
        let key = Self::full_key(user_id, profile_id, &norm.lemma);
        let now = crate::store::now_ms_for_store();
        let conn = self.db.conn.lock().unwrap();

        // 读旧 payload (保留 SRS)
        let old_payload: Option<String> = conn
            .query_row("SELECT payload FROM vocab WHERE key = ?1", [&key], |r| {
                r.get(0)
            })
            .ok();
        let mut payload = serde_json::to_value(&norm).unwrap_or(serde_json::Value::Null);
        if let Some(old) = old_payload {
            if let Ok(old_v) = serde_json::from_str::<serde_json::Value>(&old) {
                for f in SRS_FIELDS {
                    if let Some(v) = old_v.get(f) {
                        payload[f] = v.clone();
                    }
                }
                // 保留旧 addedAt
                if let Some(v) = old_v.get("addedAt") {
                    payload["addedAt"] = v.clone();
                }
            }
        }
        payload["updatedAt"] = serde_json::json!(now);

        conn.execute(
            "INSERT INTO vocab (key, word, lemma, pos, meaning, sense_id, phonetic, context, level,
                                collocations, stage, interval_days, ease_factor, next_review, reviews,
                                added_at, updated_at, profile_id, user_id, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(key) DO UPDATE SET
                word = excluded.word, pos = excluded.pos, meaning = excluded.meaning,
                sense_id = excluded.sense_id, phonetic = excluded.phonetic, context = excluded.context,
                level = excluded.level, collocations = excluded.collocations,
                lemma = excluded.lemma, payload = excluded.payload,
                -- SRS 状态保留旧值: 内容更新不重置复习进度 (aidu 语义)
                stage = vocab.stage, interval_days = vocab.interval_days, ease_factor = vocab.ease_factor,
                next_review = vocab.next_review, reviews = vocab.reviews,
                added_at = vocab.added_at, updated_at = excluded.updated_at",
            params![
                key,
                payload["word"].as_str().unwrap_or(""),
                payload["lemma"].as_str().unwrap_or(""),
                payload["pos"].as_str().unwrap_or(""),
                payload["meaning"].as_str().unwrap_or(""),
                payload.get("senseId").and_then(|v| v.as_str()),
                payload["phonetic"].as_str().unwrap_or(""),
                payload["context"].as_str().unwrap_or(""),
                payload["level"].as_str().unwrap_or(""),
                serde_json::to_string(payload.get("collocations").unwrap_or(&serde_json::json!([]))).unwrap_or_else(|_| "[]".to_string()),
                payload["stage"].as_str().unwrap_or("new"),
                payload["interval"].as_f64().unwrap_or(0.0) as i64,
                payload["easeFactor"].as_f64().unwrap_or(2.5),
                payload.get("nextReview").and_then(|v| v.as_i64()),
                payload["reviews"].as_i64().unwrap_or(0),
                payload["addedAt"].as_i64().unwrap_or(now),
                now,
                profile_id,
                user_id,
                serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
            ],
        )
        .map_err(|e| format!("写入 vocab 失败: {e}"))?;
        drop(conn);
        Ok(self.get(user_id, profile_id, &norm.lemma))
    }

    /// sync import: 允许远端较新记录覆盖本地 (M1)
    pub fn upsert_sync(
        &self,
        e: VocabEntry,
        user_id: &str,
        profile_id: &str,
    ) -> Result<Option<VocabEntry>, String> {
        let Some(norm) = normalize_vocab_entry(e) else {
            return Err("条目缺 word 和 lemma".into());
        };
        let key = Self::full_key(user_id, profile_id, &norm.lemma);
        let now = crate::store::now_ms_for_store();
        let payload = serde_json::to_value(&norm).unwrap_or(serde_json::Value::Null);
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO vocab (key, word, lemma, pos, meaning, sense_id, phonetic, context, level,
                                collocations, stage, interval_days, ease_factor, next_review, reviews,
                                added_at, updated_at, profile_id, user_id, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(key) DO UPDATE SET
                word = excluded.word, lemma = excluded.lemma, pos = excluded.pos,
                meaning = excluded.meaning, sense_id = excluded.sense_id,
                phonetic = excluded.phonetic, context = excluded.context, level = excluded.level,
                collocations = excluded.collocations, stage = excluded.stage,
                interval_days = excluded.interval_days, ease_factor = excluded.ease_factor,
                next_review = excluded.next_review, reviews = excluded.reviews,
                updated_at = excluded.updated_at, payload = excluded.payload",
            params![
                key,
                norm.word, norm.lemma, norm.pos, norm.meaning, norm.sense_id,
                norm.phonetic, norm.context, norm.level,
                serde_json::to_string(&norm.collocations).unwrap_or_else(|_| "[]".to_string()),
                norm.stage, norm.interval, norm.ease_factor, norm.next_review, norm.reviews,
                norm.added_at, now, profile_id, user_id,
                serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
            ],
        )
        .map_err(|e| format!("写入 vocab 失败: {e}"))?;
        drop(conn);
        Ok(self.get(user_id, profile_id, &norm.lemma))
    }

    /// 读 canonical payload (无损)
    pub fn get(&self, user_id: &str, profile_id: &str, lemma: &str) -> Option<VocabEntry> {
        let key = Self::full_key(user_id, profile_id, lemma);
        let conn = self.db.conn.lock().unwrap();
        let payload: Option<String> = conn
            .query_row("SELECT payload FROM vocab WHERE key = ?1", [&key], |r| {
                r.get(0)
            })
            .ok();
        drop(conn);
        payload.and_then(|p| serde_json::from_str::<VocabEntry>(&p).ok())
    }

    pub fn list(&self, user_id: &str, profile_id: &str) -> Vec<VocabEntry> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT payload FROM vocab WHERE user_id = ?1 AND profile_id = ?2 ORDER BY added_at DESC")
            .unwrap();
        let payloads: Vec<String> = stmt
            .query_map(params![user_id, profile_id], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        payloads
            .iter()
            .filter_map(|p| serde_json::from_str::<VocabEntry>(p).ok())
            .collect()
    }

    /// 列出本 user 的全部 canonical JSON 值 (sync 用)
    /// I-B: 生词搜索 (按词/释义)
    pub fn search(&self, user_id: &str, profile_id: &str, q: &str) -> Vec<VocabEntry> {
        self.list(user_id, profile_id)
            .into_iter()
            .filter(|e| {
                let query = q.to_lowercase();
                e.word.to_lowercase().contains(&query)
                    || e.lemma.to_lowercase().contains(&query)
                    || e.meaning.to_lowercase().contains(&query)
            })
            .collect()
    }

    /// I-B: 删除生词 (仅本 user)
    pub fn remove(&self, user_id: &str, profile_id: &str, lemma: &str) -> Result<(), String> {
        let key = Self::full_key(user_id, profile_id, lemma);
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM vocab WHERE key = ?1", [&key])
            .map_err(|e| format!("删生词失败: {e}"))?;
        Ok(())
    }

    /// I-B: 统计
    pub fn stats(&self, user_id: &str, profile_id: &str) -> serde_json::Value {
        let all = self.list(user_id, profile_id);
        let by_stage = {
            let mut m = std::collections::HashMap::new();
            for e in &all {
                *m.entry(e.stage.clone()).or_insert(0usize) += 1;
            }
            m
        };
        serde_json::json!({
            "total": all.len(),
            "by_stage": by_stage,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::users_repo::DEFAULT_USER_ID;
    use serde_json::Value;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_v3_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn entry(word: &str) -> VocabEntry {
        VocabEntry {
            word: word.into(),
            lemma: word.to_lowercase(),
            pos: "NOUN".into(),
            meaning: "含义".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: 1700000000000,
            updated_at: 1700000000000,
        }
    }

    #[test]
    fn profile_isolation_default_vs_kid() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let uid = DEFAULT_USER_ID;
        repo.upsert_content(entry("bank"), uid, "default").unwrap();
        repo.upsert_content(entry("bank"), uid, "kid").unwrap();
        assert!(repo.get(uid, "default", "bank").is_some());
        assert!(repo.get(uid, "kid", "bank").is_some());
        assert_eq!(repo.list(uid, "default").len(), 1);
        assert_eq!(repo.list(uid, "kid").len(), 1);
    }

    #[test]
    fn user_isolation_same_profile_no_collision() {
        // V1 (2026-08-09): 同 profile 不同 user 的词不撞主键 —— 切人后各自数据的前提
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("bank"), DEFAULT_USER_ID, "default")
            .unwrap();
        repo.upsert_content(entry("bank"), "u-kid", "default")
            .unwrap();
        assert_eq!(repo.list(DEFAULT_USER_ID, "default").len(), 1, "我 1 条");
        assert_eq!(repo.list("u-kid", "default").len(), 1, "孩子 1 条");
        assert_eq!(repo.list(DEFAULT_USER_ID, "default")[0].meaning, "含义");
    }

    #[test]
    fn content_upsert_keeps_srs() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let uid = DEFAULT_USER_ID;
        let mut e = entry("bank");
        e.stage = "review".into();
        e.interval = 3.0;
        repo.upsert_content(e, uid, "default").unwrap();
        let mut e2 = entry("bank");
        e2.meaning = "新含义".into();
        e2.stage = "learning".into();
        repo.upsert_content(e2, uid, "default").unwrap();
        let got = repo.get(uid, "default", "bank").unwrap();
        assert_eq!(got.meaning, "新含义");
        assert_eq!(got.stage, "review", "SRS 应保留");
        assert_eq!(got.interval, 3.0, "SRS interval 应保留");
    }

    #[test]
    fn sync_import_overwrites_srs_when_newer() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let uid = DEFAULT_USER_ID;
        let mut e = entry("bank");
        e.stage = "review".into();
        e.updated_at = 100;
        repo.upsert_sync(e, uid, "default").unwrap();
        let mut e2 = entry("bank");
        e2.stage = "mastered".into();
        e2.interval = 30.0;
        e2.updated_at = 200; // 远端更新
        repo.upsert_sync(e2, uid, "default").unwrap();
        let got = repo.get(uid, "default", "bank").unwrap();
        assert_eq!(got.stage, "mastered", "sync 应允许覆盖 SRS");
        assert_eq!(got.interval, 30.0);
    }

    #[test]
    fn lossless_roundtrip_deep_fields() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let uid = DEFAULT_USER_ID;
        let mut e = entry("break");
        e.deep_data = serde_json::json!({"kanji": [{"text": "破", "stroke": 10}]});
        e.last_review = Some(1700000000000);
        e.last_grade = Some(3);
        e.interval = 2.7; // 浮点
        e.interval_ms = 259_200_000; // V2: 毫秒级间隔 (分钟级步长存 payload)
        e.next_review = Some(1700001000000);
        repo.upsert_sync(e, uid, "default").unwrap();
        let got = repo.get(uid, "default", "break").unwrap();
        assert_eq!(got.deep_data["kanji"][0]["stroke"], 10);
        assert_eq!(got.last_review, Some(1700000000000));
        assert_eq!(got.last_grade, Some(3));
        assert_eq!(got.interval, 2.7);
        assert_eq!(
            got.interval_ms, 259_200_000,
            "interval_ms 应随 payload 无损往返"
        );
        assert_eq!(got.next_review, Some(1700001000000));
    }

    #[test]
    fn srs_grade_persists_interval_ms() {
        // V2: 调度器评分后 interval_ms 写回并读回 (分钟级步长依赖毫秒字段)
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let uid = DEFAULT_USER_ID;
        repo.upsert_content(entry("bank"), uid, "default").unwrap();
        // 新词评"忘了"(grade 1) → learning, 1 分钟
        let mut e = repo.get(uid, "default", "bank").unwrap();
        let now = crate::store::now_ms_for_store();
        let state = crate::domain::srs::state_from_entry(&e);
        let o = crate::domain::srs::apply_grade(&state, 1, now);
        e = crate::domain::srs::apply_outcome(e, &o);
        repo.upsert_sync(e, uid, "default").unwrap();
        let got = repo.get(uid, "default", "bank").unwrap();
        assert_eq!(got.stage, "learning");
        assert_eq!(
            got.interval_ms,
            crate::domain::srs::MINUTE_1,
            "1 分钟步长应存毫秒"
        );
        assert!(got.next_review.is_some());
    }
}
