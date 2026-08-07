//! store/mod.rs —— SQLite 唯一真相源: WAL + busy_timeout + 顺序迁移

use rusqlite::Connection;
use std::sync::Mutex;

pub struct Db {
    pub conn: Mutex<Connection>,
}

/// 共享当前时间 (epoch ms), repo 层使用
pub fn now_ms_for_store() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &str) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("WAL 失败: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("busy_timeout 失败: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let db = Db {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // 版本表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )
        .map_err(|e| format!("建版本表失败: {e}"))?;
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE vocab (
                    key TEXT PRIMARY KEY,
                    word TEXT NOT NULL,
                    lemma TEXT NOT NULL,
                    pos TEXT NOT NULL DEFAULT '',
                    meaning TEXT NOT NULL DEFAULT '',
                    sense_id TEXT,
                    phonetic TEXT NOT NULL DEFAULT '',
                    context TEXT NOT NULL DEFAULT '',
                    level TEXT NOT NULL DEFAULT '',
                    collocations TEXT NOT NULL DEFAULT '[]',
                    stage TEXT NOT NULL DEFAULT 'new',
                    interval_days INTEGER NOT NULL DEFAULT 0,
                    ease_factor REAL NOT NULL DEFAULT 2.5,
                    next_review INTEGER,
                    reviews INTEGER NOT NULL DEFAULT 0,
                    added_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE dictionary (
                    key TEXT PRIMARY KEY,
                    word TEXT NOT NULL,
                    lemma TEXT NOT NULL,
                    pos TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL
                );
                CREATE TABLE profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    explain_strategy TEXT NOT NULL DEFAULT 'brief',
                    voice TEXT NOT NULL DEFAULT 'af_heart',
                    speed REAL NOT NULL DEFAULT 1.0,
                    highlight_granularity TEXT NOT NULL DEFAULT 'sentence'
                );
                CREATE TABLE reading_state (
                    book_key TEXT NOT NULL,
                    chapter INTEGER NOT NULL DEFAULT 0,
                    position_ms INTEGER NOT NULL DEFAULT 0,
                    bookmarks TEXT NOT NULL DEFAULT '[]',
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (book_key)
                );
                INSERT INTO schema_migrations (version, applied_at) VALUES (1, strftime('%s','now')*1000);
                ",
            )
            .map_err(|e| format!("迁移 v1 失败: {e}"))?;
        }
        // v2 (P1): 书库 + 阅读设置 + 任务表 (P4 也用)。vocab/dictionary 加 profile_id (P3)。
        if version < 2 {
            conn.execute_batch(
                "CREATE TABLE books (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    pack_dir TEXT NOT NULL,
                    profile_id TEXT NOT NULL DEFAULT 'self',
                    status TEXT NOT NULL DEFAULT 'ready',
                    chapter_count INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0,
                    last_opened_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE reader_settings (
                    profile_id TEXT PRIMARY KEY,
                    font_size REAL NOT NULL DEFAULT 18,
                    line_height REAL NOT NULL DEFAULT 1.7,
                    content_width INTEGER NOT NULL DEFAULT 760,
                    font_family TEXT NOT NULL DEFAULT 'serif',
                    theme TEXT NOT NULL DEFAULT 'light',
                    highlight_granularity TEXT NOT NULL DEFAULT 'sentence',
                    child_mode INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE jobs (
                    id TEXT PRIMARY KEY,
                    book_path TEXT NOT NULL,
                    profile_id TEXT NOT NULL DEFAULT 'self',
                    output_dir TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    stage TEXT NOT NULL DEFAULT '',
                    current INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                -- 旧表加 profile_id (P3 隔离; 默认 self 保持兼容)
                ALTER TABLE vocab ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'self';
                ALTER TABLE dictionary ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'self';
                INSERT INTO schema_migrations (version, applied_at) VALUES (2, strftime('%s','now')*1000);
                ",
            )
            .map_err(|e| format!("迁移 v2 失败: {e}"))?;
        }
        // v3 (M1): AIDU 无损兼容
        // 1. canonical profile: self → default (AIDU default)
        // 2. vocab 加 payload 列保存完整 canonical JSON (deepData/lastReview/lastGrade/浮点 interval 不丢失)
        //    dictionary 的 payload 列 v1 已有, 不再重复添加 (审查确认: 重复 ALTER 会报 duplicate column)
        if version < 3 {
            conn.execute_batch(
                "ALTER TABLE vocab ADD COLUMN payload TEXT;
                 UPDATE vocab SET profile_id = 'default' WHERE profile_id = 'self';
                 UPDATE dictionary SET profile_id = 'default' WHERE profile_id = 'self';
                 -- 重建 key 为 profile:lemma 形式 (M1: self:lemma → default:lemma)
                 UPDATE vocab SET key = 'default:' || lemma WHERE key NOT LIKE 'default:%' AND key NOT LIKE 'kid:%';
                 UPDATE dictionary SET key = 'default:' || lemma WHERE key NOT LIKE 'default:%' AND key NOT LIKE 'kid:%';
                 UPDATE books SET profile_id = 'default' WHERE profile_id = 'self';
                 UPDATE jobs SET profile_id = 'default' WHERE profile_id = 'self';
                 UPDATE reader_settings SET profile_id = 'default' WHERE profile_id = 'self';
                 -- 把现有 vocab 列内容序列化进 payload (回填, 保持旧数据可用)
                 UPDATE vocab SET payload = json_object(
                    'word', word, 'lemma', lemma, 'pos', pos, 'meaning', meaning,
                    'senseId', sense_id, 'phonetic', phonetic, 'context', context,
                    'level', level, 'collocations', json(collocations),
                    'stage', stage, 'interval', interval_days, 'easeFactor', ease_factor,
                    'nextReview', next_review, 'reviews', reviews,
                    'addedAt', added_at, 'updatedAt', updated_at
                 ) WHERE payload IS NULL;
                 -- dictionary payload 回填 (旧列有数据但 payload 为 NULL 的情况)
                 UPDATE dictionary SET payload = json_object(
                    'word', word, 'lemma', lemma, 'pos', pos
                 ) WHERE payload IS NULL;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (3, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v3 失败: {e}"))?;
        }
        // v4 (G2): 批量工作流 —— batches 表 + jobs.batch_id
        if version < 4 {
            conn.execute_batch(
                "CREATE TABLE batches (
                    id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL DEFAULT 'default',
                    source_language TEXT NOT NULL DEFAULT 'en',
                    target_language TEXT NOT NULL DEFAULT 'zh-CN',
                    status TEXT NOT NULL DEFAULT 'created',
                    total_books INTEGER NOT NULL DEFAULT 0,
                    done_books INTEGER NOT NULL DEFAULT 0,
                    failed_books INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                ALTER TABLE jobs ADD COLUMN batch_id TEXT;
                ALTER TABLE jobs ADD COLUMN source_language TEXT NOT NULL DEFAULT 'en';
                ALTER TABLE jobs ADD COLUMN target_language TEXT NOT NULL DEFAULT 'zh-CN';
                INSERT INTO schema_migrations (version, applied_at) VALUES (4, strftime('%s','now')*1000);
                ",
            )
            .map_err(|e| format!("迁移 v4 失败: {e}"))?;
        }
        // v5 (H1 模型管理): model_registry + wizard_state + books 语言/模型字段
        if version < 5 {
            conn.execute_batch(
                "CREATE TABLE model_registry (
                    id TEXT PRIMARY KEY,
                    family TEXT NOT NULL,          -- llm|tts|nlp
                    language TEXT NOT NULL,        -- en|zh|ja|*
                    model_id TEXT NOT NULL,
                    version TEXT,
                    variant TEXT,                  -- cuda12.4|cpu
                    path TEXT NOT NULL,
                    source_type TEXT NOT NULL,     -- hf|github|spacy|local
                    source_ref TEXT,
                    commit_sha TEXT,
                    sha256 TEXT,
                    size_bytes INTEGER,
                    installed_at INTEGER,
                    active INTEGER DEFAULT 0,      -- 推荐标记 (每 family+language 可多个)
                    custom INTEGER DEFAULT 0
                );
                CREATE TABLE wizard_state (
                    id TEXT PRIMARY KEY,
                    step INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'not_started',
                    updated_at INTEGER
                );
                -- 书级语言 + 模型绑定 (语言/模型跟随书)
                ALTER TABLE books ADD COLUMN source_language TEXT NOT NULL DEFAULT 'en';
                ALTER TABLE books ADD COLUMN target_language TEXT NOT NULL DEFAULT 'zh-CN';
                ALTER TABLE books ADD COLUMN llm_id TEXT;
                ALTER TABLE books ADD COLUMN tts_id TEXT;
                ALTER TABLE books ADD COLUMN nlp_id TEXT;
                INSERT INTO schema_migrations (version, applied_at) VALUES (5, strftime('%s','now')*1000);
                ",
            )
            .map_err(|e| format!("迁移 v5 失败: {e}"))?;
        }
        // v6 (I-C): 任务失败可读 —— jobs.error 摘要 (阶段+句数+原因)
        if version < 6 {
            conn.execute_batch(
                "ALTER TABLE jobs ADD COLUMN error TEXT;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (6, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v6 失败: {e}"))?;
        }
        // v7 (架构分离): books.kind — original(原版, 导入的管理对象) | product(AI 成品, 可阅读)
        // 现有 ready/partial 记录 → product (它们是有书包的成品); pending/processing → original
        if version < 7 {
            conn.execute_batch(
                "ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'original';
                 UPDATE books SET kind = 'product' WHERE status IN ('ready', 'partial');
                 INSERT INTO schema_migrations (version, applied_at) VALUES (7, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v7 失败: {e}"))?;
        }
        // v8 (资产模型): books.source_book_id — 成品关联原书 (不同模型=不同资产)
        if version < 8 {
            conn.execute_batch(
                "ALTER TABLE books ADD COLUMN source_book_id TEXT;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (8, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v8 失败: {e}"))?;
        }
        // v9 (进度算法): jobs.progress — 后端算全书完成度 (阶段权重, 0-100)
        if version < 9 {
            conn.execute_batch(
                "ALTER TABLE jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (9, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v9 失败: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("aidulc_mig_{name}_{}.db", std::process::id()))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn fresh_db_migrates_to_latest() {
        let path = temp_path("fresh");
        let _ = std::fs::remove_file(&path);
        let db = Db::open(&path).expect("空库迁移应成功");
        let conn = db.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(version >= 3, "应迁移到 v3, 实得 {version}");
        // 关键表存在
        for table in ["vocab", "dictionary", "books", "jobs", "reader_settings"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "表 {table} 应存在");
        }
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn legacy_db_upgrades_preserving_data() {
        // 模拟 v1 库 (旧表无 profile_id/payload), 然后打开触发迁移
        let path = temp_path("legacy");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE vocab (
                    key TEXT PRIMARY KEY,
                    word TEXT NOT NULL, lemma TEXT NOT NULL,
                    pos TEXT NOT NULL DEFAULT '', meaning TEXT NOT NULL DEFAULT '',
                    sense_id TEXT, phonetic TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
                    level TEXT NOT NULL DEFAULT '', collocations TEXT NOT NULL DEFAULT '[]',
                    stage TEXT NOT NULL DEFAULT 'new', interval_days INTEGER NOT NULL DEFAULT 0,
                    ease_factor REAL NOT NULL DEFAULT 2.5, next_review INTEGER,
                    reviews INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE dictionary (
                    key TEXT PRIMARY KEY,
                    word TEXT NOT NULL, lemma TEXT NOT NULL,
                    pos TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL
                );
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0);
                INSERT INTO vocab (key, word, lemma, pos, meaning, added_at, updated_at)
                    VALUES ('bank', 'bank', 'bank', 'NOUN', '河岸', 100, 100);
                ",
            )
            .unwrap();
            drop(conn);
        }
        // 打开触发 v2/v3 迁移
        let db = Db::open(&path).expect("历史库迁移应成功");
        let conn = db.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(version >= 3);
        // 旧数据保留且 profile 迁移为 default
        let row: (String, String, String) = conn
            .query_row(
                "SELECT key, profile_id, payload FROM vocab WHERE lemma='bank'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "default:bank", "key 应重建为 default:bank");
        assert_eq!(row.1, "default");
        assert!(row.2.contains("bank"), "payload 应回填");
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn reopen_is_idempotent() {
        // 迁移已完成后重新打开不应报错 (幂等)
        let path = temp_path("reopen");
        let _ = std::fs::remove_file(&path);
        for _ in 0..2 {
            let db = Db::open(&path).expect("重复打开应成功");
            drop(db);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }
}
