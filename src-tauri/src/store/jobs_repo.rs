//! store/jobs_repo.rs —— 任务表唯一写者 (P4 + G2: batch_id / 多语言预留)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// N6b (2026-08-10): 任务列表返回上限 —— 表行不再无界返回 (UI 按批次分组展示,
/// 封顶防全表扫)。代价: 超过窗口的旧任务不在列表里, 但它们仍留在 DB 直到过期清理。
pub const JOBS_LIST_LIMIT: i64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Job {
    pub id: String,
    #[serde(default)]
    pub edition_id: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>, // BOOK_WORKFLOW §2.3: job 显式关联 source
    pub book_path: String,
    pub profile_id: String,
    pub output_dir: String,
    pub status: String, // queued | running | paused | done | failed | canceled
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
            "INSERT INTO jobs (id, edition_id, source_id, book_path, profile_id, output_dir, status, stage,
                               current, total, failed_count, batch_id, source_language, target_language,
                               error, progress, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status, stage = excluded.stage,
                current = excluded.current, total = excluded.total,
                failed_count = excluded.failed_count, batch_id = excluded.batch_id,
                error = excluded.error, progress = excluded.progress,
                edition_id = excluded.edition_id, source_id = excluded.source_id,
                updated_at = excluded.updated_at",
            params![
                j.id, j.edition_id, j.source_id, j.book_path, j.profile_id, j.output_dir, j.status, j.stage,
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
            edition_id: r.get(1)?,
            source_id: r.get(2)?,
            book_path: r.get(3)?,
            profile_id: r.get(4)?,
            output_dir: r.get(5)?,
            status: r.get(6)?,
            stage: r.get(7)?,
            current: r.get(8)?,
            total: r.get(9)?,
            failed_count: r.get(10)?,
            batch_id: r.get(11)?,
            source_language: r.get(12)?,
            target_language: r.get(13)?,
            error: r.get(14)?,
            progress: r.get(15)?,
            created_at: r.get(16)?,
            updated_at: r.get(17)?,
        })
    }

    const COLS: &'static str = "id, edition_id, source_id, book_path, profile_id, output_dir, status, stage,
                                current, total, failed_count, batch_id, source_language, target_language,
                                error, progress, created_at, updated_at";

    pub fn get(&self, id: &str) -> Option<Job> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {} FROM jobs WHERE id = ?1", Self::COLS),
            [id],
            Self::row_to_job,
        )
        .ok()
    }

    pub fn list(&self) -> Vec<Job> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM jobs ORDER BY created_at DESC LIMIT ?1",
                Self::COLS
            ))
            .unwrap();
        stmt.query_map([JOBS_LIST_LIMIT], Self::row_to_job)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// N6b (2026-08-10): 清理终态 (done/failed/canceled) 且超过保留期的任务行。
    /// 安全边界:
    /// - 不删 queued/running (可能有启动恢复队列 / 进行中任务);
    /// - 不删仍被 edition 引用的 job 行 (edition_id 指向存在的 edition) —— 那些是
    ///   "这本书怎么生成的"追溯记录; 且 cleanup_orphan_job_dirs 靠 job 行 + edition
    ///   pack_dir 判断孤儿目录, 删了 edition 关联的 job 行可能让共享目录被误清。
    ///
    /// 用 `NOT EXISTS` 而不是 `NOT IN (SELECT id FROM editions)`: SQLite 里非 INTEGER 的
    /// `PRIMARY KEY` **不隐含 NOT NULL**(editions.id 是 `TEXT PRIMARY KEY`, 见 store_mod.rs
    /// 建表), editions 里只要有一行 id 为 NULL, `NOT IN` 就对**非空 edition_id** 求值为
    /// NULL → 那些 edition_id 悬空(指向已删 edition)的终态任务行永远清不掉, 且不报错。
    ///
    /// 实测修正(2026-08-10, 先写测试再改才发现): 最初以为"整条清理静默失效", 实际不是
    /// —— `edition_id IS NULL` 的行走的是 OR 的第一个分支, 照删不误; 真正受影响的只有
    /// **悬空 edition_id** 那一类。第一版测试用 NULL edition_id 构造, 拿旧 SQL 跑照样绿
    /// (空测试), 改成悬空 id 才真的红。`NOT EXISTS` 对 NULL 安全, 且 edition_id 为 NULL
    /// 时相关子查询无行 → 同样判为"无 edition 引用", 语义与原来一致。
    pub fn cleanup_old(&self, keep_days: i64) -> Result<usize, String> {
        let conn = self.db.conn.lock().unwrap();
        let cutoff = crate::store::now_ms_for_store() - keep_days * 86_400_000;
        conn.execute(
            "DELETE FROM jobs
             WHERE status IN ('done','failed','canceled') AND updated_at < ?1
               AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.id = jobs.edition_id)",
            [cutoff],
        )
        .map_err(|e| format!("清理旧任务失败: {e}"))
    }

    pub fn list_by_batch(&self, batch_id: &str) -> Vec<Job> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM jobs WHERE batch_id = ?1 ORDER BY created_at",
                Self::COLS
            ))
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

    pub fn attach_edition(&self, job_id: &str, edition_id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET edition_id=?1, updated_at=?2 WHERE id=?3",
            params![edition_id, crate::store::now_ms_for_store(), job_id],
        )
        .map_err(|e| format!("关联成品失败: {e}"))?;
        Ok(())
    }

    /// 重启恢复 (P0-A, 2026-08-10): 把上次退出时卡在 running 的任务标记为 **paused**,
    /// **不**自动重新排队。
    ///
    /// 为什么不是 queued: 启动时 pump_queue 会立刻把 queued 任务拉起来, 而侧车是
    /// 66MB PyInstaller 一次性解包 + 模型加载, 足够把整机(含 WebView 窗口)拖到"未响应"
    /// —— 真机实测桌面端"点几个 tab 后整窗未响应"就是这个路径 (DB 证据: 卡住的 running
    /// 任务每次启动都被 reset 成 queued 再立刻被 pump 成 running, run.log 停在旧时间戳
    /// 说明侧车还没解包完就被强杀)。
    ///
    /// 改成 paused: 恢复动作交还用户 (与"暂停→继续"同一语义), 侧车不在启动时被偷偷拉起;
    /// 用户在处理台点"继续"才真正重启。保留 stage/current/total/progress (不重置),
    /// 暂停行能显示"⏸ 讲解 1234/21972", 用户一眼知道断在哪。
    pub fn reset_stale(&self) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'paused', error = NULL,
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
            edition_id: None,
            source_id: Some("source-b".into()),
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
    fn reset_stale_marks_running_as_paused_not_queued() {
        // P0-A (2026-08-10): 启动恢复不得自动开跑 —— running → paused (用户点"继续"
        // 才重启), 不能是 queued (会被 pump_queue 在启动时立刻拉起, 侧车解包+加载模型
        // 把整机拖到未响应, 真机实测复现过)。
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        let mut j = job("j1", "running");
        j.stage = "explain".into();
        j.current = 1234;
        j.total = 21972;
        j.progress = 55.0;
        repo.upsert(&j).unwrap();
        repo.upsert(&job("j2", "done")).unwrap();
        repo.reset_stale().unwrap();
        let j1 = repo.get("j1").unwrap();
        assert_eq!(
            j1.status, "paused",
            "running 应重置为 paused, 不能是 queued (启动自动开跑的根因)"
        );
        assert_eq!(j1.stage, "explain", "暂停后保留断点阶段 (UI 显示⏸ 断在哪)");
        assert_eq!(j1.current, 1234, "暂停后保留断点进度");
        assert_eq!(j1.total, 21972);
        assert_eq!(j1.progress, 55.0, "暂停后保留全书完成度");
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

    #[test]
    fn list_is_capped_at_limit() {
        // N6b (2026-08-10): list() 有 LIMIT, 表行不再无界返回
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        for i in 0..(JOBS_LIST_LIMIT + 10) {
            let mut j = job(&format!("j{i}"), "done");
            j.created_at = now + i;
            repo.upsert(&j).unwrap();
        }
        assert_eq!(repo.list().len() as i64, JOBS_LIST_LIMIT);
    }

    #[test]
    fn cleanup_old_keeps_edition_linked_and_active() {
        // N6b (2026-08-10): 只删"终态 + 超保留期 + 无 edition 引用"的任务行
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        // 过期 done 无 edition → 删
        let mut old_done = job("old_done", "done");
        old_done.updated_at = now - 40 * 86_400_000;
        repo.upsert(&old_done).unwrap();
        // 过期 done 但 edition 仍存在 → 保留
        let mut old_linked = job("old_linked", "done");
        old_linked.updated_at = now - 40 * 86_400_000;
        old_linked.edition_id = Some("e1".into());
        repo.upsert(&old_linked).unwrap();
        // 过期 running → 保留 (启动恢复队列)
        let mut old_run = job("old_run", "running");
        old_run.updated_at = now - 40 * 86_400_000;
        repo.upsert(&old_run).unwrap();
        // 未过期 done → 保留
        let mut fresh_done = job("fresh_done", "done");
        fresh_done.updated_at = now - 86_400_000;
        repo.upsert(&fresh_done).unwrap();
        // e1 必须是存在的 edition
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO editions(id,source_id,title,pack_dir,profile_id,status,chapter_count,
                failed_count,source_language,target_language,created_at,updated_at)
             VALUES('e1','s','T','p','default','ready',1,0,'en','zh-CN',1,1)",
            [],
        )
        .unwrap();
        drop(conn);
        repo.cleanup_old(30).unwrap();
        assert!(repo.get("old_done").is_none(), "过期无引用 done 应被清");
        assert!(repo.get("old_linked").is_some(), "edition 引用的 job 保留");
        assert!(repo.get("old_run").is_some(), "running 保留");
        assert!(repo.get("fresh_done").is_some(), "未过期 done 保留");
    }

    #[test]
    fn cleanup_old_still_works_when_editions_has_null_id() {
        // 2026-08-10 加固: editions.id 是 TEXT PRIMARY KEY, SQLite 里不隐含 NOT NULL。
        // editions 有 NULL id 时, 旧的 `NOT IN (SELECT id FROM editions)` 对**悬空
        // edition_id** 求值为 NULL → 那类行永远清不掉。必须用悬空 id 构造才测得出来:
        // 拿 edition_id=NULL 构造的话走 OR 第一个分支, 旧 SQL 也是绿的(实测踩过)。
        let db = temp_db();
        let repo = JobsRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        // 过期 done + edition_id 悬空 (指向已删 edition) → 应被清
        let mut old_done = job("old_done", "done");
        old_done.updated_at = now - 40 * 86_400_000;
        old_done.edition_id = Some("gone".into());
        repo.upsert(&old_done).unwrap();
        let mut old_linked = job("old_linked", "done");
        old_linked.updated_at = now - 40 * 86_400_000;
        old_linked.edition_id = Some("e1".into());
        repo.upsert(&old_linked).unwrap();

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO editions(id,source_id,title,pack_dir,profile_id,status,chapter_count,
                failed_count,source_language,target_language,created_at,updated_at)
             VALUES('e1','s','T','p','default','ready',1,0,'en','zh-CN',1,1)",
            [],
        )
        .unwrap();
        // 关键: 一行 id 为 NULL 的 edition (SQLite 允许, 见上面的注释)。
        // source_id 用 's2' 避开 uq_editions_asset (source_id+profile+语言+模型 唯一)。
        conn.execute(
            "INSERT INTO editions(id,source_id,title,pack_dir,profile_id,status,chapter_count,
                failed_count,source_language,target_language,created_at,updated_at)
             VALUES(NULL,'s2','T2','p2','default','ready',1,0,'en','zh-CN',1,1)",
            [],
        )
        .unwrap();
        drop(conn);

        repo.cleanup_old(30).unwrap();
        assert!(
            repo.get("old_done").is_none(),
            "editions 里有 NULL id 时, 悬空 edition_id 的过期任务行仍必须被清 (NOT IN 写法清不掉)"
        );
        assert!(
            repo.get("old_linked").is_some(),
            "edition 引用的 job 仍保留"
        );
    }
}
