//! store/batches_repo.rs —— 批量任务唯一写者 (G2)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Batch {
    pub id: String,
    pub profile_id: String,
    pub source_language: String,
    pub target_language: String,
    pub status: String, // created | running | completed | partial | failed | canceled
    pub total_books: i64,
    pub done_books: i64,
    pub failed_books: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct BatchesRepo<'a> {
    db: &'a Db,
}

impl<'a> BatchesRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, b: &Batch) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO batches (id, profile_id, source_language, target_language, status,
                                  total_books, done_books, failed_books, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status, total_books = excluded.total_books,
                done_books = excluded.done_books, failed_books = excluded.failed_books,
                updated_at = excluded.updated_at",
            params![
                b.id, b.profile_id, b.source_language, b.target_language, b.status,
                b.total_books, b.done_books, b.failed_books, b.created_at, b.updated_at
            ],
        )
        .map_err(|e| format!("写批次失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Batch> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, profile_id, source_language, target_language, status,
                    total_books, done_books, failed_books, created_at, updated_at
             FROM batches WHERE id = ?1",
            [id],
            |r| {
                Ok(Batch {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    source_language: r.get(2)?,
                    target_language: r.get(3)?,
                    status: r.get(4)?,
                    total_books: r.get(5)?,
                    done_books: r.get(6)?,
                    failed_books: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            },
        )
        .ok()
    }

    pub fn list(&self) -> Vec<Batch> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, profile_id, source_language, target_language, status,
                             total_books, done_books, failed_books, created_at, updated_at
                      FROM batches ORDER BY created_at DESC")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Batch {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                source_language: r.get(2)?,
                target_language: r.get(3)?,
                status: r.get(4)?,
                total_books: r.get(5)?,
                done_books: r.get(6)?,
                failed_books: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn update_progress(&self, id: &str, done: i64, failed: i64) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE batches SET done_books = ?1, failed_books = ?2,
                status = CASE WHEN ?1 + ?2 >= total_books AND ?2 = 0 THEN 'completed'
                              WHEN ?1 + ?2 >= total_books THEN 'partial'
                              ELSE 'running' END,
                updated_at = strftime('%s','now')*1000
             WHERE id = ?3",
            params![done, failed, id],
        )
        .map_err(|e| format!("更新批次进度失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_batch_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn batch(id: &str) -> Batch {
        Batch {
            id: id.into(),
            profile_id: "default".into(),
            source_language: "en".into(),
            target_language: "zh-CN".into(),
            status: "created".into(),
            total_books: 2,
            done_books: 0,
            failed_books: 0,
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn upsert_get_list() {
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        repo.upsert(&batch("b1")).unwrap();
        assert_eq!(repo.get("b1").unwrap().status, "created");
        assert_eq!(repo.list().len(), 1);
    }

    #[test]
    fn progress_transitions() {
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        repo.upsert(&batch("b1")).unwrap();
        repo.update_progress("b1", 1, 0).unwrap();
        assert_eq!(repo.get("b1").unwrap().status, "running");
        repo.update_progress("b1", 2, 0).unwrap();
        assert_eq!(repo.get("b1").unwrap().status, "completed");
    }

    #[test]
    fn partial_when_any_failed() {
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        repo.upsert(&batch("b1")).unwrap();
        repo.update_progress("b1", 1, 1).unwrap();
        assert_eq!(repo.get("b1").unwrap().status, "partial");
    }
}
