//! Atomic ownership operations for source/edition assets.

use crate::store;
use rusqlite::params;
use std::collections::HashSet;
use std::path::Path;

/// Remove historical rows that no longer identify a source or edition.
/// This is deliberately conservative for jobs: a queued job with a valid source path
/// remains visible even when its output directory has not been created yet.
pub fn cleanup_orphans(db: &store::Db) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        conn.execute(
            "DELETE FROM reading_state WHERE book_key NOT IN (SELECT id FROM editions)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM reading_daily WHERE book_key NOT IN (SELECT id FROM editions)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM highlights WHERE book_key NOT IN (SELECT id FROM editions)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM jobs WHERE (edition_id IS NOT NULL AND edition_id NOT IN (SELECT id FROM editions))
                OR (edition_id IS NULL AND NOT EXISTS (
                    SELECT 1 FROM books b WHERE b.kind='original' AND b.source_path=jobs.book_path
                ) AND NOT EXISTS (
                    SELECT 1 FROM books b2 WHERE b2.kind='original' AND b2.id=jobs.source_id
                ) AND NOT EXISTS (
                    SELECT 1 FROM editions e WHERE e.pack_dir=jobs.output_dir
                ))",
            [],
        ).map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// 2026-08-09 无限成长修复: 清理磁盘上无主任务的 job 目录。
///
/// 背景: `out_dir/jobs/job-*` 每跑一次备料建一个, 里面是 checkpoint/句级 JSON、TTS 音频、
/// run.log —— 一本大书可达数百 MB。此前的删除路径要么只删 DB 行 (`job_remove`)、要么
/// 只删 bookpack 目录 (edition 删除), 失败/取消/移除过的任务目录永远留在磁盘上。
///
/// 安全边界: 只删 `out_dir/jobs/` 下以 `job-` 开头、且不被任何 job 行 / edition pack_dir
/// 引用的目录。成功产书的任务其目录 = edition.pack_dir, 被引用 → 保留。跑在启动早期
/// (队列泵起之前), 不存在"目录正被使用"的竞态。
pub fn cleanup_orphan_job_dirs(db: &store::Db, out_dir: &Path) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    let mut referenced: HashSet<String> = HashSet::new();
    let mut stmt = conn
        .prepare("SELECT output_dir FROM jobs")
        .map_err(|e| e.to_string())?;
    for d in stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .flatten()
    {
        referenced.insert(normalize_dir(&d));
    }
    drop(stmt);
    let mut stmt2 = conn
        .prepare("SELECT pack_dir FROM editions")
        .map_err(|e| e.to_string())?;
    for d in stmt2
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if !d.is_empty() {
            referenced.insert(normalize_dir(&d));
        }
    }
    drop(stmt2);
    drop(conn);

    let jobs_root = out_dir.join("jobs");
    let entries = match std::fs::read_dir(&jobs_root) {
        Ok(e) => e,
        Err(_) => return Ok(()), // 无 jobs 目录 = 无孤儿可清
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !name.starts_with("job-") {
            continue;
        }
        if !referenced.contains(&normalize_dir(&path.to_string_lossy())) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    Ok(())
}

/// 统一目录字符串格式: 反斜杠归一成正斜杠 + 去尾部斜杠, 让 DB 存的 output_dir/pack_dir
/// (Windows 上可能是 `C:\...`) 和 read_dir 读出的路径可比较。
fn normalize_dir(s: &str) -> String {
    let t = s.replace('\\', "/");
    t.trim_end_matches('/').to_string()
}

