//! store/batches_repo.rs —— 批量任务唯一写者 (G2)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// N6 (2026-08-10): 批次列表返回上限 —— 表行不再无界返回 (UI 只显示前 5, 这里封顶防 DB 全表扫)。
pub const BATCH_LIST_LIMIT: i64 = 50;

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
                b.id,
                b.profile_id,
                b.source_language,
                b.target_language,
                b.status,
                b.total_books,
                b.done_books,
                b.failed_books,
                b.created_at,
                b.updated_at
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
            .prepare(
                "SELECT id, profile_id, source_language, target_language, status,
                             total_books, done_books, failed_books, created_at, updated_at
                      FROM batches ORDER BY created_at DESC LIMIT ?1",
            )
            .unwrap();
        stmt.query_map([BATCH_LIST_LIMIT], |r| {
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

    /// N6 (2026-08-10): 清理终态且超过保留期的批次行。
    /// 只删批次行, 不级联 jobs —— jobs 仍按 batch_id 分组显示在任务列表, 只是不再有
    /// 批次摘要行。批次行小, 保留期取宽 (30 天), 目的是别让表无界累积。
    pub fn cleanup_old(&self, keep_days: i64) -> Result<usize, String> {
        let conn = self.db.conn.lock().unwrap();
        let cutoff = crate::store::now_ms_for_store() - keep_days * 86_400_000;
        conn.execute(
            "DELETE FROM batches
             WHERE status IN ('completed','failed','canceled') AND updated_at < ?1",
            [cutoff],
        )
        .map_err(|e| format!("清理旧批次失败: {e}"))
    }

    pub fn update_progress(&self, id: &str, done: i64, failed: i64) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE batches SET done_books = ?1, failed_books = ?2,
                status = CASE WHEN total_books > 0 AND ?1 + ?2 >= total_books AND ?2 = 0 THEN 'completed'
                              WHEN total_books > 0 AND ?1 + ?2 >= total_books THEN 'partial'
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
        let path =
            std::env::temp_dir().join(format!("aidulc_batch_test_{}.db", std::process::id()));
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

    #[test]
    fn zero_total_books_never_completed() {
        // B2 (2026-08-18): total_books=0 时 ?1+?2 >= 0 恒真, 批次一建出来就是 completed
        // (实测: 表里 10 个批次 job 还在 queued, 批次已经 completed)。
        // 修法: 两个 WHEN 都加 total_books > 0 前置, 0 本书的批次保持 running。
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        let mut b = batch("b1");
        b.total_books = 0;
        repo.upsert(&b).unwrap();
        repo.update_progress("b1", 0, 0).unwrap();
        assert_ne!(repo.get("b1").unwrap().status, "completed");
        assert_eq!(repo.get("b1").unwrap().status, "running");
    }

    #[test]
    fn list_is_capped_at_limit() {
        // N6 (2026-08-10): list() 有 LIMIT, 表行不再无界返回
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        for i in 0..(BATCH_LIST_LIMIT + 10) {
            let mut b = batch(&format!("b{i}"));
            b.created_at = now + i;
            repo.upsert(&b).unwrap();
        }
        assert_eq!(repo.list().len() as i64, BATCH_LIST_LIMIT);
    }

    #[test]
    fn cleanup_old_removes_only_terminal_and_expired() {
        // N6 (2026-08-10): 只删终态 + 超过保留期的批次, 保留 running/未过期
        let db = temp_db();
        let repo = BatchesRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        // 过期: completed (40 天前)
        let mut old_done = batch("old_done");
        old_done.status = "completed".into();
        old_done.updated_at = now - 40 * 86_400_000;
        repo.upsert(&old_done).unwrap();
        // 过期但还在跑: running (40 天前)
        let mut old_run = batch("old_run");
        old_run.status = "running".into();
        old_run.updated_at = now - 40 * 86_400_000;
        repo.upsert(&old_run).unwrap();
        // 未过期: completed (昨天)
        let mut fresh_done = batch("fresh_done");
        fresh_done.status = "completed".into();
        fresh_done.updated_at = now - 86_400_000;
        repo.upsert(&fresh_done).unwrap();
        repo.cleanup_old(30).unwrap();
        assert!(repo.get("old_done").is_none(), "过期 completed 批次应被清");
        assert!(repo.get("old_run").is_some(), "running 批次不清");
        assert!(
            repo.get("fresh_done").is_some(),
            "未过期 completed 批次保留"
        );
    }
}
