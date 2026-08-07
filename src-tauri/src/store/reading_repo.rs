//! store/reading_repo.rs —— 阅读进度/书签/播放位置唯一写者

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadingState {
    pub book_key: String,
    pub chapter: i64,
    pub position_ms: i64,
    pub bookmarks: Vec<i64>, // 句下标
}

pub struct ReadingRepo<'a> {
    db: &'a Db,
}

impl<'a> ReadingRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, s: &ReadingState) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reading_state (book_key, chapter, position_ms, bookmarks, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(book_key) DO UPDATE SET
                chapter = excluded.chapter, position_ms = excluded.position_ms,
                bookmarks = excluded.bookmarks, updated_at = excluded.updated_at",
            params![
                s.book_key,
                s.chapter,
                s.position_ms,
                serde_json::to_string(&s.bookmarks).unwrap_or_else(|_| "[]".to_string()),
                now
            ],
        )
        .map_err(|e| format!("写阅读状态失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, book_key: &str) -> Option<ReadingState> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT book_key, chapter, position_ms, bookmarks FROM reading_state WHERE book_key = ?1",
            [book_key],
            |r| {
                let bm: String = r.get(3)?;
                Ok(ReadingState {
                    book_key: r.get(0)?,
                    chapter: r.get(1)?,
                    position_ms: r.get(2)?,
                    bookmarks: serde_json::from_str(&bm).unwrap_or_default(),
                })
            },
        )
        .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_rd_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        let s = ReadingState { book_key: "alice_self".into(), chapter: 0, position_ms: 12345, bookmarks: vec![3, 7] };
        repo.upsert(&s).unwrap();
        assert_eq!(repo.get("alice_self").unwrap(), s);
    }

    #[test]
    fn update_position() {
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        repo.upsert(&ReadingState { book_key: "k".into(), chapter: 0, position_ms: 100, bookmarks: vec![] }).unwrap();
        repo.upsert(&ReadingState { book_key: "k".into(), chapter: 1, position_ms: 500, bookmarks: vec![1] }).unwrap();
        let got = repo.get("k").unwrap();
        assert_eq!(got.chapter, 1);
        assert_eq!(got.position_ms, 500);
        assert_eq!(got.bookmarks, vec![1]);
    }
}
