//! Editions are the only writer for generated book assets.

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edition {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub pack_dir: String,
    pub profile_id: String,
    pub status: String,
    pub chapter_count: i64,
    pub failed_count: i64,
    pub last_opened_at: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub llm_id: Option<String>,
    pub tts_id: Option<String>,
    pub nlp_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct EditionsRepo<'a> {
    db: &'a Db,
}

impl<'a> EditionsRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    const COLS: &'static str = "id, source_id, title, pack_dir, profile_id, status,
        chapter_count, failed_count, last_opened_at, source_language, target_language,
        llm_id, tts_id, nlp_id, created_at, updated_at";

    fn row(r: &rusqlite::Row) -> rusqlite::Result<Edition> {
        Ok(Edition {
            id: r.get(0)?,
            source_id: r.get(1)?,
            title: r.get(2)?,
            pack_dir: r.get(3)?,
            profile_id: r.get(4)?,
            status: r.get(5)?,
            chapter_count: r.get(6)?,
            failed_count: r.get(7)?,
            last_opened_at: r.get(8)?,
            source_language: r.get(9)?,
            target_language: r.get(10)?,
            llm_id: r.get(11)?,
            tts_id: r.get(12)?,
            nlp_id: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
        })
    }

    pub fn upsert(&self, e: &Edition) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO editions (id,source_id,title,pack_dir,profile_id,status,chapter_count,failed_count,
                last_opened_at,source_language,target_language,llm_id,tts_id,nlp_id,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,
                pack_dir=excluded.pack_dir,profile_id=excluded.profile_id,status=excluded.status,
                chapter_count=excluded.chapter_count,failed_count=excluded.failed_count,
                source_language=excluded.source_language,target_language=excluded.target_language,
                llm_id=excluded.llm_id,tts_id=excluded.tts_id,nlp_id=excluded.nlp_id,
                updated_at=excluded.updated_at",
            params![e.id,e.source_id,e.title,e.pack_dir,e.profile_id,e.status,e.chapter_count,e.failed_count,
                e.last_opened_at,e.source_language,e.target_language,e.llm_id,e.tts_id,e.nlp_id,e.created_at,e.updated_at],
        ).map_err(|e| format!("写成品失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Edition> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {} FROM editions WHERE id=?1", Self::COLS),
            [id],
            Self::row,
        )
        .ok()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn find_by_asset_key(
        &self,
        source_id: &str,
        profile_id: &str,
        source_language: &str,
        target_language: &str,
        llm_id: Option<&str>,
        tts_id: Option<&str>,
        nlp_id: Option<&str>,
    ) -> Option<Edition> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM editions WHERE source_id=?1 AND profile_id=?2
            AND source_language=?3 AND target_language=?4 AND coalesce(llm_id,'')=coalesce(?5,'')
            AND coalesce(tts_id,'')=coalesce(?6,'') AND coalesce(nlp_id,'')=coalesce(?7,'')",
                Self::COLS
            ),
            params![
                source_id,
                profile_id,
                source_language,
                target_language,
                llm_id,
                tts_id,
                nlp_id
            ],
            Self::row,
        )
        .ok()
    }

    pub fn list_by_source(&self, source_id: &str) -> Vec<Edition> {
        let conn = self.db.conn.lock().unwrap();
        let mut s = conn
            .prepare(&format!(
                "SELECT {} FROM editions WHERE source_id=?1 ORDER BY updated_at DESC",
                Self::COLS
            ))
            .unwrap();
        s.query_map([source_id], Self::row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn list(&self) -> Vec<Edition> {
        let conn = self.db.conn.lock().unwrap();
        let mut s = conn
            .prepare(&format!(
                "SELECT {} FROM editions ORDER BY updated_at DESC",
                Self::COLS
            ))
            .unwrap();
        s.query_map([], Self::row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn find_by_pack_dir(&self, pack_dir: &str) -> Option<Edition> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {} FROM editions WHERE pack_dir=?1", Self::COLS),
            [pack_dir],
            Self::row,
        )
        .ok()
    }

    pub fn touch_opened(&self, id: &str, now: i64) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE editions SET last_opened_at=?1, updated_at=?1 WHERE id=?2",
            params![now, id],
        )
        .map_err(|e| format!("更新成品打开时间失败: {e}"))?;
        Ok(())
    }
}
