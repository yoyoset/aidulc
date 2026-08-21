//! store/dict_base_repo.rs —— 全局词典基底唯一写者 (2026-08-21)
//!
//! 跟 dict_repo.rs(个人词典缓存, 按 user+profile 隔离)是两张不同的表、不同的
//! 语义: 这张表**不按人/档案分区**, 是全体用户共用、持续累积的一份"这个词是
//! 什么意思"——种子来自 ECDICT(见 resources/dict_seed.jsonl, MIT 协议,
//! skywind3000/ECDICT 仓库过滤出的约 1.9 万条带 Collins 星级/考试标签的核心
//! 词条), 之后每次本地 LLM 查词补全的稳定字段(pos/phonetic/meanings/phrases)
//! 也并入同一份基底——查得越多, 基底越厚实, 后面任何人查同一个词都不用再跑
//! 一次 LLM。
//!
//! 只存"稳定字段"(跟哪句话无关的"这个词是什么意思"), 不存例句/用法这类语境
//! 相关字段——那些每次结合当前句子现查现生成, 不适合固化进一份全局共享表
//! (不然会出现"用别的书语境生成的例句"这种文不对题的情况)。

use crate::store::Db;
use rusqlite::{params, Connection};

#[derive(Debug, Clone, serde::Serialize)]
pub struct DictBaseEntry {
    pub word: String,
    pub pos: String,
    pub phonetic: String,
    pub meanings: Vec<String>,
    pub phrases: Vec<String>,
    pub source: String, // seed | llm
}

pub struct DictBaseRepo<'a> {
    db: &'a Db,
}

impl<'a> DictBaseRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn get(&self, word: &str) -> Option<DictBaseEntry> {
        let conn = self.db.conn.lock().unwrap();
        get_on_conn(&conn, word)
    }

    /// LLM 补全后把稳定字段并入基底。first-write-wins: 已经有条目(不管是种子还是
    /// 之前别的 profile 查到的)就不覆盖——避免不同来源反复互相改写造成churn,
    /// "第一次查到就定下来、后面持续复用"足够满足"积累"这个目标。
    pub fn upsert_if_absent(
        &self,
        word: &str,
        pos: &str,
        phonetic: &str,
        meanings: &[String],
        phrases: &[String],
    ) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO dict_base (word, pos, phonetic, meanings, phrases, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'llm', ?6)",
            params![
                word.to_lowercase(),
                pos,
                phonetic,
                serde_json::to_string(meanings).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(phrases).unwrap_or_else(|_| "[]".into()),
                crate::store::now_ms_for_store(),
            ],
        )
        .map_err(|e| format!("写词典基底失败: {e}"))?;
        Ok(())
    }
}

fn get_on_conn(conn: &Connection, word: &str) -> Option<DictBaseEntry> {
    conn.query_row(
        "SELECT word, pos, phonetic, meanings, phrases, source FROM dict_base WHERE word = ?1",
        [word.trim().to_lowercase()],
        |r| {
            let meanings_json: String = r.get(3)?;
            let phrases_json: String = r.get(4)?;
            Ok(DictBaseEntry {
                word: r.get(0)?,
                pos: r.get(1)?,
                phonetic: r.get(2)?,
                meanings: serde_json::from_str(&meanings_json).unwrap_or_default(),
                phrases: serde_json::from_str(&phrases_json).unwrap_or_default(),
                source: r.get(5)?,
            })
        },
    )
    .ok()
}

/// 种子数据行 (对应 resources/dict_seed.jsonl 每行的形状)。
#[derive(serde::Deserialize)]
struct SeedRow {
    word: String,
    phonetic: String,
    pos: String,
    meanings: Vec<String>,
}

/// 内嵌种子词典 (build 时编进二进制, 不依赖运行时资源目录解析/下载)。
/// 2026-08-21: 从 skywind3000/ECDICT(MIT) 的 ecdict.csv(77 万条全量, 66MB)按
/// Collins 星级>0 或带考试标签(zk/gk/cet4/cet6/toefl/ielts/gre 等)过滤出约 1.9 万
/// 条核心词汇, 体积压到 ~2.8MB, 足够小到直接 include_str! 进二进制。
const SEED_JSONL: &str = include_str!("../../resources/dict_seed.jsonl");

