//! store/jobs_repo.rs —— 任务表唯一写者 (P4 + G2: batch_id / 多语言预留)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Job {
    pub id: String,
    pub book_path: String,
    pub profile_id: String,
    pub output_dir: String,
    pub status: String, // queued | running | done | failed | canceled
    pub stage: String,
    pub current: i64,
    pub total: i64,
    pub failed_count: i64,
    #[serde(default)]
    pub batch_id: Option<String>, // G2: 批量工作流
    #[serde(default)]
    pub source_language: String, // G2: 多语言预留
    #[serde(default)]
    pub target_language: String,
    /// I-C: 失败原因摘要 (阶段+句数+原因), 仅 failed 时非空
    #[serde(default)]
    pub error: Option<String>,
    /// v9: 全书完成度 (0-100, 阶段权重计算, 后端算好前端只显示)
    #[serde(default)]
    pub progress: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct JobsRepo<'a> {
    db: &'a Db,
}

impl<'a> JobsRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, j: &Job) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs (id, book_path, profile_id, output_dir, status, stage,
                               current, total, failed_count, batch_id, source_language, target_language,
                               error, progress, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status, stage = excluded.stage,
                current = excluded.current, total = excluded.total,
                failed_count = excluded.failed_count, batch_id = excluded.batch_id,
                error = excluded.error, progress = excluded.progress,
                updated_at = excluded.updated_at",
            params![
                j.id, j.book_path, j.profile_id, j.output_dir, j.status, j.stage,
                j.current, j.total, j.failed_count, j.batch_id, j.source_language, j.target_language,
                j.error, j.progress, j.created_at, j.updated_at
            ],
        )
        .map_err(|e| format!("写任务失败: {e}"))?;
        Ok(())
    }

    fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<Job> {
        Ok(Job {
            id: r.get(0)?,
            book_path: r.get(1)?,
            profile_id: r.get(2)?,
            output_dir: r.get(3)?,
            status: r.get(4)?,
            stage: r.get(5)?,
            current: r.get(6)?,
            total: r.get(7)?,
            failed_count: r.get(8)?,
            batch_id: r.get(9)?,
            source_language: r.get(10)?,
            target_language: r.get(11)?,
            error: r.get(12)?,
            progress: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
        })
    }

    const COLS: &'static str = "id, book_path, profile_id, output_dir, status, stage,
                                current, total, failed_count, batch_id, source_language, target_language,
                                error, progress, created_at, updated_at";

    pub fn get(&self, id: &str) -> Option<Job> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {} FROM jobs WHERE id = ?1", Self::COLS), [id], Self::row_to_job)
            .ok()
    }

    pub fn list(&self) -> Vec<Job> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {} FROM jobs ORDER BY created_at DESC", Self::COLS))
            .unwrap();
        stmt.query_map([], Self::row_to_job)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn list_by_batch(&self, batch_id: &str) -> Vec<Job> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {} FROM jobs WHERE batch_id = ?1 ORDER BY created_at", Self::COLS))
            .unwrap();
        stmt.query_map([batch_id], Self::row_to_job)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM jobs WHERE id = ?1", [id])
            .map_err(|e| format!("删任务失败: {e}"))?;
        Ok(())
    }

    /// 重启恢复: 把 running 状态的任务标记为 queued (侧车已死), 允许重新拉起
    pub fn reset_stale(&self) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'queued', stage = '', error = NULL, progress = 0,
                             updated_at = strftime('%s','now')*1000
             WHERE status = 'running'",
            [],
        )
        .map_err(|e| format!("重置任务状态失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_job_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn job(id: &str, status: &str) -> Job {
        Job {
            id: id.into(),
            book_path: "C:/b.epub".into(),
            profile_id: "default".into(),
            output_dir: format!("out/{id}"),
            status: status.into(),
            stage: String::new(),
            current: 0,
            total: 10,
            failed_count: 0,
            batch_id: None,
            source_language: "en".into(),
            target_language: "zh-CN".into(),
            error: None,
            progress: 0.0,
            created_at: 1700000000000,
            updated_at: 1700000000000,
        }
    }

    #[test]
    fn upsert_list_get() {
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        repo.upsert(&job("j1", "queued")).unwrap();
        repo.upsert(&job("j2", "running")).unwrap();
        assert_eq!(repo.list().len(), 2);
        assert_eq!(repo.get("j1").unwrap().status, "queued");
    }

    #[test]
    fn batch_id_roundtrip() {
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        let mut j = job("j1", "queued");
        j.batch_id = Some("batch-1".into());
        repo.upsert(&j).unwrap();
        assert_eq!(repo.get("j1").unwrap().batch_id.as_deref(), Some("batch-1"));
        assert_eq!(repo.list_by_batch("batch-1").len(), 1);
        assert_eq!(repo.list_by_batch("nope").len(), 0);
    }

    #[test]
    fn update_status() {
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        repo.upsert(&job("j1", "queued")).unwrap();
        let mut j = repo.get("j1").unwrap();
        j.status = "running".into();
        j.stage = "translate".into();
        repo.upsert(&j).unwrap();
        assert_eq!(repo.get("j1").unwrap().status, "running");
        assert_eq!(repo.get("j1").unwrap().stage, "translate");
    }

    #[test]
    fn reset_stale_marks_running_as_queued() {
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        repo.upsert(&job("j1", "running")).unwrap();
        repo.upsert(&job("j2", "done")).unwrap();
        repo.reset_stale().unwrap();
        assert_eq!(repo.get("j1").unwrap().status, "queued", "running 应重置为 queued");
        assert_eq!(repo.get("j2").unwrap().status, "done", "done 不受影响");
    }

    #[test]
    fn remove() {
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        repo.upsert(&job("j1", "queued")).unwrap();
        repo.remove("j1").unwrap();
        assert!(repo.get("j1").is_none());
    }
}
