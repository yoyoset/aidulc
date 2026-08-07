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
                                         size_bytes, installed_at, active, custom)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                family = excluded.family, language = excluded.language,
                model_id = excluded.model_id, version = excluded.version,
                variant = excluded.variant, path = excluded.path,
                source_type = excluded.source_type, source_ref = excluded.source_ref,
                commit_sha = excluded.commit_sha, sha256 = excluded.sha256,
                size_bytes = excluded.size_bytes, active = excluded.active,
                custom = excluded.custom",
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
                if m.custom { 1 } else { 0 }
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
                    size_bytes, installed_at, active, custom
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
        })
    }

    /// 某语言某家族的所有模型
    pub fn list_by(&self, family: &str, language: &str) -> Vec<ModelEntry> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, family, language, model_id, version, variant,
                             path, source_type, source_ref, commit_sha, sha256,
                             size_bytes, installed_at, active, custom
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
                             size_bytes, installed_at, active, custom
                      FROM model_registry ORDER BY family, language, installed_at DESC",
            )
            .unwrap();
        stmt.query_map([], Self::row_to_entry)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
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
