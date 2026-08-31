//! store/mod.rs —— SQLite 唯一真相源: WAL + busy_timeout + 顺序迁移

use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::sync::Mutex;

fn copy_pack_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_pack_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

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
        type LegacyProduct = (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
            Option<i64>,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            i64,
            Option<String>,
        );
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
        // v10 (S5 三模式阅读器, 2026-08-08): reader_settings 加三种显示模式/节奏/跟读预设/
        // 播放速度; reading_state 加 verified —— 每章"已核对"句子下标, 支持"再次读到已核对过"
        // 的轻量复习调度。verified 存 JSON 对象 {章下标: [句下标,...]}, 按章隔离避免跨章串位。
        if version < 10 {
            conn.execute_batch(
                "ALTER TABLE reader_settings ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'guess';
                 ALTER TABLE reader_settings ADD COLUMN pace TEXT NOT NULL DEFAULT 'flow';
                 ALTER TABLE reader_settings ADD COLUMN preset TEXT NOT NULL DEFAULT 'shadow';
                 ALTER TABLE reader_settings ADD COLUMN speed REAL NOT NULL DEFAULT 1.0;
                 ALTER TABLE reading_state ADD COLUMN verified TEXT NOT NULL DEFAULT '{}';
                 INSERT INTO schema_migrations (version, applied_at) VALUES (10, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v10 失败: {e}"))?;
        }
        // v11 (M6 Profile 系统, 2026-08-08): seed 两个内建档案 —— profiles 表此前是空架子
        // (F14), 档案管理 UI 需要默认/儿童档案真实存在, 导入卡/书卡才能查到它们的参数。
        // INSERT OR IGNORE 幂等, 用户已自建的同名档案不被覆盖。
        if version < 11 {
            conn.execute_batch(
                "INSERT OR IGNORE INTO profiles (id, name, explain_strategy, voice, speed, highlight_granularity)
                   VALUES ('default', '成人自读', 'brief', 'af_heart', 1.0, 'sentence');
                 INSERT OR IGNORE INTO profiles (id, name, explain_strategy, voice, speed, highlight_granularity)
                   VALUES ('kid', '陪小孩读', 'deep', 'af_heart', 0.9, 'word');
                 INSERT INTO schema_migrations (version, applied_at) VALUES (11, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v11 失败: {e}"))?;
        }
        // v12 (M7 主题自定义, 2026-08-08): reader_settings 加 palette —— 主题从
        // theme(light|dark 单布尔)扩展为 mode(明暗) × palette(色系)两维。默认 clay(陶土)。
        if version < 12 {
            conn.execute_batch(
                "ALTER TABLE reader_settings ADD COLUMN palette TEXT NOT NULL DEFAULT 'clay';
                 INSERT INTO schema_migrations (version, applied_at) VALUES (12, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v12 失败: {e}"))?;
        }
        // v13 (M7 R16 摘录标注, 2026-08-08): highlights 表 —— 精读时划句留痕。
        // sentence_index 指向章节内句序 (与 reading_state.bookmarks 同语义);
        // selected_text 是摘录的文字 (展示用); 精确词范围 span 渲染是后续工作。
        if version < 13 {
            conn.execute_batch(
                "CREATE TABLE highlights (
                    id TEXT PRIMARY KEY,
                    book_key TEXT NOT NULL,
                    chapter INTEGER NOT NULL,
                    sentence_index INTEGER NOT NULL,
                    selected_text TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX idx_highlights_book ON highlights (book_key, chapter);
                 INSERT INTO schema_migrations (version, applied_at) VALUES (13, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v13 失败: {e}"))?;
        }
        // v14 (M7 R18 阅读时长, 2026-08-08): reading_state 加累计阅读时长 (播放计时),
        // 书架展示"已读至第几章 · 共读多久"的进度反馈。
        if version < 14 {
            conn.execute_batch(
                "ALTER TABLE reading_state ADD COLUMN time_spent_ms INTEGER NOT NULL DEFAULT 0;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (14, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v14 失败: {e}"))?;
        }
        // v15 (M7 R21 摘录 span 高亮, 2026-08-08): highlights 加 start_seg/end_seg ——
        // 记录选区覆盖的 seg 区间, 渲染时精确标出选中的词 (null = 整句标记, 兼容旧数据)。
        if version < 15 {
            conn.execute_batch(
                "ALTER TABLE highlights ADD COLUMN start_seg INTEGER;
                 ALTER TABLE highlights ADD COLUMN end_seg INTEGER;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (15, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v15 失败: {e}"))?;
        }
        // v16 (M7 R23 自定义主题色, 2026-08-08): reader_settings 加 custom_color ——
        // palette='custom' 时用这个 #rrggbb 推导整套强调色 (前端纯函数, 见 reader/core/theme.js)。
        if version < 16 {
            conn.execute_batch(
                "ALTER TABLE reader_settings ADD COLUMN custom_color TEXT NOT NULL DEFAULT '';
                 INSERT INTO schema_migrations (version, applied_at) VALUES (16, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v16 失败: {e}"))?;
        }
        // v17 (M7 R37 阅读时长按日, 2026-08-08): reading_daily 表 —— reading_save 时把
        // time_spent_ms 的增量记到当天 (day = epoch 天数), 支持"今日已读 X 分钟/近 N 天"统计。
        if version < 17 {
            conn.execute_batch(
                "CREATE TABLE reading_daily (
                    book_key TEXT NOT NULL,
                    day INTEGER NOT NULL,
                    time_spent_ms INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (book_key, day)
                );
                 INSERT INTO schema_migrations (version, applied_at) VALUES (17, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v17 失败: {e}"))?;
        }
        // v18: generated assets leave books. The migration is deliberately data-driven:
        // malformed legacy source links get a stable synthetic source instead of being lost.
        if version < 18 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v18 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                conn.execute_batch("CREATE TABLE IF NOT EXISTS editions (
                    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL,
                    pack_dir TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT 'default',
                    status TEXT NOT NULL DEFAULT 'ready', chapter_count INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0, last_opened_at INTEGER,
                    source_language TEXT NOT NULL DEFAULT 'en', target_language TEXT NOT NULL DEFAULT 'zh-CN',
                    llm_id TEXT, tts_id TEXT, nlp_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_editions_book_id ON editions(source_id);
                CREATE UNIQUE INDEX IF NOT EXISTS uq_editions_asset ON editions
                    (source_id, profile_id, source_language, target_language,
                     coalesce(llm_id,''), coalesce(tts_id,''), coalesce(nlp_id,''));
                ALTER TABLE jobs ADD COLUMN edition_id TEXT;")
                    .map_err(|e| format!("建 editions 失败: {e}"))?;
                let mut stmt = conn.prepare("SELECT id,title,source_path,pack_dir,profile_id,status,chapter_count,failed_count,last_opened_at,source_language,target_language,llm_id,tts_id,nlp_id,created_at,updated_at,source_book_id FROM books WHERE kind='product'").map_err(|e| e.to_string())?;
                let rows: Vec<LegacyProduct> = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                            r.get(7)?,
                            r.get(8)?,
                            r.get(9)?,
                            r.get(10)?,
                            r.get(11)?,
                            r.get(12)?,
                            r.get(13)?,
                            r.get(14)?,
                            r.get(15)?,
                            r.get(16)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                drop(stmt);
                let mut used_pack_dirs = HashSet::new();
                for (
                    id,
                    title,
                    path,
                    pack,
                    profile,
                    status,
                    chap,
                    failed,
                    last,
                    sl,
                    tl,
                    llm,
                    tts,
                    nlp,
                    created,
                    updated,
                    source,
                ) in rows
                {
                    let source_id = match source.filter(|s| s != &id).filter(|s| {
                        conn.query_row(
                            "SELECT 1 FROM books WHERE id=?1 AND kind='original'",
                            [s],
                            |_| Ok(()),
                        )
                        .is_ok()
                    }) {
                        Some(s) => s,
                        None => {
                            let sid = format!("synthetic-source-{id}");
                            conn.execute("INSERT OR IGNORE INTO books (id,title,source_path,pack_dir,profile_id,status,kind,chapter_count,failed_count,created_at,updated_at,source_language,target_language) VALUES (?1,?2,?3,'',?4,'done','original',0,0,?5,?6,?7,?8)", params![sid,title,path,profile,created,updated,sl,tl]).map_err(|e| e.to_string())?;
                            sid
                        }
                    };
                    let mut edition_pack = pack.clone();
                    if !pack.is_empty() && !used_pack_dirs.insert(pack.clone()) {
                        let candidate = format!("{pack}.edition-{id}");
                        if !std::path::Path::new(&candidate).exists()
                            && copy_pack_dir(
                                std::path::Path::new(&pack),
                                std::path::Path::new(&candidate),
                            )
                            .is_ok()
                        {
                            edition_pack = candidate;
                        }
                    }
                    conn.execute("INSERT OR IGNORE INTO editions (id,source_id,title,pack_dir,profile_id,status,chapter_count,failed_count,last_opened_at,source_language,target_language,llm_id,tts_id,nlp_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params![id,source_id,title,edition_pack,profile,status,chap,failed,last,sl,tl,llm,tts,nlp,created,updated]).map_err(|e| e.to_string())?;
                    conn.execute(
                        "UPDATE jobs SET edition_id=?1 WHERE edition_id IS NULL AND output_dir=?2",
                        params![id, pack],
                    )
                    .map_err(|e| e.to_string())?;
                    conn.execute("DELETE FROM books WHERE id=?1 AND kind='product'", [id])
                        .map_err(|e| e.to_string())?;
                }
                conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (18, strftime('%s','now')*1000)", []).map_err(|e| e.to_string())?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v18 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v18 失败: {e}"));
                }
            }
        }
        // v20 (身份模型 V1, 2026-08-09): users 表 + 各数据表加 user_id 并回填。
        // 裁决 (docs/DESIGN_NOTES_SRS.md 冲突 4/5): user = "谁", profile = "讲解策略",
        // 两套表互不替代。迁移不拆人 (三项已定 ③): 全部现有数据归到一个 user "me"。
        // 关键结构变化:
        //   - vocab/dictionary key 改为 {user}:{profile}:{lemma} —— 同 profile 不同用户
        //     的词不再撞 PK (切人后各自数据的前提)。
        //   - reading_state/reading_daily 重建为含 user_id 的复合主键 —— 同一本书
        //     不同用户进度/时长各自独立 (现状无人维度, 多人会互相覆盖)。
        //   - highlights 加 user_id 列 (id 主键不变)。
        // 事务内完成 (BEGIN IMMEDIATE), 失败回滚, 仿 v18 的可回滚迁移模式。
        if version < 20 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v20 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                let now = "strftime('%s','now')*1000";
                conn.execute_batch(&format!(
                    "CREATE TABLE users (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    );
                    INSERT OR IGNORE INTO users (id, name, created_at, updated_at)
                        VALUES ('me', '我', {now}, {now});
                    ALTER TABLE vocab ADD COLUMN user_id TEXT NOT NULL DEFAULT 'me';
                    UPDATE vocab SET key = 'me:' || key;
                    ALTER TABLE dictionary ADD COLUMN user_id TEXT NOT NULL DEFAULT 'me';
                    UPDATE dictionary SET key = 'me:' || key;
                    ALTER TABLE highlights ADD COLUMN user_id TEXT NOT NULL DEFAULT 'me';
                    CREATE TABLE reading_state_new (
                        user_id TEXT NOT NULL DEFAULT 'me',
                        book_key TEXT NOT NULL,
                        chapter INTEGER NOT NULL DEFAULT 0,
                        position_ms INTEGER NOT NULL DEFAULT 0,
                        bookmarks TEXT NOT NULL DEFAULT '[]',
                        verified TEXT NOT NULL DEFAULT '{{}}',
                        time_spent_ms INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY (user_id, book_key)
                    );
                    INSERT INTO reading_state_new
                        (user_id, book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at)
                        SELECT 'me', book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at
                        FROM reading_state;
                    DROP TABLE reading_state;
                    ALTER TABLE reading_state_new RENAME TO reading_state;
                    CREATE TABLE reading_daily_new (
                        user_id TEXT NOT NULL DEFAULT 'me',
                        book_key TEXT NOT NULL,
                        day INTEGER NOT NULL,
                        time_spent_ms INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (user_id, book_key, day)
                    );
                    INSERT INTO reading_daily_new (user_id, book_key, day, time_spent_ms)
                        SELECT 'me', book_key, day, time_spent_ms FROM reading_daily;
                    DROP TABLE reading_daily;
                    ALTER TABLE reading_daily_new RENAME TO reading_daily;
                    INSERT INTO schema_migrations (version, applied_at) VALUES (20, strftime('%s','now')*1000);
                    ",
                ))
                .map_err(|e| format!("迁移 v20 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v20 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v20 失败: {e}"));
                }
            }
        }
        // v19 (BOOK_WORKFLOW §2.3, 2026-08-09): job 显式关联 source_id。
        // 此前 job 只存 book_path(源文件路径字符串)间接指到 source; 目标流程要求 job 能
        // 直接按 source_id 关联(删除 source 时级联清 job、按 source 查历史任务)。
        // 回填: book_path 精确匹配 books.source_path 的行, 把 source id 填上。
        if version < 19 {
            conn.execute_batch("ALTER TABLE jobs ADD COLUMN source_id TEXT;")
                .map_err(|e| format!("迁移 v19 加列失败: {e}"))?;
            conn.execute_batch(
                "UPDATE jobs SET source_id = (
                     SELECT b.id FROM books b
                     WHERE b.kind='original' AND b.source_path = jobs.book_path
                     LIMIT 1
                 );",
            )
            .map_err(|e| format!("迁移 v19 回填失败: {e}"))?;
            conn.execute_batch(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (19, strftime('%s','now')*1000);",
            )
            .map_err(|e| format!("迁移 v19 记录失败: {e}"))?;
        }
        // v21 (来源定位 V4, 2026-08-09): vocab 加来源定位列。
        // 加词时记录"这个词从哪本书哪章哪句划出来的" (设计稿 §02 原文语境 + 跳转)。
        // 旧数据留空 (None), UI 降级为只显示来源句; 新加词写入。
        if version < 21 {
            conn.execute_batch(
                "ALTER TABLE vocab ADD COLUMN edition_id TEXT;
                 ALTER TABLE vocab ADD COLUMN chapter_index INTEGER;
                 ALTER TABLE vocab ADD COLUMN sentence_index INTEGER;
                 INSERT INTO schema_migrations (version, applied_at) VALUES (21, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v21 失败: {e}"))?;
        }
        // v22 (同步状态 V6, 2026-08-09): sync_state 表 —— 每个 user 一条,
        // 记录"上次成功推送的时间"与"上次拉取的 rev"。pending 计数靠它算
        // (本地 updated_at > last_push_at 的词条 = 待推), 增量拉取靠 last_pull_rev。
        // 唯一写者 sync_state_repo.rs (所有权表)。
        if version < 22 {
            conn.execute_batch(
                "CREATE TABLE sync_state (
                    user_id TEXT PRIMARY KEY,
                    last_push_at INTEGER NOT NULL DEFAULT 0,
                    last_pull_rev INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                 INSERT INTO schema_migrations (version, applied_at) VALUES (22, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v22 失败: {e}"))?;
        }
        // v23 (UX 同步修复 A1, 2026-08-11): sync_state 加 endpoint_key —— 记录这份同步
        // 进度属于哪个服务端 (worker_url + auth_device 返回的服务端 user_id)。此前每行
        // 只有 user_id + last_push_at + last_pull_rev, 不记录服务端归属 —— 换 URL / 换
        // token 后 last_push_at 仍是旧值, 使 sync_service 的 updated_at > last_push_at
        // 选出空集 → 显示"已同步"但服务端是空的 (后台没做事, 用户以为成功)。
        // 老行 endpoint_key 为空串 (NOT NULL DEFAULT '') → 一律视为从未同步, 全量重推。
        if version < 23 {
            conn.execute_batch(
                "ALTER TABLE sync_state ADD COLUMN endpoint_key TEXT NOT NULL DEFAULT '';
                 INSERT INTO schema_migrations (version, applied_at) VALUES (23, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v23 失败: {e}"))?;
        }
        // v24 (UX5 #3, 2026-08-13): sync_state 主键 user_id → 复合主键 (user_id, endpoint_key)。
        // M3 主体×后端矩阵: 一个主体可同时启用多个后端, 每个 (user, endpoint_key) 一格独立进度。
        // 加 enabled 列 —— 该格是否参与"立即同步"(默认 0; 无行时按"是否当前生效后端"兜底)。
        // 老行按各自的 endpoint_key 落一行 (空 endpoint_key = 从未同步 → 丢弃, 下次同步重建);
        // 老行 endpoint_key 非空 → 保留进度, enabled 置 1 (老行为当前生效后端)。
        if version < 24 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v24 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                conn.execute_batch(
                    "CREATE TABLE sync_state_new (
                        user_id TEXT NOT NULL,
                        endpoint_key TEXT NOT NULL DEFAULT '',
                        last_push_at INTEGER NOT NULL DEFAULT 0,
                        last_pull_rev INTEGER NOT NULL DEFAULT 0,
                        enabled INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (user_id, endpoint_key)
                     );
                     INSERT INTO sync_state_new (user_id, endpoint_key, last_push_at, last_pull_rev, enabled, updated_at)
                        SELECT user_id, endpoint_key, last_push_at, last_pull_rev, 1, updated_at
                        FROM sync_state WHERE endpoint_key != '';
                     DROP TABLE sync_state;
                     ALTER TABLE sync_state_new RENAME TO sync_state;
                     INSERT INTO schema_migrations (version, applied_at) VALUES (24, strftime('%s','now')*1000);
                     ",
                )
                .map_err(|e| format!("迁移 v24 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v24 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v24 失败: {e}"));
                }
            }
        }
        // v25 (UX5 修正, 2026-08-13): model_registry 加 detected_family —— 扫描时按特征推断的
        // 家族 (llm/tts/nlp/asr/vad/unknown)。前端据此标注"这个模型是不是本项目用的" (asr/vad/unknown
        // 不是本项目的引擎, 用户据此不会选错, 也不会被自动当上推荐)。老行默认空 (前端按文件名兜底)。
        if version < 25 {
            conn.execute_batch(
                "ALTER TABLE model_registry ADD COLUMN detected_family TEXT NOT NULL DEFAULT '';
                 INSERT INTO schema_migrations (version, applied_at) VALUES (25, strftime('%s','now')*1000);
                 ",
            )
            .map_err(|e| format!("迁移 v25 失败: {e}"))?;
        }
        // v26 (UX7 #3, 2026-08-13): reading_state.bookmarks 从"当前章一组下标" number[]
        // 改成按章分组 { chapter: number[] }——旧格式切章时互相覆盖, 导致"书签没了", 见
        // docs/GOAL_2026-08-13_UX7.md 二/#3。老数据不丢: 数组按该行自己的 chapter 列归位;
        // 已经是对象的行原样跳过 (幂等, 防止迁移重跑把数据二次包裹)。
        if version < 26 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v26 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                let rows: Vec<(String, String, i64, String)> = {
                    let mut stmt = conn
                        .prepare("SELECT user_id, book_key, chapter, bookmarks FROM reading_state")
                        .map_err(|e| format!("迁移 v26 读取失败: {e}"))?;
                    let mapped = stmt
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                        .map_err(|e| format!("迁移 v26 读取失败: {e}"))?;
                    mapped
                        .collect::<Result<Vec<_>, rusqlite::Error>>()
                        .map_err(|e| format!("迁移 v26 读取失败: {e}"))?
                };
                for (user_id, book_key, chapter, bm_text) in rows {
                    let parsed: serde_json::Value =
                        serde_json::from_str(&bm_text).unwrap_or(serde_json::Value::Array(vec![]));
                    if let serde_json::Value::Array(arr) = parsed {
                        let mut obj = serde_json::Map::new();
                        obj.insert(chapter.to_string(), serde_json::Value::Array(arr));
                        let new_text = serde_json::Value::Object(obj).to_string();
                        conn.execute(
                            "UPDATE reading_state SET bookmarks = ?1 WHERE user_id = ?2 AND book_key = ?3",
                            params![new_text, user_id, book_key],
                        )
                        .map_err(|e| format!("迁移 v26 写入失败: {e}"))?;
                    }
                    // 已是对象 → 幂等跳过
                }
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (26, strftime('%s','now')*1000)",
                    [],
                )
                .map_err(|e| format!("迁移 v26 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v26 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v26 失败: {e}"));
                }
            }
        }
        // v27 (K8, 2026-08-14): reader_settings 主键 profile_id → 复合主键
        // (user_id, profile_id)。实测确认(成熟度审计"阅读器"域): 前端固定只读/写
        // 'default' 这一条, 多档案共享一台设备(如儿童/成人)时字体/主题/儿童模式
        // 会互相覆盖——根因是这张表压根没有 user_id 列, 跟 vocab/dictionary/
        // reading_state 等表当初 v20 就做过的隔离脱节了。老行(没有 user 概念时存的)
        // 回填 'me', 同 v20 的口径。
        if version < 27 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v27 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                conn.execute_batch(
                    "CREATE TABLE reader_settings_new (
                        user_id TEXT NOT NULL DEFAULT 'me',
                        profile_id TEXT NOT NULL,
                        font_size REAL NOT NULL,
                        line_height REAL NOT NULL,
                        content_width INTEGER NOT NULL,
                        font_family TEXT NOT NULL,
                        theme TEXT NOT NULL,
                        highlight_granularity TEXT NOT NULL,
                        child_mode INTEGER NOT NULL,
                        display_mode TEXT NOT NULL DEFAULT 'guess',
                        pace TEXT NOT NULL DEFAULT 'flow',
                        preset TEXT NOT NULL DEFAULT 'shadow',
                        speed REAL NOT NULL DEFAULT 1.0,
                        palette TEXT NOT NULL DEFAULT 'clay',
                        custom_color TEXT NOT NULL DEFAULT '',
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY (user_id, profile_id)
                     );
                     INSERT INTO reader_settings_new (user_id, profile_id, font_size, line_height,
                        content_width, font_family, theme, highlight_granularity, child_mode,
                        display_mode, pace, preset, speed, palette, custom_color, updated_at)
                        SELECT 'me', profile_id, font_size, line_height, content_width, font_family,
                               theme, highlight_granularity, child_mode, display_mode, pace, preset,
                               speed, palette, custom_color, updated_at
                        FROM reader_settings;
                     DROP TABLE reader_settings;
                     ALTER TABLE reader_settings_new RENAME TO reader_settings;
                     INSERT INTO schema_migrations (version, applied_at) VALUES (27, strftime('%s','now')*1000);
                     ",
                )
                .map_err(|e| format!("迁移 v27 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v27 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v27 失败: {e}"));
                }
            }
        }
        // v28 (K21, 2026-08-14): 生词本(vocab)不再跟着阅读档案(profile_id)分区——之前加词时
        // profile_id 用的是"这本书挂的讲解档案"(kid/default, 决定讲解深浅的风格设置), 但生词本/
        // 复习页固定只读 'default' 这一档(K9 早前发现的现状)。换一本挂着别的档案的书学的词
        // 从此在生词本/复习页里消失——不是数据丢失, 是变成看不见也删不掉的死数据。应用层写路径
        // 已经改成一律用固定的 VOCAB_PROFILE_ID(见 dictionary_service.rs::add_to_vocab), 这条
        // 迁移把存量的非 default 生词行归并过去: 同一个 (user_id, lemma) 如果 default 下已经有
        // 一行, 保留 updated_at 更晚的那行(SRS 进度更新更可信); 没有的话直接把这行的
        // key/profile_id 改到 default 下 (数据不丢, 只是换了个桶)。
        if version < 28 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v28 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                let rows: Vec<(String, String, String, i64)> = {
                    let mut stmt = conn
                        .prepare("SELECT key, user_id, lemma, updated_at FROM vocab WHERE profile_id != 'default'")
                        .map_err(|e| format!("迁移 v28 读取失败: {e}"))?;
                    let mapped = stmt
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                        .map_err(|e| format!("迁移 v28 读取失败: {e}"))?;
                    mapped
                        .collect::<Result<Vec<_>, rusqlite::Error>>()
                        .map_err(|e| format!("迁移 v28 读取失败: {e}"))?
                };
                for (old_key, user_id, lemma, updated_at) in rows {
                    let new_key = format!("{}:default:{}", user_id, lemma.to_lowercase());
                    let existing_default_updated_at: Option<i64> = conn
                        .query_row(
                            "SELECT updated_at FROM vocab WHERE key = ?1",
                            params![new_key],
                            |r| r.get(0),
                        )
                        .ok();
                    match existing_default_updated_at {
                        Some(default_updated_at) if default_updated_at >= updated_at => {
                            // default 那行更新更近(或一样新), 保留它, 丢弃这行重复数据
                            conn.execute("DELETE FROM vocab WHERE key = ?1", params![old_key])
                                .map_err(|e| format!("迁移 v28 删除失败: {e}"))?;
                        }
                        Some(_) => {
                            // 这行(非 default)比 default 那行更新, 让这行取代 default 那行
                            conn.execute("DELETE FROM vocab WHERE key = ?1", params![new_key])
                                .map_err(|e| format!("迁移 v28 删除失败: {e}"))?;
                            conn.execute(
                                "UPDATE vocab SET key = ?1, profile_id = 'default' WHERE key = ?2",
                                params![new_key, old_key],
                            )
                            .map_err(|e| format!("迁移 v28 归并失败: {e}"))?;
                        }
                        None => {
                            // default 下没有这个词, 直接把这行搬过去
                            conn.execute(
                                "UPDATE vocab SET key = ?1, profile_id = 'default' WHERE key = ?2",
                                params![new_key, old_key],
                            )
                            .map_err(|e| format!("迁移 v28 归并失败: {e}"))?;
                        }
                    }
                }
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (28, strftime('%s','now')*1000)",
                    [],
                )
                .map_err(|e| format!("迁移 v28 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v28 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v28 失败: {e}"));
                }
            }
        }
        // v29 (K26, 2026-08-14, 用户拍板"带日期时间的书签"): reading_state.bookmarks 每章
        // 数组的元素从纯句下标 number 升级成 {i, at}(创建时间 ms)——v26 只解决了"按章分组
        // 不互相覆盖", 没有记录"这条书签是什么时候标的", 面板列多条书签时分不清先后。老行
        // 没有单条书签级别的时间戳, at 用该行的 updated_at 兜底(不是真实创建时间, 是"至少
        // 不是 0/未知"的最佳近似); 已经是 {i,at} 对象的行原样跳过 (幂等, 防止迁移重跑二次包裹)。
        if version < 29 {
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| format!("迁移 v29 开始失败: {e}"))?;
            let result = (|| -> Result<(), String> {
                let rows: Vec<(String, String, String, i64)> = {
                    let mut stmt = conn
                        .prepare(
                            "SELECT user_id, book_key, bookmarks, updated_at FROM reading_state",
                        )
                        .map_err(|e| format!("迁移 v29 读取失败: {e}"))?;
                    let mapped = stmt
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                        .map_err(|e| format!("迁移 v29 读取失败: {e}"))?;
                    mapped
                        .collect::<Result<Vec<_>, rusqlite::Error>>()
                        .map_err(|e| format!("迁移 v29 读取失败: {e}"))?
                };
                for (user_id, book_key, bm_text, updated_at) in rows {
                    let parsed: serde_json::Value = serde_json::from_str(&bm_text)
                        .unwrap_or(serde_json::Value::Object(Default::default()));
                    if let serde_json::Value::Object(chapters) = parsed {
                        let mut changed = false;
                        let mut new_obj = serde_json::Map::new();
                        for (chapter, arr_val) in chapters {
                            if let serde_json::Value::Array(arr) = arr_val {
                                let new_arr: Vec<serde_json::Value> = arr
                                    .iter()
                                    .map(|v| {
                                        if let Some(n) = v.as_i64() {
                                            changed = true;
                                            serde_json::json!({"i": n, "at": updated_at})
                                        } else {
                                            v.clone() // 已是 {i,at} 对象 → 原样保留 (幂等)
                                        }
                                    })
                                    .collect();
                                new_obj.insert(chapter, serde_json::Value::Array(new_arr));
                            } else {
                                new_obj.insert(chapter, arr_val);
                            }
                        }
                        if changed {
                            let new_text = serde_json::Value::Object(new_obj).to_string();
                            conn.execute(
                                "UPDATE reading_state SET bookmarks = ?1 WHERE user_id = ?2 AND book_key = ?3",
                                params![new_text, user_id, book_key],
                            )
                            .map_err(|e| format!("迁移 v29 写入失败: {e}"))?;
                        }
                    }
                }
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (29, strftime('%s','now')*1000)",
                    [],
                )
                .map_err(|e| format!("迁移 v29 失败: {e}"))?;
                Ok(())
            })();
            match result {
                Ok(()) => conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| format!("迁移 v29 提交失败: {e}"))?,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(format!("迁移 v29 失败: {e}"));
                }
            }
        }
        // v30 (K33, 2026-08-16, 用户拍板"讲解深度分档不够, 要能调字数和触发门槛"):
        // profiles 表加 explain_max_chars(讲解字数上限, 替代硬编码提示词里的"讲得
        // 啰嗦一点没关系") + explain_min_sentence_chars(讲解触发门槛, 原文太短的
        // 句子直接跳过不讲解)。只加列, 不回填(旧行取列默认值即可, 等价旧行为的
        // 近似——旧默认没有字数上限概念, 150 是新选的一个合理默认值, 不是"还原
        // 旧行为", 已在 Profile::default() 的注释里说明)。
        if version < 30 {
            // 幂等判据(区别于其它 ALTER TABLE 迁移的必要性, 不是随手加的防御代码):
            // 本文件里"撤旧版本重跑"的测试套路是 open 一次(走完整 v1→v30 链子,
            // profiles 表已经有这两列了)→ 删 schema_migrations 里某几个版本号 →
            // 在同一个物理文件上再 open 一次触发重跑。如果被删的版本号里包含 30
            // (7 处已有测试都会删, 因为它们要连带撤到 v30 之前), v30 就会在同一张
            // 已经有这两列的表上再跑一次 ALTER TABLE ADD COLUMN, 直接报
            // "duplicate column name" 崩溃(实测复现过, 不是假设)。用
            // pragma_table_info 查列是否已存在来判断要不要真的执行 ALTER, 但
            // schema_migrations 的记账行始终写, 保证 version 判断本身不受影响。
            let has_column: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('profiles') WHERE name='explain_max_chars'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_column == 0 {
                conn.execute_batch(
                    "ALTER TABLE profiles ADD COLUMN explain_max_chars INTEGER NOT NULL DEFAULT 150;
                    ALTER TABLE profiles ADD COLUMN explain_min_sentence_chars INTEGER NOT NULL DEFAULT 0;
                    ",
                )
                .map_err(|e| format!("迁移 v30 失败: {e}"))?;
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (30, strftime('%s','now')*1000)",
                [],
            )
            .map_err(|e| format!("迁移 v30 失败: {e}"))?;
        }
        // v31 (2026-08-18, 从 8/18 跑批观察里发现): 回填 batches.total_books。
        // batch_start_prep 在 batch_id 不在表里时会自动建批次(R6-1 兜底), 硬编码
        // total_books: 0 且入队后从不回填 —— 实测库里**所有** 10 个批次都是 0,
        // 备料台组头因此一直显示「0 本书」。代码侧的回填已经在同一批改动里修了,
        // 但那只对**新建**的批次生效, 历史批次行不会自己变好, 而用户重跑复用的正是
        // 这些老行。这里按 jobs.batch_id 数一遍回填。
        //
        // 只回填 total_books = 0 的行: 非 0 的行是 batch_import 正常路径建的, 它的
        // total_books 是"计划处理多少本", 可能大于当前 jobs 表里还剩几条(用户删过
        // 任务), 覆盖掉会把用户的删除动作抹平。
        //
        // 不动 batches.status: 那是 update_progress 的职责(同批改动已修了它在
        // total_books=0 时恒判 completed 的 bug), 迁移不该越界替它算状态。
        if version < 31 {
            conn.execute(
                "UPDATE batches SET total_books = (
                     SELECT COUNT(*) FROM jobs WHERE jobs.batch_id = batches.id
                 )
                 WHERE total_books = 0
                   AND EXISTS (SELECT 1 FROM jobs WHERE jobs.batch_id = batches.id)",
                [],
            )
            .map_err(|e| format!("迁移 v31 失败: {e}"))?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (31, strftime('%s','now')*1000)",
                [],
            )
            .map_err(|e| format!("迁移 v31 失败: {e}"))?;
        }
        // v32 (2026-08-19, 导入自动标准化转换): books 加三个字段记录"体检 block 后
        // 后台兜底转换"的状态/结果/缓存。standardize_status: none|pending|running|done|failed
        // (none = 体检 ok/warn 不需要转换, 绝大多数书); note 是给人看的结果; cache_path
        // 是 done 时兜底解析产出的章节/句子 JSON 绝对路径 (备料 parse 阶段直接读它)。
        // 幂等判据抄 v30 的写法: 撤旧版本重跑的测试会把版本号删掉让迁移在同一张已有列
        // 的表上再跑一次 ALTER, 直接报 duplicate column —— 用 pragma_table_info 查列是否
        // 已存在来决定要不要真的执行 ALTER, schema_migrations 记账行始终写。
        if version < 32 {
            let has_column: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='standardize_status'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_column == 0 {
                conn.execute_batch(
                    "ALTER TABLE books ADD COLUMN standardize_status TEXT NOT NULL DEFAULT 'none';
                     ALTER TABLE books ADD COLUMN standardize_note TEXT;
                     ALTER TABLE books ADD COLUMN standardize_cache_path TEXT;
                     ",
                )
                .map_err(|e| format!("迁移 v32 失败: {e}"))?;
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (32, strftime('%s','now')*1000)",
                [],
            )
            .map_err(|e| format!("迁移 v32 失败: {e}"))?;
        }
        // v33 (2026-08-21, 查词三层重构): 全局词典基底表——跟 dictionary 表(按
        // user+profile 隔离的个人缓存)是两回事, 这张表不分区, 种子(ECDICT)+
        // 后续查词积累的稳定字段(pos/phonetic/meanings/phrases)全体共用。
        // 只建表, **不在这里跑种子导入**——19139 行的批量 INSERT 如果放进 migrate(),
        // 会让每个开 temp db 的测试都背上这个成本(见 dict_base_repo.rs 顶部注释),
        // 真正的种子导入由 dict_base_repo::seed_bundled_dict_base_if_empty 在应用
        // 启动时单独调用。
        if version < 33 {
            // 幂等判据抄 v32 的写法(pragma 查是否已存在): 撤旧版本重跑的测试会把
            // schema_migrations 里 >= 32 的行删掉让迁移从 v32 状态重跑, 这张表
            // 在第一次 Db::open 时已经建过, 裸 CREATE TABLE 会报 already exists。
            let has_table: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='dict_base'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_table == 0 {
                conn.execute_batch(
                    "CREATE TABLE dict_base (
                        word TEXT PRIMARY KEY,
                        pos TEXT NOT NULL DEFAULT '',
                        phonetic TEXT NOT NULL DEFAULT '',
                        meanings TEXT NOT NULL DEFAULT '[]',
                        phrases TEXT NOT NULL DEFAULT '[]',
                        source TEXT NOT NULL DEFAULT 'llm',
                        updated_at INTEGER NOT NULL DEFAULT 0
                    );",
                )
                .map_err(|e| format!("迁移 v33 失败: {e}"))?;
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (33, strftime('%s','now')*1000)",
                [],
            )
            .map_err(|e| format!("迁移 v33 失败: {e}"))?;
        }
        if version < 34 {
            // 跟读时间轴人工校准锚点 (2026-08-31)。设计理由与"防无限成长"三条护栏
            // 见 store/timing_repo.rs 头注释, 这里只放建表。
            // 复合主键 = 反复微调走 UPSERT, 行数等于锚点数而不是点击次数;
            // 最左前缀 edition_id 同时充当 list_for_edition 的索引, 不另建 index。
            let has_table: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='timing_offsets'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_table == 0 {
                conn.execute_batch(
                    "CREATE TABLE timing_offsets (
                        edition_id TEXT NOT NULL,
                        chapter_index INTEGER NOT NULL,
                        from_sentence INTEGER NOT NULL,
                        offset_ms INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (edition_id, chapter_index, from_sentence)
                    );",
                )
                .map_err(|e| format!("迁移 v34 失败: {e}"))?;
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (34, strftime('%s','now')*1000)",
                [],
            )
            .map_err(|e| format!("迁移 v34 失败: {e}"))?;
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
    fn v31_backfills_total_books_from_jobs() {
        // v31: 历史批次 total_books 恒为 0(自动建批次兜底硬编码 0 且不回填),
        // 备料台组头显示「0 本书」。按 jobs.batch_id 数一遍回填。
        let path = temp_path("v31");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).expect("首次迁移应成功");
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO batches(id,profile_id,source_language,target_language,status,
                    total_books,done_books,failed_books,created_at,updated_at)
                 VALUES ('b0','default','en','zh-CN','created',0,0,0,1,1),
                        ('b3','default','en','zh-CN','created',0,0,0,1,1),
                        ('bkeep','default','en','zh-CN','created',5,0,0,1,1),
                        ('bempty','default','en','zh-CN','created',0,0,0,1,1);
                 INSERT INTO jobs(id,book_path,profile_id,output_dir,status,stage,current,total,
                    failed_count,batch_id,source_language,target_language,created_at,updated_at)
                 VALUES ('j1','p1','default','o1','queued','',0,0,0,'b3','en','zh-CN',1,1),
                        ('j2','p2','default','o2','queued','',0,0,0,'b3','en','zh-CN',1,1),
                        ('j3','p3','default','o3','queued','',0,0,0,'b3','en','zh-CN',1,1),
                        ('j4','p4','default','o4','queued','',0,0,0,'bkeep','en','zh-CN',1,1);
                 DELETE FROM schema_migrations WHERE version >= 31;",
            )
            .unwrap();
        }
        let db = Db::open(&path).expect("v31 迁移应成功");
        let conn = db.conn.lock().unwrap();
        let get = |id: &str| -> i64 {
            conn.query_row("SELECT total_books FROM batches WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(get("b3"), 3, "有 3 条 job 的批次应回填成 3");
        assert_eq!(
            get("bkeep"),
            5,
            "total_books 非 0 的行不动: 它是'计划处理多少本', 覆盖会抹平用户删任务的动作"
        );
        assert_eq!(get("bempty"), 0, "没有任何 job 的批次保持 0, 不误写");
        assert_eq!(get("b0"), 0, "同上");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn v32_adds_standardize_columns_idempotently() {
        // v32: books 加三个标准化字段。默认值 none; 撤版本重跑时 has_column 判据应跳过
        // 重复 ALTER (不报 duplicate column)。
        let path = temp_path("v32");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            for col in [
                "standardize_status",
                "standardize_note",
                "standardize_cache_path",
            ] {
                let n: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name=?1",
                        [col],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(n, 1, "books 应有 {col} (v32)");
            }
            // 未指定 standardize_status 时默认 'none'
            conn.execute_batch(
                "INSERT INTO books (id,title,source_path,pack_dir,profile_id,status,kind,
                    chapter_count,failed_count,created_at,updated_at)
                 VALUES ('b1','T','p','','default','pending','original',0,0,1,1);",
            )
            .unwrap();
            let s: String = conn
                .query_row(
                    "SELECT standardize_status FROM books WHERE id='b1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(s, "none", "未指定时默认 none");
            // 撤 v32 让迁移重跑: has_column 判据应跳过 ALTER, 不报 duplicate column
            conn.execute_batch("DELETE FROM schema_migrations WHERE version >= 32;")
                .unwrap();
            drop(conn);
        }
        let db = Db::open(&path).expect("v32 幂等重跑应成功");
        let conn = db.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(version >= 32, "应迁移到 v32, 实得 {version}");
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
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
        assert!(version >= 18, "应迁移到 v18, 实得 {version}");
        // 关键表存在
        for table in [
            "vocab",
            "dictionary",
            "books",
            "editions",
            "jobs",
            "reader_settings",
            "users",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "表 {table} 应存在");
        }
        // v10: reader_settings 加三模式字段, reading_state 加 verified 列
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('reader_settings') WHERE name IN
                    ('display_mode','pace','preset','speed','palette')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 5, "reader_settings 应有 S5/M7 五个新列");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('reading_state') WHERE name='verified'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "reading_state 应有 verified 列");
        // v11: 两个内建档案已 seed
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))
            .unwrap();
        assert!(n >= 2, "应 seed default + kid 两个内建档案, 实得 {n}");
        // v13: highlights 表存在
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='highlights'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "highlights 表应存在");
        let job_edition: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name='edition_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(job_edition, 1, "jobs 应有 edition_id");
        // v19 (BOOK_WORKFLOW §2.3): job 显式关联 source_id
        let job_source: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name='source_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(job_source, 1, "jobs 应有 source_id");
        // v20: users 表 + user_id 列 + 复合主键
        let v20: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('vocab') WHERE name='user_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v20, 1, "vocab 应有 user_id (v20)");
        // v21: 来源定位列
        for col in ["edition_id", "chapter_index", "sentence_index"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('vocab') WHERE name=?1",
                    [col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "vocab 应有 {col} (v21)");
        }
        // v22: sync_state 表
        let v22: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v22, 1, "sync_state 表应存在 (v22)");
        // v23: sync_state 应有 endpoint_key 列 (UX A1 —— 记录同步进度归属哪个服务端)
        let v23: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='endpoint_key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v23, 1, "sync_state 应有 endpoint_key 列 (v23)");
        // v24 (UX5 #3): sync_state 复合主键 (user_id, endpoint_key) + enabled 列
        let v24enabled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='enabled'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v24enabled, 1, "sync_state 应有 enabled 列 (v24)");
        let v24pk: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE pk>0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            v24pk, 2,
            "sync_state 主键应为 (user_id, endpoint_key) 两列 (v24): {v24pk}"
        );
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
                -- v1 的真实 schema 含 profiles 与 reading_state (v10 迁移会 ALTER 它,
                -- 旧 fixture 缺这两张表是 fixture 不完整, 不是真实 v1 的样子)
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
        assert!(version >= 20, "应迁移到最新, 实得 {version}");
        // 旧数据保留且 profile 迁移为 default; v20 再加 user 前缀
        let row: (String, String, String, String) = conn
            .query_row(
                "SELECT key, profile_id, user_id, payload FROM vocab WHERE lemma='bank'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "me:default:bank", "key 应重建为 me:default:bank");
        assert_eq!(row.1, "default");
        assert_eq!(row.2, "me", "v20 应回填 user_id='me'");
        assert!(row.3.contains("bank"), "payload 应回填");
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v26_migrates_legacy_bookmarks_array_by_chapter() {
        // UX7 #3 (2026-08-13): 老 reading_state.bookmarks 是不分章的 number[]。
        // 迁移后应按该行自己的 chapter 归位成 {chapter: number[]}, 且幂等 (重跑不二次包裹)。
        let path = temp_path("v26");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO reading_state (user_id, book_key, chapter, position_ms, bookmarks, updated_at)
                    VALUES ('me', 'legacy-book', 2, 500, '[3,7]', 100);
                 INSERT INTO reading_state (user_id, book_key, chapter, position_ms, bookmarks, updated_at)
                    VALUES ('me', 'already-migrated', 1, 0, '{\"1\":[9]}', 100);
                 -- 用 >= 而不是逐个列版本号: 这些测试要的是撤到 v26 之前让迁移完整重跑。
                 -- 逐个列的写法意味着每加一条新迁移都要回来改这 7 处, 而漏改不会报你漏了 ——
                 -- MAX(version) 仍等于新版本号, 整条链子被整个跳过, 报出来的是
                 -- no such table: editions 这类完全指不到根因的错(2026-08-18 加 v31 时实测踩到)。
                 DELETE FROM schema_migrations WHERE version >= 26;",
            )
            .unwrap();
            drop(conn);
        }
        // 重开触发迁移。K26(v29)在 v26 之后接着跑, 把每条书签从纯数字升级成 {i,at}
        // (at 用该行 updated_at=100 兜底), 两条断言都按 v29 之后的最终形态更新。
        let db = Db::open(&path).unwrap();
        let conn = db.conn.lock().unwrap();
        let bm: String = conn
            .query_row(
                "SELECT bookmarks FROM reading_state WHERE book_key='legacy-book'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            bm, "{\"2\":[{\"at\":100,\"i\":3},{\"at\":100,\"i\":7}]}",
            "老数组应按 chapter=2 归位成对象, 且每条升级成带创建时间的 {{i,at}}"
        );
        let bm2: String = conn
            .query_row(
                "SELECT bookmarks FROM reading_state WHERE book_key='already-migrated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            bm2, "{\"1\":[{\"at\":100,\"i\":9}]}",
            "已按章分组的行应幂等跳过 v26, 但 v29 仍会把里面的纯数字升级成 {{i,at}}"
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v24_migrates_legacy_sync_state_rows() {
        // UX5 #3 (M3): v23 老 sync_state (user_id 主键, 含 endpoint_key) → v24 复合主键。
        // 老行按各自的 endpoint_key 落一行 (enabled=1); 空 endpoint_key (从未同步) 丢弃。
        let path = temp_path("v24");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            // 撤 v24: 还原 sync_state 到 v23 单主键形态
            conn.execute_batch(
                "DROP TABLE sync_state;
                 CREATE TABLE sync_state (
                    user_id TEXT PRIMARY KEY,
                    last_push_at INTEGER NOT NULL DEFAULT 0,
                    last_pull_rev INTEGER NOT NULL DEFAULT 0,
                    endpoint_key TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO sync_state (user_id, last_push_at, last_pull_rev, endpoint_key, updated_at)
                    VALUES ('me', 100, 5, 'https://a.workers.dev|me', 100);
                 INSERT INTO sync_state (user_id, last_push_at, last_pull_rev, endpoint_key, updated_at)
                    VALUES ('u-kid', 200, 7, 'https://a.workers.dev|kid', 200);
                 INSERT INTO sync_state (user_id, last_push_at, last_pull_rev, endpoint_key, updated_at)
                    VALUES ('legacy-empty', 999, 9, '', 999);
                 -- 撤 v25 (model_registry.detected_family), 让迁移从 v23 状态完整重跑
                 ALTER TABLE model_registry DROP COLUMN detected_family;
                 -- 撤 v30 (profiles explain_max_chars/explain_min_sentence_chars), 让迁移从 v23 状态完整重跑
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 24;",
            )
            .unwrap();
            drop(conn);
        }
        let db = Db::open(&path).unwrap();
        let conn = db.conn.lock().unwrap();
        // 复合主键 (两列 pk)
        let pk: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE pk>0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pk, 2, "v24 后主键应为复合 (user_id, endpoint_key)");
        // 老行按 endpoint_key 保留, enabled=1; 空 endpoint_key 行丢弃
        let (push, en): (i64, i64) = conn
            .query_row(
                "SELECT last_push_at, enabled FROM sync_state WHERE user_id='me' AND endpoint_key='https://a.workers.dev|me'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(push, 100);
        assert_eq!(en, 1, "老行应 enabled=1 (当前生效后端)");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE user_id='legacy-empty'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "空 endpoint_key 行应丢弃 (从未同步)");
        // 同 user 两个 endpoint 各自独立
        let n2: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n2, 2, "两个非空 endpoint_key 行各保留一行");
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v27_migrates_reader_settings_to_composite_key_without_loss() {
        // K8 (2026-08-14): 老 reader_settings (单主键 profile_id) → v27 复合主键
        // (user_id, profile_id)。老行没有 user 概念, 回填 'me', 数据不丢。
        let path = temp_path("v27");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            // 撤 v27: 还原 reader_settings 到单主键形态, 塞一条 v26 状态的老数据
            conn.execute_batch(
                "DROP TABLE reader_settings;
                 CREATE TABLE reader_settings (
                    profile_id TEXT PRIMARY KEY,
                    font_size REAL NOT NULL,
                    line_height REAL NOT NULL,
                    content_width INTEGER NOT NULL,
                    font_family TEXT NOT NULL,
                    theme TEXT NOT NULL,
                    highlight_granularity TEXT NOT NULL,
                    child_mode INTEGER NOT NULL,
                    display_mode TEXT NOT NULL DEFAULT 'guess',
                    pace TEXT NOT NULL DEFAULT 'flow',
                    preset TEXT NOT NULL DEFAULT 'shadow',
                    speed REAL NOT NULL DEFAULT 1.0,
                    palette TEXT NOT NULL DEFAULT 'clay',
                    custom_color TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO reader_settings (profile_id, font_size, line_height, content_width,
                    font_family, theme, highlight_granularity, child_mode, updated_at)
                    VALUES ('default', 22.0, 1.9, 700, 'sans', 'dark', 'word', 1, 500);
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 27;",
            )
            .unwrap();
            drop(conn);
        }
        let db = Db::open(&path).unwrap();
        let conn = db.conn.lock().unwrap();
        let pk: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('reader_settings') WHERE pk>0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pk, 2, "v27 后主键应为复合 (user_id, profile_id)");
        let (uid, fs, cm): (String, f64, i64) = conn
            .query_row(
                "SELECT user_id, font_size, child_mode FROM reader_settings WHERE profile_id='default'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(uid, "me", "老行应回填 user_id='me'");
        assert_eq!(fs, 22.0, "老数据不丢");
        assert_eq!(cm, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v28_merges_vocab_into_default_profile_without_loss() {
        // K21 (2026-08-14): 生词本不再跟着阅读档案分区。两种情况都要覆盖:
        // ① 'kid' 有一个 default 没有的词(orange) → 直接搬进 default, 数据不丢
        // ② 'kid' 和 'default' 都有同一个词(bank), 保留 updated_at 更晚的那份内容
        let path = temp_path("v28");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO vocab (key, word, lemma, pos, meaning, added_at, updated_at, profile_id, user_id, payload) VALUES
                    ('me:default:bank', 'bank', 'bank', 'NOUN', '银行', 100, 200, 'default', 'me', '{\"word\":\"bank\",\"lemma\":\"bank\",\"stage\":\"review\"}'),
                    ('me:kid:bank', 'bank', 'bank', 'NOUN', '河岸', 300, 300, 'kid', 'me', '{\"word\":\"bank\",\"lemma\":\"bank\",\"stage\":\"new\"}'),
                    ('me:kid:orange', 'orange', 'orange', 'NOUN', '橙子', 400, 400, 'kid', 'me', '{\"word\":\"orange\",\"lemma\":\"orange\",\"stage\":\"new\"}');
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 28;",
            )
            .unwrap();
            drop(conn);
        }
        let db = Db::open(&path).expect("v28 迁移应成功");
        let conn = db.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2, "bank 归并成 1 行, orange 搬到 default, 共 2 行");
        let (bank_key, bank_meaning): (String, String) = conn
            .query_row(
                "SELECT key, meaning FROM vocab WHERE lemma='bank'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(bank_key, "me:default:bank");
        assert_eq!(
            bank_meaning, "河岸",
            "updated_at 更晚(300>200)的 kid 内容应保留"
        );
        let orange_key: String = conn
            .query_row("SELECT key FROM vocab WHERE lemma='orange'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            orange_key, "me:default:orange",
            "default 下没有的词直接搬过去"
        );
        let kid_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vocab WHERE profile_id='kid'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kid_rows, 0, "不应再有任何 profile_id='kid' 的生词行");
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v29_upgrades_bookmarks_to_entries_with_created_at() {
        // K26 (2026-08-14, 用户拍板"带日期时间的书签"): 每章数组元素从纯句下标升级成
        // {i,at}。老行(v26 已按章分组, 但里面还是纯数字)用该行 updated_at 兜底 at;
        // 已经是 {i,at} 对象的行幂等跳过, 不二次包裹。
        let path = temp_path("v29");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO reading_state (user_id, book_key, chapter, position_ms, bookmarks, updated_at)
                    VALUES ('me', 'plain-numbers', 0, 0, '{\"0\":[3,7]}', 555);
                 INSERT INTO reading_state (user_id, book_key, chapter, position_ms, bookmarks, updated_at)
                    VALUES ('me', 'already-entries', 0, 0, '{\"0\":[{\"i\":9,\"at\":42}]}', 999);
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 29;",
            )
            .unwrap();
            drop(conn);
        }
        let db = Db::open(&path).expect("v29 迁移应成功");
        let conn = db.conn.lock().unwrap();
        let bm1: String = conn
            .query_row(
                "SELECT bookmarks FROM reading_state WHERE book_key='plain-numbers'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            bm1, "{\"0\":[{\"at\":555,\"i\":3},{\"at\":555,\"i\":7}]}",
            "纯数字应升级成 {{i,at}}, at 用该行 updated_at=555 兜底"
        );
        let bm2: String = conn
            .query_row(
                "SELECT bookmarks FROM reading_state WHERE book_key='already-entries'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            bm2, "{\"0\":[{\"i\":9,\"at\":42}]}",
            "已是 {{i,at}} 的行应幂等跳过, 保留原有的 at=42 不被 updated_at 覆盖"
        );
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

    #[test]
    fn copy_pack_dir_preserves_nested_assets() {
        let root = std::env::temp_dir().join(format!("aidulc_pack_copy_{}", std::process::id()));
        let src = root.join("source");
        let dst = root.join("edition");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(src.join("audio")).unwrap();
        std::fs::write(src.join("bookpack.json"), b"pack").unwrap();
        std::fs::write(src.join("audio").join("ch0.opus"), b"audio").unwrap();
        copy_pack_dir(&src, &dst).unwrap();
        assert_eq!(std::fs::read(dst.join("bookpack.json")).unwrap(), b"pack");
        assert_eq!(
            std::fs::read(dst.join("audio").join("ch0.opus")).unwrap(),
            b"audio"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn v18_migrates_legacy_product_without_loss() {
        let path = temp_path("legacy_product");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            // 手术把最新库还原到 v17 时代: 撤 editions/v18/v19/v20 的所有痕迹
            conn.execute_batch(
                "DROP TABLE editions;
                 ALTER TABLE jobs RENAME TO jobs_with_edition;
                 CREATE TABLE jobs AS SELECT id, book_path, profile_id, output_dir, status, stage,
                    current, total, failed_count, batch_id, source_language, target_language,
                    error, progress, created_at, updated_at FROM jobs_with_edition;
                 DROP TABLE jobs_with_edition;
                 -- 撤 v20: 删 users 表, 还原 vocab/dictionary 的 key 与列, 还原 highlights 列
                 DROP TABLE users;
                 CREATE TABLE vocab_v17 AS
                    SELECT substr(key, 4) AS key, word, lemma, pos, meaning, sense_id, phonetic,
                        context, level, collocations, stage, interval_days, ease_factor,
                        next_review, reviews, added_at, updated_at, profile_id, payload
                    FROM vocab;
                 DROP TABLE vocab;
                 ALTER TABLE vocab_v17 RENAME TO vocab;
                 CREATE TABLE dictionary_v17 AS
                    SELECT substr(key, 4) AS key, word, lemma, pos, payload, profile_id
                    FROM dictionary;
                 DROP TABLE dictionary;
                 ALTER TABLE dictionary_v17 RENAME TO dictionary;
                 CREATE TABLE highlights_v17 AS
                    SELECT id, book_key, chapter, sentence_index, selected_text, note,
                        start_seg, end_seg, created_at, updated_at
                    FROM highlights;
                 DROP TABLE highlights;
                 ALTER TABLE highlights_v17 RENAME TO highlights;
                 DROP TABLE sync_state;
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 18;
                 -- 撤 v25 列, 让 v25 迁移能重跑
                 ALTER TABLE model_registry DROP COLUMN detected_family;
                 INSERT INTO books (id,title,source_path,pack_dir,profile_id,status,kind,source_book_id,
                    chapter_count,failed_count,source_language,target_language,llm_id,tts_id,nlp_id,
                    created_at,updated_at)
                    VALUES ('source-1','Source','C:/source.epub','','default','done','original',NULL,
                    0,0,'en','zh-CN',NULL,NULL,NULL,1,1);
                 INSERT INTO books (id,title,source_path,pack_dir,profile_id,status,kind,source_book_id,
                    chapter_count,failed_count,source_language,target_language,llm_id,tts_id,nlp_id,
                    created_at,updated_at)
                    VALUES ('product-1','Product','C:/source.epub','C:/old-pack','kid','ready','product','source-1',
                    2,1,'en','zh-CN','llm-1','tts-1','nlp-1',2,2);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let conn = db.conn.lock().unwrap();
        let edition: (String, String, String, i64) = conn
            .query_row(
                "SELECT source_id, pack_dir, profile_id, failed_count FROM editions WHERE id='product-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            edition,
            ("source-1".into(), "C:/old-pack".into(), "kid".into(), 1)
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM books WHERE kind='product'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT title FROM books WHERE id='source-1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Source"
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }

    #[test]
    fn v20_migrates_legacy_to_users_without_loss() {
        // V1 身份模型 (2026-08-09): 从 v19 库迁移到 v20, 断言词条/进度/摘录零丢失,
        // 且全部归到默认 user 'me' (迁移不拆人)。
        let path = temp_path("v20_migrate");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            // 先制造 v19 状态: 删掉 v20 的痕迹
            conn.execute_batch(
                "DROP TABLE users;
                 ALTER TABLE vocab DROP COLUMN user_id;
                 ALTER TABLE dictionary DROP COLUMN user_id;
                 ALTER TABLE highlights DROP COLUMN user_id;
                 -- 撤 v21 (来源定位列), 让迁移从 v19 状态完整重跑
                 ALTER TABLE vocab DROP COLUMN edition_id;
                 ALTER TABLE vocab DROP COLUMN chapter_index;
                 ALTER TABLE vocab DROP COLUMN sentence_index;
                 ALTER TABLE reading_state RENAME TO reading_state_legacy;
                 CREATE TABLE reading_state (
                    book_key TEXT NOT NULL,
                    chapter INTEGER NOT NULL DEFAULT 0,
                    position_ms INTEGER NOT NULL DEFAULT 0,
                    bookmarks TEXT NOT NULL DEFAULT '[]',
                    verified TEXT NOT NULL DEFAULT '{}',
                    time_spent_ms INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (book_key)
                 );
                 INSERT INTO reading_state (book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at)
                    SELECT book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at FROM reading_state_legacy;
                 DROP TABLE reading_state_legacy;
                 ALTER TABLE reading_daily RENAME TO reading_daily_legacy;
                 CREATE TABLE reading_daily (
                    book_key TEXT NOT NULL,
                    day INTEGER NOT NULL,
                    time_spent_ms INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (book_key, day)
                 );
                 INSERT INTO reading_daily (book_key, day, time_spent_ms)
                    SELECT book_key, day, time_spent_ms FROM reading_daily_legacy;
                 DROP TABLE reading_daily_legacy;
                 -- 撤 v22 (sync_state), 让迁移从 v19 状态完整重跑
                 DROP TABLE sync_state;
                 -- 撤 v25 (model_registry.detected_family), 让迁移从 v19 状态完整重跑
                 ALTER TABLE model_registry DROP COLUMN detected_family;
                 -- 撤 v30 (profiles explain_max_chars/explain_min_sentence_chars), 让迁移从 v19 状态完整重跑
                 -- >= 而不是逐个列: 见本文件第一处同类注释 (漏改会静默跳过整条迁移链)。
                 DELETE FROM schema_migrations WHERE version >= 20;
                 -- vocab key 还原为 v19 的 {profile}:{lemma} 形式
                 UPDATE vocab SET key = substr(key, 4) WHERE key LIKE 'me:%';
                 UPDATE dictionary SET key = substr(key, 4) WHERE key LIKE 'me:%';",
            )
            .unwrap();
            // 造 v19 数据: 两个 profile 的生词 + 词典 + 进度 + 摘录
            conn.execute_batch(
                "INSERT INTO vocab (key, word, lemma, pos, meaning, context, stage, interval_days, ease_factor, reviews, added_at, updated_at, profile_id, payload) VALUES
                    ('default:bank', 'bank', 'bank', 'NOUN', '银行', 'He went to the bank.', 'review', 3, 2.5, 2, 100, 200, 'default', '{\"word\":\"bank\",\"lemma\":\"bank\",\"stage\":\"review\",\"interval\":3}'),
                    ('kid:bank', 'bank', 'bank', 'NOUN', '河岸', 'Kids by the bank.', 'new', 0, 2.5, 0, 300, 300, 'kid', '{\"word\":\"bank\",\"lemma\":\"bank\",\"stage\":\"new\"}');
                 INSERT INTO dictionary (key, word, lemma, pos, payload, profile_id) VALUES
                    ('default:bank', 'bank', 'bank', 'NOUN', '{\"word\":\"bank\",\"meanings\":[\"银行\"]}', 'default');
                 INSERT INTO reading_state (book_key, chapter, position_ms, bookmarks, verified, time_spent_ms, updated_at) VALUES
                    ('book-a', 2, 1500, '[3,7]', '{\"0\":[1,2]}', 60000, 400);
                 INSERT INTO reading_daily (book_key, day, time_spent_ms) VALUES ('book-a', 20000, 60000);
                 INSERT INTO highlights (id, book_key, chapter, sentence_index, selected_text, note, created_at, updated_at) VALUES
                    ('hl-1', 'book-a', 0, 3, 'The quick fox.', '', 500, 500);
                 ",
            )
            .unwrap();
            drop(conn);
        }
        // 重新打开 → 触发 v20 迁移
        let db = Db::open(&path).expect("v20 迁移应成功");
        let conn = db.conn.lock().unwrap();
        // users 表 + 默认用户
        let user_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM users WHERE id='me'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(user_count, 1, "应 seed 默认用户 me");
        // 词条零丢失 + 归到 me; K21 (2026-08-14, v28): 生词本不再跟着 profile 分区,
        // 'default:bank'(updated_at=200) 和 'kid:bank'(updated_at=300) 归并成 1 行——
        // 更新更晚的 kid 内容("河岸"/new)覆盖 default 那行, 数据没丢, 只是合到一个桶。
        let vocab_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            vocab_rows, 1,
            "两个 profile 的生词归并成 1 行 (v28 不再按 profile 分区)"
        );
        let me_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab WHERE user_id='me'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(me_count, 1, "归并后的生词行应回填 user_id='me'");
        let (merged_key, merged_meaning): (String, String) = conn
            .query_row(
                "SELECT key, meaning FROM vocab WHERE profile_id='default'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            merged_key, "me:default:bank",
            "key 应归并到 me:default:bank"
        );
        assert_eq!(
            merged_meaning, "河岸",
            "updated_at 更晚的 kid 内容应该是保留下来的那份"
        );
        // 词典零丢失
        let dict_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dictionary WHERE user_id='me'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dict_count, 1, "词典条目应保留并归 me");
        // 进度零丢失 (复合主键重建)
        let (chapter, position, bm) = conn
            .query_row(
                "SELECT chapter, position_ms, bookmarks FROM reading_state WHERE user_id='me' AND book_key='book-a'",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )
            .unwrap();
        assert_eq!(chapter, 2);
        assert_eq!(position, 1500);
        assert!(bm.contains("3"), "书签应保留: {bm}");
        // 每日时长零丢失
        let daily: i64 = conn
            .query_row(
                "SELECT time_spent_ms FROM reading_daily WHERE user_id='me' AND book_key='book-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(daily, 60000);
        // 摘录零丢失
        let hl_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM highlights WHERE user_id='me' AND book_key='book-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hl_count, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }
}
