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
                 DELETE FROM schema_migrations WHERE version=24;",
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
                 DELETE FROM schema_migrations WHERE version IN (18, 19, 20, 21, 22, 23, 24);
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
                 DELETE FROM schema_migrations WHERE version=20;
                 DELETE FROM schema_migrations WHERE version=21;
                 -- 撤 v22 (sync_state), 让迁移从 v19 状态完整重跑
                 DROP TABLE sync_state;
                 DELETE FROM schema_migrations WHERE version=22;
                 -- 撤 v23 (sync_state.endpoint_key), 让迁移从 v19 状态完整重跑
                 DELETE FROM schema_migrations WHERE version=23;
                 -- 撤 v24 (sync_state 复合主键 + enabled), 让迁移从 v19 状态完整重跑
                 DELETE FROM schema_migrations WHERE version=24;
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
        // 词条零丢失 + 归到 me
        let vocab_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vocab_rows, 2, "两个 profile 的生词都应保留");
        let me_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vocab WHERE user_id='me'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(me_count, 2, "所有生词都应回填 user_id='me'");
        let kid_key: String = conn
            .query_row("SELECT key FROM vocab WHERE profile_id='kid'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kid_key, "me:kid:bank", "key 应重写为 me:kid:bank");
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
