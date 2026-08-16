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
    /// K33 (2026-08-16, 用户拍板"讲解深度分档不够, 要能调字数和触发门槛"): 讲解字数
    /// 上限——替代之前硬编码在提示词里的"讲得啰嗦一点没关系"这类无约束描述(实测
    /// Wonder 一书 explain 阶段讲解中位数 512 字符, 是原文的 10.7 倍, 且拖慢生成
    /// 速度——见 docs/GOAL_2026-08-16_PERF.md)。
    #[serde(default = "default_explain_max_chars")]
    pub explain_max_chars: i64,
    /// K33: 讲解触发门槛——原文长度(字符数)低于这个值的句子不生成讲解, 直接跳过
    /// (跳过记为"跳过"不是"失败", 见 prep 侧 explain_sentences 的处理)。0 = 不设门槛,
    /// 全部句子都讲(等价旧行为)。
    #[serde(default)]
    pub explain_min_sentence_chars: i64,
}

fn default_explain_max_chars() -> i64 {
    150
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
            explain_max_chars: 150,
            explain_min_sentence_chars: 0,
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
            "INSERT INTO profiles (id, name, explain_strategy, voice, speed, highlight_granularity, explain_max_chars, explain_min_sentence_chars)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, explain_strategy = excluded.explain_strategy,
                voice = excluded.voice, speed = excluded.speed,
                highlight_granularity = excluded.highlight_granularity,
                explain_max_chars = excluded.explain_max_chars,
                explain_min_sentence_chars = excluded.explain_min_sentence_chars",
            params![
                p.id,
                p.name,
                p.explain_strategy,
                p.voice,
                p.speed,
                p.highlight_granularity,
                p.explain_max_chars,
                p.explain_min_sentence_chars
            ],
        )
        .map_err(|e| format!("写 profile 失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Profile> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, explain_strategy, voice, speed, highlight_granularity, explain_max_chars, explain_min_sentence_chars FROM profiles WHERE id = ?1",
            [id],
            |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    explain_strategy: r.get(2)?,
                    voice: r.get(3)?,
                    speed: r.get(4)?,
                    highlight_granularity: r.get(5)?,
                    explain_max_chars: r.get(6)?,
                    explain_min_sentence_chars: r.get(7)?,
                })
            },
        )
        .ok()
    }

    pub fn list(&self) -> Vec<Profile> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, explain_strategy, voice, speed, highlight_granularity, explain_max_chars, explain_min_sentence_chars FROM profiles ORDER BY id").unwrap();
        stmt.query_map([], |r| {
            Ok(Profile {
                id: r.get(0)?,
                name: r.get(1)?,
                explain_strategy: r.get(2)?,
                voice: r.get(3)?,
                speed: r.get(4)?,
                highlight_granularity: r.get(5)?,
                explain_max_chars: r.get(6)?,
                explain_min_sentence_chars: r.get(7)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// 删除档案 (M6). 调用方已 guard 内建档案; 引用该档案的旧书保留 id 字符串,
    /// 书卡对找不到的档案显示"未知档案"而非崩溃。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(|e| format!("删除档案失败: {e}"))?;
        Ok(())
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
            explain_max_chars: 150,
            explain_min_sentence_chars: 0,
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
            explain_max_chars: 150,
            explain_min_sentence_chars: 0,
        })
        .unwrap();
        repo.upsert(&Profile {
            id: "self".into(),
            name: "新".into(),
            explain_strategy: "deep".into(),
            voice: "v".into(),
            speed: 0.8,
            highlight_granularity: "word".into(),
            explain_max_chars: 200,
            explain_min_sentence_chars: 10,
        })
        .unwrap();
        assert_eq!(repo.get("self").unwrap().name, "新");
        assert_eq!(repo.get("self").unwrap().explain_strategy, "deep");
    }

    #[test]
    fn delete_removes_only_target() {
        let db = temp_db();
        let repo = ProfileRepo::new(&db);
        // 建库后先确保有默认档案 (迁移 v11 会 seed, 这里显式造一个"他人档案"作对照)
        repo.upsert(&Profile {
            id: "default".into(),
            name: "成人自读".into(),
            explain_strategy: "brief".into(),
            voice: "af_heart".into(),
            speed: 1.0,
            highlight_granularity: "sentence".into(),
            explain_max_chars: 150,
            explain_min_sentence_chars: 0,
        })
        .unwrap();
        repo.upsert(&Profile {
            id: "me".into(),
            name: "我的".into(),
            explain_strategy: "brief".into(),
            voice: "v".into(),
            speed: 1.0,
            highlight_granularity: "sentence".into(),
            explain_max_chars: 150,
            explain_min_sentence_chars: 0,
        })
        .unwrap();
        repo.delete("me").unwrap();
        assert!(repo.get("me").is_none());
        assert!(repo.get("default").is_some(), "其余档案不受影响");
    }
}
