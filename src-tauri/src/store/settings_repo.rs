//! store/settings_repo.rs —— 阅读/显示设置唯一写者 (P2)

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReaderSettings {
    /// K8 (2026-08-14): 主键从单 profile_id 改复合 (user_id, profile_id) ——
    /// 旧数据没有 user 概念, serde default 回填 'me' 兼容存量前端请求体。
    #[serde(default = "default_user_id")]
    pub user_id: String,
    pub profile_id: String,
    pub font_size: f64,
    pub line_height: f64,
    pub content_width: i64,
    pub font_family: String,
    pub theme: String,                 // light | dark (明暗)
    pub highlight_granularity: String, // word | sentence
    pub child_mode: bool,
    // S5 三模式阅读器 (2026-08-08): 新增持久状态。旧前端(没有这几个字段)升级时
    // 反序列化必须容错, 所以加 #[serde(default=...)] 引用默认函数 —— 否则旧版 reader
    // 存的对象解析失败; 且 String 用裸 #[serde(default)] 会落到空串而非语义默认值。
    #[serde(default = "default_display_mode")]
    pub display_mode: String, // guess | silent | bench (先答后核 / 静默正文 / 对照台)
    #[serde(default = "default_pace")]
    pub pace: String, // flow | sentence (通篇 / 逐句跟读)
    #[serde(default = "default_preset")]
    pub preset: String, // first | shadow | blind (初听 / 跟读 / 盲跟)
    #[serde(default = "default_speed")]
    pub speed: f64, // 播放变速 (跟读预设或手动微调)
    // M7 (2026-08-08): 主题色系 —— clay 陶土 / sage 青苔 / ocean 海蓝 / rose 蔷薇 / slate 灰蓝
    #[serde(default = "default_palette")]
    pub palette: String,
    // M7 R23 (2026-08-08): 自定义强调色 (palette='custom' 时用, #rrggbb)
    #[serde(default)]
    pub custom_color: String,
    pub updated_at: i64,
}

fn default_palette() -> String {
    "clay".into()
}

fn default_user_id() -> String {
    crate::store::users_repo::DEFAULT_USER_ID.to_string()
}

fn default_speed() -> f64 {
    1.0
}

fn default_display_mode() -> String {
    "guess".into()
}

fn default_pace() -> String {
    "flow".into()
}

fn default_preset() -> String {
    "shadow".into()
}

impl Default for ReaderSettings {
    fn default() -> Self {
        Self {
            user_id: default_user_id(),
            profile_id: "default".into(),
            font_size: 18.0,
            line_height: 1.7,
            content_width: 760,
            font_family: "serif".into(),
            theme: "light".into(),
            highlight_granularity: "sentence".into(),
            child_mode: false,
            display_mode: "guess".into(),
            pace: "flow".into(),
            preset: "shadow".into(),
            speed: 1.0,
            palette: "clay".into(),
            custom_color: String::new(),
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
            "INSERT INTO reader_settings (user_id, profile_id, font_size, line_height, content_width,
                                          font_family, theme, highlight_granularity, child_mode,
                                          display_mode, pace, preset, speed, palette, custom_color, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(user_id, profile_id) DO UPDATE SET
                font_size = excluded.font_size, line_height = excluded.line_height,
                content_width = excluded.content_width, font_family = excluded.font_family,
                theme = excluded.theme, highlight_granularity = excluded.highlight_granularity,
                child_mode = excluded.child_mode,
                display_mode = excluded.display_mode, pace = excluded.pace,
                preset = excluded.preset, speed = excluded.speed,
                palette = excluded.palette, custom_color = excluded.custom_color,
                updated_at = excluded.updated_at",
            params![
                s.user_id,
                s.profile_id,
                s.font_size,
                s.line_height,
                s.content_width,
                s.font_family,
                s.theme,
                s.highlight_granularity,
                if s.child_mode { 1 } else { 0 },
                s.display_mode,
                s.pace,
                s.preset,
                s.speed,
                s.palette,
                s.custom_color,
                s.updated_at
            ],
        )
        .map_err(|e| format!("写设置失败: {e}"))?;
        Ok(())
    }