/// 应用启动时调用(不放进 migrate()!): 19139 行的种子如果每次 `Db::open` 都跑一遍
/// (migrate() 在几乎每个测试的 temp db 上都会执行), 会把整个 Rust 测试套件拖慢到
/// 不可接受——所以只建表放进迁移(schema-only, 秒开), 真正的批量种子在这里单独
/// 调用, 且先查一次"已经种过没有"直接跳过(COUNT 一张已有 19139 行的表是瞬时的,
/// 重复调用/每次真实启动都调用成本可以忽略)。
///
/// 需要 &Connection 而不是 &Db 的原因照 CLAUDE.md 里 library_asset_service.rs
/// 级联删除那条注记: 调用方(main.rs 启动 / 迁移内其它一次性数据修复)可能已经
/// 拿着 `db.conn` 的锁, 这里不该自己再去 `Db` 上加锁(std Mutex 不可重入)。
pub fn seed_bundled_dict_base_if_empty(conn: &Connection) -> Result<usize, String> {
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM dict_base", [], |r| r.get(0))
        .unwrap_or(0);
    if existing > 0 {
        return Ok(0);
    }
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("基底种子导入开事务失败: {e}"))?;
    let mut inserted = 0usize;
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO dict_base (word, pos, phonetic, meanings, phrases, source, updated_at)
             VALUES (?1, ?2, ?3, ?4, '[]', 'seed', ?5)",
        )
        .map_err(|e| format!("基底种子导入准备语句失败: {e}"))?;
    let now = crate::store::now_ms_for_store();
    for line in SEED_JSONL.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: SeedRow = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue, // 单行坏数据不该拖垮整个迁移, 跳过即可
        };
        let n = stmt
            .execute(params![
                row.word.to_lowercase(),
                row.pos,
                row.phonetic,
                serde_json::to_string(&row.meanings).unwrap_or_else(|_| "[]".into()),
                now,
            ])
            .map_err(|e| format!("基底种子导入失败 (word={}): {e}", row.word))?;
        inserted += n;
    }
    drop(stmt);
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("基底种子导入提交事务失败: {e}"))?;
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path =
            std::env::temp_dir().join(format!("aidulc_dbase_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn upsert_if_absent_then_get_roundtrip() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        repo.upsert_if_absent(
            "Bring",
            "VERB",
            "/briŋ/",
            &["带来".to_string(), "产生".to_string()],
            &["bring up".to_string()],
        )
        .unwrap();
        let got = repo.get("bring").unwrap();
        assert_eq!(got.pos, "VERB");
        assert_eq!(got.meanings, vec!["带来", "产生"]);
        assert_eq!(got.phrases, vec!["bring up"]);
        assert_eq!(got.source, "llm");
    }

    #[test]
    fn upsert_if_absent_never_overwrites_existing() {
        // first-write-wins: 已有条目(哪怕是别的 profile 之前查到的)不会被后来的
        // 结果覆盖——避免不同上下文反复互相改写。
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        repo.upsert_if_absent("zebra", "NOUN", "/x/", &["斑马".into()], &[])
            .unwrap();
        repo.upsert_if_absent("zebra", "NOUN", "/y/", &["完全不同的释义".into()], &[])
            .unwrap();
        let got = repo.get("zebra").unwrap();
        assert_eq!(got.phonetic, "/x/", "第一次写入之后不应被覆盖");
        assert_eq!(got.meanings, vec!["斑马"]);
    }

    #[test]
    fn get_missing_word_returns_none() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        assert!(repo.get("nonexistentword123").is_none());
    }

    #[test]
    fn seed_import_populates_known_word_and_is_idempotent() {
        let db = temp_db();
        let conn = db.conn.lock().unwrap();
        let n1 = seed_bundled_dict_base_if_empty(&conn).unwrap();
        assert!(n1 > 10_000, "ECDICT 过滤后应有约 1.9 万条, 实得 {n1}");
        let n2 = seed_bundled_dict_base_if_empty(&conn).unwrap();
        assert_eq!(n2, 0, "已经种过, 第二次调用应直接跳过(COUNT>0 短路)");
        drop(conn);
        let repo = DictBaseRepo::new(&db);
        let got = repo
            .get("bring")
            .expect("bring 应该在 ECDICT 种子里(实测确认过)");
        assert_eq!(got.source, "seed");
        assert!(!got.meanings.is_empty());
    }

    #[test]
    fn migration_alone_does_not_seed_dict_base() {
        // 关键回归: migrate() 只建表, 不该自动跑一遍 1.9 万行的种子导入——
        // 那会让每一个开 temp db 的测试都背上这个成本, 整个 Rust 测试套件会被拖慢。
        let db = temp_db();
        let conn = db.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM dict_base", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "migrate() 不该自动导入种子, 只建空表");
    }
}
