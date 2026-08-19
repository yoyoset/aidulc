//! store/model_repo.rs —— 模型注册表唯一写者 (H1)
//! 语言/模型跟随书; 注册表是"已安装模型"清单, active 标记 = 推荐默认。

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelEntry {
    pub id: String,       // "llm|en|qwen3-4b|2507-q4_k_m"
    pub family: String,   // llm | tts | nlp
    pub language: String, // en | zh | ja | *
    pub model_id: String,
    pub version: String,
    pub variant: String, // cuda12.4 | cpu
    pub path: String,
    pub source_type: String, // hf | github | spacy | local
    pub source_ref: String,
    pub commit_sha: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub installed_at: i64,
    pub active: bool, // 推荐标记 (每 family+language 可多个 active, 书级自由选)
    pub custom: bool,
    /// UX5 修正 (2026-08-13): 扫描登记时按特征推断的家族 (llm/tts/nlp/asr/vad/unknown)。
    /// 前端据此标注"本项目用不用得到"; asr/vad/unknown 不是本项目的引擎。
    pub detected_family: String,
}

pub struct ModelRepo<'a> {
    db: &'a Db,
}

impl<'a> ModelRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, m: &ModelEntry) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO model_registry (id, family, language, model_id, version, variant,
                                         path, source_type, source_ref, commit_sha, sha256,
                                         size_bytes, installed_at, active, custom, detected_family)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
                family = excluded.family, language = excluded.language,
                model_id = excluded.model_id, version = excluded.version,
                variant = excluded.variant, path = excluded.path,
                source_type = excluded.source_type, source_ref = excluded.source_ref,
                commit_sha = excluded.commit_sha, sha256 = excluded.sha256,
                size_bytes = excluded.size_bytes, active = excluded.active,
                custom = excluded.custom, detected_family = excluded.detected_family",
            params![
                m.id,
                m.family,
                m.language,
                m.model_id,
                m.version,
                m.variant,
                m.path,
                m.source_type,
                m.source_ref,
                m.commit_sha,
                m.sha256,
                m.size_bytes,
                m.installed_at,
                if m.active { 1 } else { 0 },
                if m.custom { 1 } else { 0 },
                m.detected_family
            ],
        )
        .map_err(|e| format!("写模型注册表失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<ModelEntry> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, family, language, model_id, version, variant,
                    path, source_type, source_ref, commit_sha, sha256,
                    size_bytes, installed_at, active, custom, detected_family
             FROM model_registry WHERE id = ?1",
            [id],
            Self::row_to_entry,
        )
        .ok()
    }

    fn row_to_entry(r: &rusqlite::Row) -> rusqlite::Result<ModelEntry> {
        Ok(ModelEntry {
            id: r.get(0)?,
            family: r.get(1)?,
            language: r.get(2)?,
            model_id: r.get(3)?,
            version: r.get(4)?,
            variant: r.get(5)?,
            path: r.get(6)?,
            source_type: r.get(7)?,
            source_ref: r.get(8)?,
            commit_sha: r.get(9)?,
            sha256: r.get(10)?,
            size_bytes: r.get(11)?,
            installed_at: r.get(12)?,
            active: r.get::<_, i64>(13)? != 0,
            custom: r.get::<_, i64>(14)? != 0,
            detected_family: r.get(15)?,
        })
    }

    /// 某语言某家族的所有模型
    pub fn list_by(&self, family: &str, language: &str) -> Vec<ModelEntry> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, family, language, model_id, version, variant,
                             path, source_type, source_ref, commit_sha, sha256,
                             size_bytes, installed_at, active, custom, detected_family
                      FROM model_registry WHERE family = ?1 AND (language = ?2 OR language = '*')
                      ORDER BY installed_at DESC",
            )
            .unwrap();
        stmt.query_map(params![family, language], Self::row_to_entry)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn list_all(&self) -> Vec<ModelEntry> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, family, language, model_id, version, variant,
                             path, source_type, source_ref, commit_sha, sha256,
                             size_bytes, installed_at, active, custom, detected_family
                      FROM model_registry ORDER BY family, language, installed_at DESC",
            )
            .unwrap();
        stmt.query_map([], Self::row_to_entry)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// 2026-08-10 死锁修复 (models_list 曾持 conn 锁调 list_all → 二次锁永久卡死)。
    /// 返回 (ModelEntry, bound_count), bound = 被书/译本引用的次数 (资产状态用)。
    /// 锁在方法内部自管, 调用方绝不能再手动 lock conn。
    pub fn list_all_with_bound(&self) -> Vec<(ModelEntry, i64)> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, family, language, model_id, version, variant,
                             path, source_type, source_ref, commit_sha, sha256,
                             size_bytes, installed_at, active, custom, detected_family
                      FROM model_registry ORDER BY family, language, installed_at DESC",
            )
            .unwrap();
        let models: Vec<ModelEntry> = stmt
            .query_map([], Self::row_to_entry)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::with_capacity(models.len());
        for model in models {
            let bound: i64 = conn
                .query_row(
                    "SELECT
                        (SELECT COUNT(*) FROM editions WHERE llm_id=?1 OR tts_id=?1 OR nlp_id=?1) +
                        (SELECT COUNT(*) FROM books WHERE llm_id=?1 OR tts_id=?1 OR nlp_id=?1)",
                    [&model.id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            out.push((model, bound));
        }
        out
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM model_registry WHERE id = ?1", [id])
            .map_err(|e| format!("删模型失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_mdl_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn entry(id: &str, family: &str, lang: &str, model: &str) -> ModelEntry {
        ModelEntry {
            id: id.into(),
            family: family.into(),
            language: lang.into(),
            model_id: model.into(),
            version: "1.0".into(),
            variant: "cuda12.4".into(),
            path: format!("C:/models/{model}"),
            source_type: "hf".into(),
            source_ref: "repo".into(),
            commit_sha: "abc".into(),
            sha256: "x".into(),
            size_bytes: 1000,
            installed_at: 100,
            active: false,
            custom: false,
            detected_family: String::new(),
        }
    }

    #[test]
    fn upsert_get_list() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm|en|qwen", "llm", "en", "qwen.gguf"))
            .unwrap();
        repo.upsert(&entry("tts|en|kokoro", "tts", "en", "kokoro.pth"))
            .unwrap();
        assert_eq!(repo.list_all().len(), 2);
        assert_eq!(repo.list_by("llm", "en").len(), 1);
        assert_eq!(repo.get("llm|en|qwen").unwrap().model_id, "qwen.gguf");
    }

    #[test]
    fn wildcard_language_matches_all() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm|*|base", "llm", "*", "base.gguf"))
            .unwrap();
        assert_eq!(repo.list_by("llm", "en").len(), 1, "* 语言应匹配 en");
        assert_eq!(repo.list_by("llm", "ja").len(), 1);
    }

    /// 2026-08-10 死锁回归: models_list 曾"持 conn 锁 + 调 list_all()"(内部再锁同一
    /// Mutex, 不可重入) → 主线程永久卡死 (点设置"模型中心"tab 假死, 实测 Responding=False
    /// + CPU 0.5s + 40 线程全 Wait)。list_all_with_bound 把锁收进方法内部, 调用方不能再
    /// 手动 lock。本测试若回归死锁会直接挂死 (--test-threads=1 下可见超时)。
    fn insert_bindings_for_models(db: &Db) {
        use crate::store::books_repo::{Book, BooksRepo};
        use crate::store::editions_repo::{Edition, EditionsRepo};
        let book = Book {
            id: "b1".into(),
            title: "Alice".into(),
            source_path: "C:/books/alice.epub".into(),
            pack_dir: "C:/packs/b1".into(),
            profile_id: "default".into(),
            status: "ready".into(),
            kind: "original".into(),
            source_book_id: None,
            chapter_count: 12,
            failed_count: 0,
            last_opened_at: None,
            source_language: "en".into(),
            target_language: "zh".into(),
            llm_id: Some("llm|en|qwen".into()),
            tts_id: Some("tts|en|kokoro".into()),
            nlp_id: None,
            standardize_status: "none".into(),
            standardize_note: None,
            standardize_cache_path: None,
            created_at: 1,
            updated_at: 1,
        };
        BooksRepo::new(db).upsert(&book).unwrap();
        let edition = Edition {
            id: "e1".into(),
            source_id: "b1".into(),
            title: "Alice EN".into(),
            pack_dir: "C:/packs/e1".into(),
            profile_id: "default".into(),
            status: "done".into(),
            chapter_count: 12,
            failed_count: 0,
            last_opened_at: None,
            source_language: "en".into(),
            target_language: "zh".into(),
            llm_id: Some("llm|en|qwen".into()),
            tts_id: Some("tts|en|kokoro".into()),
            nlp_id: None,
            created_at: 1,
            updated_at: 1,
        };
        EditionsRepo::new(db).upsert(&edition).unwrap();
    }

    #[test]
    fn list_all_with_bound_no_deadlock_and_counts_bindings() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm|en|qwen", "llm", "en", "qwen.gguf"))
            .unwrap();
        repo.upsert(&entry("tts|en|kokoro", "tts", "en", "kokoro.pth"))
            .unwrap();
        repo.upsert(&entry("llm|en|other", "llm", "en", "other.gguf"))
            .unwrap();
        insert_bindings_for_models(&db); // b1 引用了 qwen + kokoro
        let rows = repo.list_all_with_bound();
        assert_eq!(rows.len(), 3, "三模型都应返回");
        let by_id = |id: &str| {
            rows.iter()
                .find(|(m, _)| m.id == id)
                .map(|(_, b)| *b)
                .unwrap()
        };
        assert_eq!(by_id("llm|en|qwen"), 2, "被书和译本各引一次 → bound=2");
        assert_eq!(by_id("tts|en|kokoro"), 2);
        assert_eq!(by_id("llm|en|other"), 0, "无引用 → bound=0");
    }

    #[test]
    fn remove() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm|en|qwen", "llm", "en", "qwen.gguf"))
            .unwrap();
        repo.remove("llm|en|qwen").unwrap();
        assert!(repo.get("llm|en|qwen").is_none());
    }
}
