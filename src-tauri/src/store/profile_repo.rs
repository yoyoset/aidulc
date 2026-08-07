//! store/profile_repo.rs —— profile 唯一写者 (3.4 所有权表)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub explain_strategy: String, // none | brief | deep
    pub voice: String,
    pub speed: f64,
    pub highlight_granularity: String, // word | sentence
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: "default".into(), // M1: AIDU canonical profile (原 self 已迁移)
            name: "成人自读".into(),
            explain_strategy: "brief".into(),
            voice: "af_heart".into(),
            speed: 1.0,
            highlight_granularity: "sentence".into(),
        }
    }
}

pub struct ProfileRepo<'a> {
    db: &'a Db,
}

impl<'a> ProfileRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, p: &Profile) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO profiles (id, name, explain_strategy, voice, speed, highlight_granularity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, explain_strategy = excluded.explain_strategy,
                voice = excluded.voice, speed = excluded.speed,
                highlight_granularity = excluded.highlight_granularity",
            params![
                p.id,
                p.name,
                p.explain_strategy,
                p.voice,
                p.speed,
                p.highlight_granularity
            ],
        )
        .map_err(|e| format!("写 profile 失败: {e}"))?;
        Ok(())
    }

    // TODO(未接线): 写了测试(upsert_get_roundtrip)但没有 command 调用单条查询,
    // 目前界面可能只走 list。真要按 id 单查 profile 时再接线, 优先级低于其余 4 项功能缺口。
    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<Profile> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, explain_strategy, voice, speed, highlight_granularity FROM profiles WHERE id = ?1",
            [id],
            |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    explain_strategy: r.get(2)?,
                    voice: r.get(3)?,
                    speed: r.get(4)?,
                    highlight_granularity: r.get(5)?,
                })
            },
        )
        .ok()
    }

    pub fn list(&self) -> Vec<Profile> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, explain_strategy, voice, speed, highlight_granularity FROM profiles ORDER BY id").unwrap();
        stmt.query_map([], |r| {
            Ok(Profile {
                id: r.get(0)?,
                name: r.get(1)?,
                explain_strategy: r.get(2)?,
                voice: r.get(3)?,
                speed: r.get(4)?,
                highlight_granularity: r.get(5)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_pf_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = ProfileRepo::new(&db);
        let p = Profile {
            id: "kid".into(),
            name: "陪小孩读".into(),
            explain_strategy: "deep".into(),
            voice: "af_heart".into(),
            speed: 0.9,
            highlight_granularity: "word".into(),
        };
        repo.upsert(&p).unwrap();
        assert_eq!(repo.get("kid").unwrap(), p);
    }

    #[test]
    fn update_overwrites() {
        let db = temp_db();
        let repo = ProfileRepo::new(&db);
        repo.upsert(&Profile {
            id: "self".into(),
            name: "旧".into(),
            explain_strategy: "brief".into(),
            voice: "v".into(),
            speed: 1.0,
            highlight_granularity: "sentence".into(),
        })
        .unwrap();
        repo.upsert(&Profile {
            id: "self".into(),
            name: "新".into(),
            explain_strategy: "deep".into(),
            voice: "v".into(),
            speed: 0.8,
            highlight_granularity: "word".into(),
        })
        .unwrap();
        assert_eq!(repo.get("self").unwrap().name, "新");
        assert_eq!(repo.get("self").unwrap().explain_strategy, "deep");
    }
}
