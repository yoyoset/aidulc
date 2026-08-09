//! Atomic ownership operations for source/edition assets.

use crate::store;
use rusqlite::params;

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
    conn.execute(
        "DELETE FROM books WHERE id=?1 AND kind='original'",
        [source_id],
    )
    .map_err(|e| format!("删除原书失败: {e}"))?;
    Ok(packs)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        c.execute("INSERT INTO reading_state(book_key,chapter,position_ms,bookmarks,updated_at) VALUES('e',0,0,'[]',1)", []).unwrap();
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
            "INSERT INTO reading_state(book_key,chapter,position_ms,bookmarks,updated_at) VALUES('gone',0,0,'[]',1)",
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
}