    /// K8 (2026-08-14): 按 (user_id, profile_id) 取——之前只按 profile_id, 多用户
    /// 共享一台设备时阅读显示设置会互相覆盖。
    pub fn get(&self, user_id: &str, profile_id: &str) -> ReaderSettings {
        let conn = self.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT user_id, profile_id, font_size, line_height, content_width, font_family,
                    theme, highlight_granularity, child_mode,
                    display_mode, pace, preset, speed, palette, custom_color, updated_at
             FROM reader_settings WHERE user_id = ?1 AND profile_id = ?2",
            params![user_id, profile_id],
            |r| {
                Ok(ReaderSettings {
                    user_id: r.get(0)?,
                    profile_id: r.get(1)?,
                    font_size: r.get(2)?,
                    line_height: r.get(3)?,
                    content_width: r.get(4)?,
                    font_family: r.get(5)?,
                    theme: r.get(6)?,
                    highlight_granularity: r.get(7)?,
                    child_mode: r.get::<_, i64>(8)? != 0,
                    display_mode: r.get(9)?,
                    pace: r.get(10)?,
                    preset: r.get(11)?,
                    speed: r.get(12)?,
                    palette: r.get(13)?,
                    custom_color: r.get(14)?,
                    updated_at: r.get(15)?,
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
        let s = repo.get("me", "nobody");
        assert_eq!(s.font_size, 18.0);
        assert!(!s.child_mode);
    }

    #[test]
    fn upsert_get_roundtrip() {
        let db = temp_db();
        let repo = SettingsRepo::new(&db);
        let s = ReaderSettings {
            user_id: "me".into(),
            profile_id: "kid".into(),
            font_size: 24.0,
            line_height: 2.0,
            content_width: 640,
            font_family: "sans".into(),
            theme: "dark".into(),
            highlight_granularity: "word".into(),
            child_mode: true,
            display_mode: "bench".into(),
            pace: "sentence".into(),
            preset: "blind".into(),
            speed: 0.8,
            palette: "ocean".into(),
            custom_color: "#3b6b8a".into(),
            updated_at: 100,
        };
        repo.upsert(&s).unwrap();
        assert_eq!(repo.get("me", "kid"), s);
    }

    #[test]
    fn user_isolation_same_profile() {
        // K8 (2026-08-14): 不同 user 用同一个 profile_id(如都用默认 profile),
        // 阅读显示设置互不覆盖——修复前的核心 bug。
        let db = temp_db();
        let repo = SettingsRepo::new(&db);
        let mut mine = ReaderSettings::default();
        mine.user_id = "me".into();
        mine.profile_id = "default".into();
        mine.font_size = 18.0;
        let mut kids = ReaderSettings::default();
        kids.user_id = "u-kid".into();
        kids.profile_id = "default".into();
        kids.font_size = 27.0;
        kids.child_mode = true;
        repo.upsert(&mine).unwrap();
        repo.upsert(&kids).unwrap();
        assert_eq!(repo.get("me", "default").font_size, 18.0);
        assert!(!repo.get("me", "default").child_mode);
        assert_eq!(repo.get("u-kid", "default").font_size, 27.0);
        assert!(repo.get("u-kid", "default").child_mode);
    }

    #[test]
    fn missing_new_fields_deserialize_to_defaults() {
        // 旧前端存的对象没有 S5/M7 新字段, 反序列化必须容错回退默认值 (serde default)
        let raw = serde_json::json!({
            "profile_id": "legacy",
            "font_size": 18.0,
            "line_height": 1.7,
            "content_width": 760,
            "font_family": "serif",
            "theme": "light",
            "highlight_granularity": "sentence",
            "child_mode": false,
            "updated_at": 0
        });
        let parsed: ReaderSettings = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.user_id, "me", "旧前端无 user_id, 应回填 'me' (K8)");
        assert_eq!(parsed.display_mode, "guess");
        assert_eq!(parsed.pace, "flow");
        assert_eq!(parsed.preset, "shadow");
        assert_eq!(parsed.speed, 1.0);
        assert_eq!(parsed.palette, "clay");
        assert_eq!(parsed.custom_color, "", "旧前端无 custom_color, 应为空");
    }
}
