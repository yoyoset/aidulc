//! store/settings_repo.rs —— 阅读/显示设置唯一写者 (P2)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReaderSettings {
    pub profile_id: String,
    pub font_size: f64,
    pub line_height: f64,
    pub content_width: i64,
    pub font_family: String,
    pub theme: String,                 // light | dark
    pub highlight_granularity: String, // word | sentence
    pub child_mode: bool,
    pub updated_at: i64,
}

impl Default for ReaderSettings {
    fn default() -> Self {
        Self {
            profile_id: "default".into(),
            font_size: 18.0,
            line_height: 1.7,
            content_width: 760,
            font_family: "serif".into(),
            theme: "light".into(),
            highlight_granularity: "sentence".into(),
            child_mode: false,
            updated_at: 0,
        }
    }
}

pub struct SettingsRepo<'a> {
    db: &'a Db,
}

impl<'a> SettingsRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, s: &ReaderSettings) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reader_settings (profile_id, font_size, line_height, content_width,
                                          font_family, theme, highlight_granularity, child_mode, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(profile_id) DO UPDATE SET
                font_size = excluded.font_size, line_height = excluded.line_height,
                content_width = excluded.content_width, font_family = excluded.font_family,
                theme = excluded.theme, highlight_granularity = excluded.highlight_granularity,
                child_mode = excluded.child_mode, updated_at = excluded.updated_at",
            params![
                s.profile_id, s.font_size, s.line_height, s.content_width,
                s.font_family, s.theme, s.highlight_granularity,
                if s.child_mode { 1 } else { 0 }, s.updated_at
            ],
        )
        .map_err(|e| format!("写设置失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, profile_id: &str) -> ReaderSettings {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT profile_id, font_size, line_height, content_width, font_family,
                    theme, highlight_granularity, child_mode, updated_at
             FROM reader_settings WHERE profile_id = ?1",
            [profile_id],
            |r| {
                Ok(ReaderSettings {
                    profile_id: r.get(0)?,
                    font_size: r.get(1)?,
                    line_height: r.get(2)?,
                    content_width: r.get(3)?,
                    font_family: r.get(4)?,
                    theme: r.get(5)?,
                    highlight_granularity: r.get(6)?,
                    child_mode: r.get::<_, i64>(7)? != 0,
                    updated_at: r.get(8)?,
                })
            },
        )
        .ok()
        .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_st_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn default_when_missing() {
        let db = temp_db();
        let repo = SettingsRepo::new(&db);
        let s = repo.get("nobody");
        assert_eq!(s.font_size, 18.0);
        assert!(!s.child_mode);
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = SettingsRepo::new(&db);
        let s = ReaderSettings {
            profile_id: "kid".into(),
            font_size: 24.0,
            line_height: 2.0,
            content_width: 640,
            font_family: "sans".into(),
            theme: "dark".into(),
            highlight_granularity: "word".into(),
            child_mode: true,
            updated_at: 100,
        };
        repo.upsert(&s).unwrap();
        assert_eq!(repo.get("kid"), s);
    }
}
