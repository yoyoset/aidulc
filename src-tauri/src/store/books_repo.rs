//! store/books_repo.rs —— 书库唯一写者 (3.4 所有权表)
//! v5 (H1): 书级语言 + 模型绑定 (语言/模型跟随书)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub source_path: String,
    pub pack_dir: String,
    pub profile_id: String,
    pub status: String, // ready | processing | partial | pending | failed
    /// 架构分离 (v7): original = 原版 (导入的管理对象) | product = AI 成品 (可阅读)
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 资产模型 (v8): product 关联的原书 id (不同模型组合 = 不同资产)
    #[serde(default)]
    pub source_book_id: Option<String>,
    pub chapter_count: i64,
    pub failed_count: i64,
    pub last_opened_at: Option<i64>,
    #[serde(default)]
    pub source_language: String,
    #[serde(default)]
    pub target_language: String,
    #[serde(default)]
    pub llm_id: Option<String>,
    #[serde(default)]
    pub tts_id: Option<String>,
    #[serde(default)]
    pub nlp_id: Option<String>,
    /// v32 (2026-08-19): 导入自动标准化状态 none|pending|running|done|failed
    #[serde(default = "default_standardize_status")]
    pub standardize_status: String,
    /// v32: 给人看的结果 (done/failed 都填, pending/running/none 为 None)
    #[serde(default)]
    pub standardize_note: Option<String>,
    /// v32: done 时兜底解析产出的章节/句子 JSON 绝对路径 (内部路径, 不给前端)
    #[serde(default, skip_serializing)]
    pub standardize_cache_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_kind() -> String {
    "original".into()
}

fn default_standardize_status() -> String {
    "none".into()
}

impl Book {
    fn row_to_book(r: &rusqlite::Row) -> rusqlite::Result<Book> {
        Ok(Book {
            id: r.get(0)?,
            title: r.get(1)?,
            source_path: r.get(2)?,
            pack_dir: r.get(3)?,
            profile_id: r.get(4)?,
            status: r.get(5)?,
            kind: r.get(6)?,
            source_book_id: r.get(7)?,
            chapter_count: r.get(8)?,
            failed_count: r.get(9)?,
            last_opened_at: r.get(10)?,
            source_language: r.get(11)?,
            target_language: r.get(12)?,
            llm_id: r.get(13)?,
            tts_id: r.get(14)?,
            nlp_id: r.get(15)?,
            standardize_status: r.get(16)?,
            standardize_note: r.get(17)?,
            standardize_cache_path: r.get(18)?,
            created_at: r.get(19)?,
            updated_at: r.get(20)?,
        })
    }

    const COLS: &'static str = "id, title, source_path, pack_dir, profile_id, status, kind,
                                source_book_id, chapter_count, failed_count, last_opened_at,
                                source_language, target_language, llm_id, tts_id, nlp_id,
                                standardize_status, standardize_note, standardize_cache_path,
                                created_at, updated_at";
}

pub struct BooksRepo<'a> {
    db: &'a Db,
}

