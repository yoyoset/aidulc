//! store/reading_repo.rs —— 阅读进度/书签/播放位置唯一写者

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadingState {
    pub book_key: String,
    pub chapter: i64,
    pub position_ms: i64,
    pub bookmarks: Vec<i64>, // 句下标
    // S5 (2026-08-08): 每章"已核对"句下标。JSON 对象 {章下标: [句下标,...]}。
    // 按章隔离(书签 Set 跨章串位 R4-1 是前车之鉴)。旧前端无此字段时反序列化容错为空对象。
    #[serde(default)]
    pub verified: std::collections::HashMap<String, Vec<i64>>,
    // M7 R18 (2026-08-08): 累计阅读时长 (播放计时, ms)。书架展示"共读多久"。
    #[serde(default)]
    pub time_spent_ms: i64,
}

pub struct ReadingRepo<'a> {
    db: &'a Db,
}

impl<'a> ReadingRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    /// M7 R37: 保存 + 按日记账 —— 先算 time_spent_ms 增量, 记到当天 (reading_daily)。
    /// 前端每次落盘传累计值, 这里负责把"这次多读的部分"分账到当天, 供"今日已读 X 分钟"统计。
    pub fn save_with_daily(&self, s: &ReadingState) -> Result<(), String> {
        let old = self.get(&s.book_key);
        let delta = match &old {
            Some(o) if s.time_spent_ms > o.time_spent_ms => s.time_spent_ms - o.time_spent_ms,
            _ => 0,
        };
        self.upsert(s)?;
        if delta > 0 {
            let day = crate::store::now_ms_for_store() / 86_400_000;
            self.add_daily_time(&s.book_key, day, delta)?;
        }
        Ok(())
    }

    /// 按日累计 (reading_daily, 幂等加法)
    pub fn add_daily_time(&self, book_key: &str, day: i64, delta_ms: i64) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reading_daily (book_key, day, time_spent_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT(book_key, day) DO UPDATE SET
                time_spent_ms = reading_daily.time_spent_ms + excluded.time_spent_ms",
            params![book_key, day, delta_ms],
        )
        .map_err(|e| format!("记当日阅读失败: {e}"))?;
        Ok(())
    }

    /// 某书在 [from_day, to_day] 的每日阅读时长 (含边界), 返回 [(day, ms)] 升序
    pub fn daily_times(&self, book_key: &str, from_day: i64, to_day: i64) -> Vec<(i64, i64)> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT day, time_spent_ms FROM reading_daily
                 WHERE book_key = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day",
            )
            .unwrap();
        stmt.query_map(params![book_key, from_day, to_day], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn upsert(&self, s: &ReadingState) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reading_state (book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(book_key) DO UPDATE SET
                chapter = excluded.chapter, position_ms = excluded.position_ms,
                bookmarks = excluded.bookmarks, verified = excluded.verified,
                time_spent_ms = excluded.time_spent_ms,
                updated_at = excluded.updated_at",
            params![
                s.book_key,
                s.chapter,
                s.position_ms,
                serde_json::to_string(&s.bookmarks).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&s.verified).unwrap_or_else(|_| "{}".to_string()),
                s.time_spent_ms,
                now
            ],
        )
        .map_err(|e| format!("写阅读状态失败: {e}"))?;
        Ok(())
    }

    pub fn get(&self, book_key: &str) -> Option<ReadingState> {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT book_key, chapter, position_ms, bookmarks, verified, time_spent_ms FROM reading_state WHERE book_key = ?1",
            [book_key],
            |r| {
                let bm: String = r.get(3)?;
                let vf: String = r.get(4)?;
                Ok(ReadingState {
                    book_key: r.get(0)?,
                    chapter: r.get(1)?,
                    position_ms: r.get(2)?,
                    bookmarks: serde_json::from_str(&bm).unwrap_or_default(),
                    verified: serde_json::from_str(&vf).unwrap_or_default(),
                    time_spent_ms: r.get(5)?,
                })
            },
        )
        .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_rd_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        let s = ReadingState {
            book_key: "alice_self".into(),
            chapter: 0,
            position_ms: 12345,
            bookmarks: vec![3, 7],
            verified: Default::default(),
            time_spent_ms: 90000,
        };
        repo.upsert(&s).unwrap();
        assert_eq!(repo.get("alice_self").unwrap(), s);
    }

    #[test]
    fn update_position() {
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        repo.upsert(&ReadingState {
            book_key: "k".into(),
            chapter: 0,
            position_ms: 100,
            bookmarks: vec![],
            verified: Default::default(),
            time_spent_ms: 0,
        })
        .unwrap();
        repo.upsert(&ReadingState {
            book_key: "k".into(),
            chapter: 1,
            position_ms: 500,
            bookmarks: vec![1],
            verified: Default::default(),
            time_spent_ms: 60000,
        })
        .unwrap();
        let got = repo.get("k").unwrap();
        assert_eq!(got.chapter, 1);
        assert_eq!(got.position_ms, 500);
        assert_eq!(got.bookmarks, vec![1]);
        assert_eq!(got.time_spent_ms, 60000, "阅读时长应持久化");
    }

    #[test]
    fn verified_roundtrip_per_chapter() {
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        let mut verified = std::collections::HashMap::new();
        verified.insert("0".to_string(), vec![2, 5, 9]);
        verified.insert("3".to_string(), vec![0]);
        repo.upsert(&ReadingState {
            book_key: "b".into(),
            chapter: 3,
            position_ms: 0,
            bookmarks: vec![],
            verified,
            time_spent_ms: 0,
        })
        .unwrap();
        let got = repo.get("b").unwrap().verified;
        assert_eq!(got.get("0").unwrap(), &vec![2, 5, 9]);
        assert_eq!(got.get("3").unwrap(), &vec![0]);
    }

    #[test]
    fn save_with_daily_records_delta_only() {
        // M7 R37: 累计值 100 → 150 只记 50 到当天; 无增量不记
        let db = temp_db();
        let repo = ReadingRepo::new(&db);
        let today = crate::store::now_ms_for_store() / 86_400_000;
        repo.save_with_daily(&ReadingState {
            book_key: "b".into(),
            chapter: 0,
            position_ms: 0,
            bookmarks: vec![],
            verified: Default::default(),
            time_spent_ms: 100,
        })
        .unwrap();
        repo.save_with_daily(&ReadingState {
            book_key: "b".into(),
            chapter: 0,
            position_ms: 0,
            bookmarks: vec![],
            verified: Default::default(),
            time_spent_ms: 150,
        })
        .unwrap();
        // 同值再存 → 不增
        repo.save_with_daily(&ReadingState {
            book_key: "b".into(),
            chapter: 0,
            position_ms: 0,
            bookmarks: vec![],
            verified: Default::default(),
            time_spent_ms: 150,
        })
        .unwrap();
        let daily = repo.daily_times("b", today, today);
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].1, 50, "只应记增量 50, 重复存不累计");
    }
}