pub fn delete_edition(db: &store::Db, edition_id: &str) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().unwrap();
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut packs = Vec::new();
        let mut s = conn
            .prepare("SELECT pack_dir FROM editions WHERE id=?1")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([edition_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for p in rows.flatten() {
            if !p.is_empty() {
                packs.push(p);
            }
        }
        conn.execute("DELETE FROM reading_state WHERE book_key=?1", [edition_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM reading_daily WHERE book_key=?1", [edition_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM highlights WHERE book_key=?1", [edition_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM jobs WHERE edition_id=?1 OR output_dir IN (SELECT pack_dir FROM editions WHERE id=?1)", [edition_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM editions WHERE id=?1", [edition_id])
            .map_err(|e| e.to_string())?;
        packs.retain(|pack| {
            conn.query_row(
                "SELECT COUNT(*) FROM editions WHERE pack_dir=?1",
                [pack],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
                == 0
        });
        Ok::<_, String>(packs)
    })();
    match result {
        Ok(p) => {
            conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
            Ok(p)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

pub fn delete_source(db: &store::Db, source_id: &str) -> Result<Vec<String>, String> {
    let source_path = store::books_repo::BooksRepo::new(db)
        .get(source_id)
        .map(|b| b.source_path)
        .unwrap_or_default();
    let ids = store::editions_repo::EditionsRepo::new(db)
        .list_by_source(source_id)
        .into_iter()
        .map(|e| e.id)
        .collect::<Vec<_>>();
    let mut packs = Vec::new();
    for id in ids {
        packs.extend(delete_edition(db, &id)?);
    }
    let conn = db.conn.lock().unwrap();
    // BOOK_WORKFLOW §2.3: job 按 source_id 级联清理 (v19 起 job 显式关联 source);
    // 兼容历史行(book_path 关联)也一并清, 不靠单一列。
    if !source_path.is_empty() {
        conn.execute(
            "DELETE FROM jobs WHERE source_id=?1 OR book_path=?2",
            params![source_id, source_path],
        )
        .map_err(|e| format!("清理原书任务失败: {e}"))?;
    } else {
        conn.execute("DELETE FROM jobs WHERE source_id=?1", [source_id])
            .map_err(|e| format!("清理原书任务失败: {e}"))?;
    }
    // I3 (2026-08-11): 删书级联清批次 —— 只删已没有 job 的批次 (书都删了, 记录还在 = 僵尸)。
    conn.execute(
        "DELETE FROM batches WHERE NOT EXISTS (
            SELECT 1 FROM jobs WHERE jobs.batch_id = batches.id
        )",
        [],
    )
    .map_err(|e| format!("清理孤儿批次失败: {e}"))?;
    drop(conn);
    // G5 存储所有权: books 表只走 books_repo 删 (2026-08-09 从裸 SQL 改为接线 repo,
    // 消除 books_repo::remove 的 [allow(dead_code)])。v19+ books 表只剩 kind='original',
    // 与 delete_source 只删原书的语义一致。
    store::books_repo::BooksRepo::new(db).remove(source_id)?;
    Ok(packs)
}

/// I3 (2026-08-11): 启动期清理孤儿批次 —— 批次建了但没有任何 job (书可能已被删/导入失败),
/// 且**没有 running/queued/paused job** 的批次才删。安全边界: 不能只凭"书不存在"就删,
/// 必须确认该批次没有活跃 job, 否则会删掉正在跑的任务的账。启动早期调用 (与
/// cleanup_orphan_job_dirs 同阶段, 队列泵起之前)。
pub fn cleanup_orphan_batches(db: &store::Db) -> Result<usize, String> {
    let conn = db.conn.lock().unwrap();
    let deleted = conn
        .execute(
            "DELETE FROM batches WHERE NOT EXISTS (
                SELECT 1 FROM jobs WHERE jobs.batch_id = batches.id
            )",
            [],
        )
        .map_err(|e| format!("清理孤儿批次失败: {e}"))?;
    drop(conn);
    crate::infrastructure::log::info(
        "cleanup",
        &format!("清理孤儿批次 {deleted} 个 (无任何 job 引用)"),
    );
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_orphan_job_dirs_removes_unreferenced_keeps_referenced() {
        // 2026-08-09 无限成长修复回归: 无 job 行/edition 引用的 job-* 目录被清,
        // 被引用的保留。
        let root = std::env::temp_dir().join(format!("aidulc_orphan_dirs_{}", std::process::id()));
        let jobs = root.join("jobs");
        for d in ["job-gone", "job-kept-by-row", "job-kept-by-edition"] {
            let dir = jobs.join(d);
            std::fs::create_dir_all(dir.join("checkpoints")).unwrap();
            std::fs::write(dir.join("run.log"), "x").unwrap();
        }
        // 非 job- 前缀的目录绝不碰
        std::fs::create_dir_all(jobs.join("other")).unwrap();

        let path = root.join(format!("t{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs(id,book_path,profile_id,output_dir,created_at,updated_at)
             VALUES('j1','x','default',?1,1,1)",
            [jobs.join("job-kept-by-row").to_string_lossy().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO editions(id,source_id,title,pack_dir,profile_id,status,chapter_count,
                failed_count,source_language,target_language,created_at,updated_at)
             VALUES('e1','s','T',?1,'default','ready',1,0,'en','zh-CN',1,1)",
            [jobs
                .join("job-kept-by-edition")
                .to_string_lossy()
                .to_string()],
        )
        .unwrap();
        drop(conn);

        cleanup_orphan_job_dirs(&db, &root).unwrap();
        assert!(!jobs.join("job-gone").exists(), "无引用的孤儿目录应被删除");
        assert!(
            jobs.join("job-kept-by-row").exists(),
            "job 行引用的目录保留"
        );
        assert!(
            jobs.join("job-kept-by-edition").exists(),
            "edition 引用的目录保留"
        );
        assert!(jobs.join("other").exists(), "非 job- 前缀目录不碰");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn delete_edition_cleans_all_references() {
        let path = std::env::temp_dir().join(format!("aidulc_asset_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        store::editions_repo::EditionsRepo::new(&db)
            .upsert(&store::editions_repo::Edition {
                id: "e".into(),
                source_id: "s".into(),
                title: "T".into(),
                pack_dir: "p".into(),
                profile_id: "default".into(),
                status: "ready".into(),
                chapter_count: 1,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let c = db.conn.lock().unwrap();
        c.execute("INSERT INTO reading_state(user_id,book_key,chapter,position_ms,bookmarks,updated_at) VALUES('me','e',0,0,'[]',1)", []).unwrap();
        c.execute(
            "INSERT INTO reading_daily(book_key,day,time_spent_ms) VALUES('e',1,2)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO highlights(id,book_key,chapter,sentence_index,selected_text,note,created_at,updated_at) VALUES('h','e',0,0,'x','',1,1)", []).unwrap();
        c.execute("INSERT INTO jobs(id,edition_id,book_path,output_dir,created_at,updated_at) VALUES('j','e','x','p',1,1)", []).unwrap();
        drop(c);
        assert_eq!(delete_edition(&db, "e").unwrap(), vec!["p"]);
        let c = db.conn.lock().unwrap();
        for (t, key) in [
            ("reading_state", "book_key"),
            ("reading_daily", "book_key"),
            ("highlights", "book_key"),
            ("jobs", "edition_id"),
        ] {
            assert_eq!(
                c.query_row(
                    &format!("SELECT count(*) FROM {t} WHERE {key}='e'"),
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
    }

    #[test]
    fn cleanup_orphans_removes_unowned_rows_but_keeps_source_job() {
        let path = std::env::temp_dir().join(format!("aidulc_orphan_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        let c = db.conn.lock().unwrap();
        c.execute(
            "INSERT INTO reading_state(user_id,book_key,chapter,position_ms,bookmarks,updated_at) VALUES('me','gone',0,0,'[]',1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO jobs(id,book_path,profile_id,output_dir,created_at,updated_at) VALUES('orphan','missing.epub','default','missing-dir',1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO jobs(id,book_path,profile_id,output_dir,created_at,updated_at) VALUES('owned','source.epub','default','pending-dir',1,1)",
            [],
        )
        .unwrap();
        drop(c);
        store::books_repo::BooksRepo::new(&db)
            .upsert(&store::books_repo::Book {
                id: "source".into(),
                title: "Source".into(),
                source_path: "source.epub".into(),
                pack_dir: String::new(),
                profile_id: "default".into(),
                status: "pending".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        cleanup_orphans(&db).unwrap();
        let c = db.conn.lock().unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM reading_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM jobs WHERE id='orphan'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM jobs WHERE id='owned'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn shared_pack_is_not_removed_while_another_edition_uses_it() {
        let path =
            std::env::temp_dir().join(format!("aidulc_shared_pack_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        let repo = store::editions_repo::EditionsRepo::new(&db);
        for id in ["e1", "e2"] {
            repo.upsert(&store::editions_repo::Edition {
                id: id.into(),
                source_id: "s".into(),
                title: id.into(),
                pack_dir: "same".into(),
                profile_id: if id == "e1" { "default" } else { "kid" }.into(),
                status: "ready".into(),
                chapter_count: 1,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        }
        assert!(delete_edition(&db, "e1").unwrap().is_empty());
        assert!(repo.get("e2").is_some());
    }

    #[test]
    fn delete_source_cleans_jobs_by_source_id() {
        // BOOK_WORKFLOW §2.3: job 显式关联 source_id, 删除 source 按 source_id 级联清任务
        let path = std::env::temp_dir().join(format!("aidulc_srcid_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        store::books_repo::BooksRepo::new(&db)
            .upsert(&store::books_repo::Book {
                id: "src1".into(),
                title: "S".into(),
                source_path: "C:/s.epub".into(),
                pack_dir: String::new(),
                profile_id: "default".into(),
                status: "done".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        store::jobs_repo::JobsRepo::new(&db)
            .upsert(&store::jobs_repo::Job {
                id: "j1".into(),
                edition_id: None,
                source_id: Some("src1".into()),
                book_path: "C:/s.epub".into(),
                profile_id: "default".into(),
                output_dir: "out/j1".into(),
                status: "queued".into(),
                stage: String::new(),
                current: 0,
                total: 10,
                failed_count: 0,
                batch_id: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                error: None,
                progress: 0.0,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        delete_source(&db, "src1").unwrap();
        let c = db.conn.lock().unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM jobs WHERE id='j1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "删除 source 后其 job 应按 source_id 级联清理");
        let b: i64 = c
            .query_row("SELECT COUNT(*) FROM books WHERE id='src1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(b, 0);
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cleanup_orphan_batches_removes_only_batches_without_jobs() {
        // I3 (2026-08-11): 批次建了但没有任何 job (书可能已被删/导入失败) → 僵尸批次被清。
        let path =
            std::env::temp_dir().join(format!("aidulc_orphan_batch_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        let c = db.conn.lock().unwrap();
        // 孤儿批次: 无任何 job 引用
        c.execute(
            "INSERT INTO batches(id,profile_id,source_language,target_language,status,total_books,done_books,failed_books,created_at,updated_at)
             VALUES('batch-orphan','default','en','zh-CN','created',1,0,0,1,1)",
            [],
        )
        .unwrap();
        // 有 job 的批次: 保留
        c.execute(
            "INSERT INTO batches(id,profile_id,source_language,target_language,status,total_books,done_books,failed_books,created_at,updated_at)
             VALUES('batch-owned','default','en','zh-CN','running',1,0,0,1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO jobs(id,book_path,profile_id,output_dir,batch_id,created_at,updated_at)
             VALUES('j1','x','default','d','batch-owned',1,1)",
            [],
        )
        .unwrap();
        drop(c);

        let deleted = cleanup_orphan_batches(&db).unwrap();
        assert_eq!(deleted, 1, "只清无 job 引用的批次");
        let c = db.conn.lock().unwrap();
        assert!(
            c.query_row(
                "SELECT COUNT(*) FROM batches WHERE id='batch-orphan'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                == 0
        );
        assert!(
            c.query_row(
                "SELECT COUNT(*) FROM batches WHERE id='batch-owned'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                == 1,
            "有 job 的批次保留"
        );
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cleanup_orphan_batches_never_touches_batch_with_active_job() {
        // I3 安全边界 (2026-08-11): 不能只凭"书不存在"就删 —— 批次里有 running/queued/paused
        // job 时批次必须保留 (否则会删掉正在跑的任务的账)。这里构造"批次在但书不在" +
        // job running → 批次不被清。
        let path =
            std::env::temp_dir().join(format!("aidulc_orphan_active_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = store::Db::open(path.to_str().unwrap()).unwrap();
        let c = db.conn.lock().unwrap();
        c.execute(
            "INSERT INTO batches(id,profile_id,source_language,target_language,status,total_books,done_books,failed_books,created_at,updated_at)
             VALUES('batch-running','default','en','zh-CN','running',1,0,0,1,1)",
            [],
        )
        .unwrap();
        // job 关联这个批次, status=running (活跃)
        c.execute(
            "INSERT INTO jobs(id,book_path,profile_id,output_dir,batch_id,status,created_at,updated_at)
             VALUES('j1','x','default','d','batch-running','running',1,1)",
            [],
        )
        .unwrap();
        drop(c);

        cleanup_orphan_batches(&db).unwrap();
        let c = db.conn.lock().unwrap();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM batches WHERE id='batch-running'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "有活跃 job 的批次绝不能被清 (会丢正在跑的任务的账)");
        drop(c);
        let _ = std::fs::remove_file(&path);
    }
}