impl<'a> BooksRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, b: &Book) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, source_path, pack_dir, profile_id, status, kind,
                                source_book_id, chapter_count, failed_count, last_opened_at,
                                source_language, target_language, llm_id, tts_id, nlp_id,
                                standardize_status, standardize_note, standardize_cache_path,
                                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title, source_path = excluded.source_path,
                pack_dir = excluded.pack_dir, profile_id = excluded.profile_id,
                status = excluded.status, kind = excluded.kind,
                source_book_id = excluded.source_book_id,
                chapter_count = excluded.chapter_count,
                failed_count = excluded.failed_count,
                source_language = excluded.source_language, target_language = excluded.target_language,
                llm_id = excluded.llm_id, tts_id = excluded.tts_id, nlp_id = excluded.nlp_id,
                standardize_status = excluded.standardize_status,
                standardize_note = excluded.standardize_note,
                standardize_cache_path = excluded.standardize_cache_path,
                updated_at = excluded.updated_at",
            params![
                b.id, b.title, b.source_path, b.pack_dir, b.profile_id, b.status, b.kind,
                b.source_book_id, b.chapter_count, b.failed_count, b.last_opened_at,
                b.source_language, b.target_language, b.llm_id, b.tts_id, b.nlp_id,
                b.standardize_status, b.standardize_note, b.standardize_cache_path,
                b.created_at, b.updated_at
            ],
        )
        .map_err(|e| format!("写书库失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Book> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {} FROM books WHERE id = ?1", Book::COLS),
            [id],
            Book::row_to_book,
        )
        .ok()
    }

    pub fn list(&self) -> Vec<Book> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM books ORDER BY updated_at DESC",
                Book::COLS
            ))
            .unwrap();
        stmt.query_map([], Book::row_to_book)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// 按 kind 过滤: original = 原版管理 | product = AI 成品 (可阅读)
    pub fn list_by_kind(&self, kind: &str) -> Vec<Book> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM books WHERE kind = ?1 ORDER BY updated_at DESC",
                Book::COLS
            ))
            .unwrap();
        stmt.query_map([kind], Book::row_to_book)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// v32: 取最早一条待标准化的原书 (按 created_at 升序), 无则 None。
    /// 只在标准化的串行队列里用 —— 每次只取一条, 处理完再取下一条。
    pub fn next_pending_standardize(&self) -> Option<Book> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM books WHERE standardize_status = 'pending' ORDER BY created_at ASC LIMIT 1",
                Book::COLS
            ),
            [],
            Book::row_to_book,
        )
        .ok()
    }

    /// 删除原书 (books 表唯一写者; 2026-08-09 接线进 delete_source, 不再是死代码)。
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM books WHERE id = ?1", [id])
            .map_err(|e| format!("删书失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_bk_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn book(id: &str, title: &str) -> Book {
        Book {
            id: id.into(),
            title: title.into(),
            source_path: format!("C:/{id}.epub"),
            pack_dir: format!("library/{id}"),
            profile_id: "default".into(),
            status: "ready".into(),
            kind: "product".into(),
            source_book_id: None,
            chapter_count: 1,
            failed_count: 0,
            last_opened_at: None,
            source_language: "en".into(),
            target_language: "zh-CN".into(),
            llm_id: Some("llm|en|qwen3-4b".into()),
            tts_id: Some("tts|en|kokoro".into()),
            nlp_id: Some("nlp|en|spacy-sm".into()),
            standardize_status: "none".into(),
            standardize_note: None,
            standardize_cache_path: None,
            created_at: 1700000000000,
            updated_at: 1700000000000,
        }
    }

    #[test]
    fn upsert_list_get_remove() {
        let db = temp_db();
        let repo = BooksRepo::new(&db);
        repo.upsert(&book("a", "Alice")).unwrap();
        repo.upsert(&book("b", "Bob")).unwrap();
        assert_eq!(repo.list().len(), 2);
        assert_eq!(repo.get("a").unwrap().title, "Alice");
        repo.remove("a").unwrap();
        assert_eq!(repo.list().len(), 1);
        assert!(repo.get("a").is_none());
    }

    #[test]
    fn language_and_model_binding_roundtrip() {
        let db = temp_db();
        let repo = BooksRepo::new(&db);
        let mut b = book("a", "Alice");
        b.source_language = "en".into();
        b.llm_id = Some("llm|en|qwen3-4b|2507".into());
        repo.upsert(&b).unwrap();
        let got = repo.get("a").unwrap();
        assert_eq!(got.source_language, "en");
        assert_eq!(got.llm_id.as_deref(), Some("llm|en|qwen3-4b|2507"));
        assert_eq!(got.tts_id.as_deref(), Some("tts|en|kokoro"));
    }

    #[test]
    fn standardize_fields_roundtrip() {
        // v32: 三个新字段 upsert 后能原样读回 (status/note/cache_path)
        let db = temp_db();
        let repo = BooksRepo::new(&db);
        let mut b = book("a", "Alice");
        b.standardize_status = "done".into();
        b.standardize_note = Some("33章2793句, 已可正常处理".into());
        b.standardize_cache_path = Some("C:/data/standardize_cache/a.json".into());
        repo.upsert(&b).unwrap();
        let got = repo.get("a").unwrap();
        assert_eq!(got.standardize_status, "done");
        assert_eq!(
            got.standardize_note.as_deref(),
            Some("33章2793句, 已可正常处理")
        );
        assert_eq!(
            got.standardize_cache_path.as_deref(),
            Some("C:/data/standardize_cache/a.json")
        );
    }

    #[test]
    fn standardize_cache_path_not_serialized_to_frontend() {
        // 1d: standardize_cache_path 是内部路径, library_list 序列化不应暴露它,
        // 但 standardize_status/note 要给前端。
        let mut b = book("a", "Alice");
        b.standardize_status = "done".into();
        b.standardize_note = Some("33章2793句".into());
        b.standardize_cache_path = Some("C:/internal/cache.json".into());
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["standardize_status"], "done");
        assert_eq!(v["standardize_note"], "33章2793句");
        assert!(
            v.get("standardize_cache_path").is_none(),
            "内部路径不应暴露给前端"
        );
    }

    #[test]
    fn next_pending_standardize_returns_earliest_by_created_at() {
        let db = temp_db();
        let repo = BooksRepo::new(&db);
        assert!(repo.next_pending_standardize().is_none(), "空表应返回 None");
        // 三条: pending 最早的是 b (created_at=100); done/none 不参与
        let mut a = book("a", "A");
        a.standardize_status = "pending".into();
        a.created_at = 300;
        let mut b = book("b", "B");
        b.standardize_status = "pending".into();
        b.created_at = 100;
        let mut c = book("c", "C");
        c.standardize_status = "done".into();
        c.created_at = 50;
        let mut d = book("d", "D");
        d.standardize_status = "none".into();
        d.created_at = 10;
        repo.upsert(&a).unwrap();
        repo.upsert(&b).unwrap();
        repo.upsert(&c).unwrap();
        repo.upsert(&d).unwrap();
        let next = repo.next_pending_standardize().unwrap();
        assert_eq!(next.id, "b", "应按 created_at 升序取最早一条 pending");
        assert_eq!(
            next.standardize_status, "pending",
            "取出的仍应是 pending 行"
        );
    }
}
