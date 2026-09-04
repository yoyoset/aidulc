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

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ImportStats {
    pub imported: usize,
    pub skipped_existing: usize,
    pub total_rows: usize,
}

// DictBaseSource + list/record/delete 的原始 SQL 在 dict_base_sources_repo.rs
// (它才是 dict_base_sources 表的唯一写者); 这里的方法只是薄封装, 把两张表的
// 读写(dict_base 词条本身仍只能在这个文件里写)串起来给命令层一个入口。
pub use crate::store::dict_base_sources_repo::DictBaseSource;

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

    /// 2026-09-05: 同 dict_repo.rs::cleanup_failed_entries, 一次性清历史脏数据
    /// (收紧"只有真生成成功才落库"之前, 失败原因经 upsert_if_absent 固化进了这张
    /// first-write-wins 的共享基底, 几乎不会被后续成功结果覆盖)。
    pub fn cleanup_failed_entries(&self) -> usize {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM dict_base WHERE meanings LIKE '%词义查询失败%' OR meanings LIKE '%词义待补充%'",
            [],
        )
        .unwrap_or(0)
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

    /// 2026-08-21 (用户: "设置里增加字典文件的选择"): 导入用户自己的词典文件,
    /// 追加进基底(跟种子/别人查过的词共存, INSERT OR IGNORE——不覆盖已有词条,
    /// 只补充新词/生僻词)。支持两种格式, 按内容自动判断:
    ///   - JSONL: 每行一个 JSON 对象, 形状同 resources/dict_seed.jsonl
    ///     (word/phonetic/pos/meanings, meanings 是数组)。
    ///   - CSV: 表头里找 word 列 + 释义列(translation/meaning/meanings/definition/
    ///     释义 任一, 大小写不敏感), phonetic/pos 列可选。用 csv 库解析(不是手写
    ///     split(',')——ECDICT 这类词典的释义字段常见内嵌逗号/换行, 裸 split 会悄悄错位)。
    ///
    /// 2026-09-04: 加 `label` —— 每次导入记一条可列出/可单独删除的 `dict_base_sources`。
    pub fn import_custom_file(
        &self,
        path: &str,
        label: Option<&str>,
    ) -> Result<ImportStats, String> {
        let conn = self.db.conn.lock().unwrap();
        let file_name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let label = label.filter(|s| !s.trim().is_empty()).unwrap_or(&file_name);
        let now = crate::store::now_ms_for_store();
        let source_id = format!("custom_{now}");
        let stats = import_file_on_conn(&conn, path, &source_id)?;
        if stats.imported > 0 {
            crate::store::dict_base_sources_repo::record(
                &conn,
                &source_id,
                label,
                &file_name,
                now,
                stats.imported as i64,
            )?;
        }
        Ok(stats)
    }

    /// 基底统计(按来源分), 给设置页展示"当前基底有多少词、种子/自己积累各多少"。
    pub fn stats(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT source, COUNT(*) FROM dict_base GROUP BY source ORDER BY source")
            .map_err(|e| format!("查基底统计失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("查基底统计失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("查基底统计失败: {e}"))
    }

    /// 列出所有自定义词典源, 设置页渲染"我的词典源"列表用。
    pub fn list_sources(&self) -> Result<Vec<DictBaseSource>, String> {
        let conn = self.db.conn.lock().unwrap();
        crate::store::dict_base_sources_repo::list(&conn)
    }

    /// 删除一个自定义词典源: 先删它导入的所有 dict_base 词条(这张表只能在这个文件
    /// 写), 再删源记录本身——两步在同一把已持有的 conn 锁内顺序执行, 不需要再包
    /// 一层事务。返回删除的词条数。
    pub fn delete_source(&self, source_id: &str) -> Result<usize, String> {
        let conn = self.db.conn.lock().unwrap();
        let deleted = conn
            .execute(
                "DELETE FROM dict_base WHERE source_id = ?1",
                params![source_id],
            )
            .map_err(|e| format!("删词典源词条失败: {e}"))?;
        crate::store::dict_base_sources_repo::delete(&conn, source_id)?;
        Ok(deleted)
    }
}

fn import_file_on_conn(conn: &Connection, path: &str, sid: &str) -> Result<ImportStats, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("读文件失败: {e}"))?;
    let lower = path.to_lowercase();
    let looks_jsonl = lower.ends_with(".jsonl")
        || lower.ends_with(".ndjson")
        || content.trim_start().starts_with('{');
    if looks_jsonl {
        import_jsonl_on_conn(conn, &content, sid)
    } else {
        import_csv_on_conn(conn, &content, sid)
    }
}

#[derive(serde::Deserialize)]
struct CustomJsonlRow {
    word: String,
    #[serde(default)]
    phonetic: String,
    #[serde(default)]
    pos: String,
    #[serde(default)]
    meanings: Vec<String>,
    #[serde(default)]
    phrases: Vec<String>,
}

fn import_jsonl_on_conn(conn: &Connection, text: &str, sid: &str) -> Result<ImportStats, String> {
    let (mut total_rows, mut imported) = (0usize, 0usize);
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO dict_base (word, pos, phonetic, meanings, phrases, source, updated_at, source_id)
             VALUES (?1, ?2, ?3, ?4, ?5, 'custom', ?6, ?7)",
        )
        .map_err(|e| format!("导入准备语句失败: {e}"))?;
    let now = crate::store::now_ms_for_store();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: CustomJsonlRow = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue, // 单行坏数据跳过, 不拖垮整个导入
        };
        let word = row.word.trim().to_lowercase();
        if word.is_empty() || row.meanings.is_empty() {
            continue;
        }
        total_rows += 1;
        let n = stmt
            .execute(params![
                word,
                row.pos,
                row.phonetic,
                serde_json::to_string(&row.meanings).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&row.phrases).unwrap_or_else(|_| "[]".into()),
                now,
                sid,
            ])
            .map_err(|e| format!("导入失败 (word={word}): {e}"))?;
        imported += n;
    }
    Ok(ImportStats {
        imported,
        skipped_existing: total_rows - imported,
        total_rows,
    })
}

const WORD_HEADERS: &[&str] = &["word", "headword", "单词"];
const MEANING_HEADERS: &[&str] = &["translation", "meaning", "meanings", "definition", "释义"];
const PHONETIC_HEADERS: &[&str] = &["phonetic", "ipa", "音标"];
const POS_HEADERS: &[&str] = &["pos", "词性"];

fn find_col(headers: &csv::StringRecord, candidates: &[&str]) -> Option<usize> {
    headers.iter().position(|h| {
        let h = h.trim().to_lowercase();
        candidates.iter().any(|c| *c == h)
    })
}

/// 拆多义项: 真换行 + 常见字面量转义(\r\n / \n 两种都当分隔符, ECDICT 类词典
/// 混用过——build_seed.py 处理 ECDICT 种子时踩过同样的坑)。
fn split_meanings(raw: &str) -> Vec<String> {
    let norm = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n");
    norm.split('\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn import_csv_on_conn(conn: &Connection, content: &str, sid: &str) -> Result<ImportStats, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers = rdr
        .headers()
        .map_err(|e| format!("读表头失败: {e}"))?
        .clone();
    let word_idx = find_col(&headers, WORD_HEADERS)
        .ok_or_else(|| "找不到「word」列 (支持列名: word/headword/单词)".to_string())?;
    let meaning_idx = find_col(&headers, MEANING_HEADERS).ok_or_else(|| {
        "找不到释义列 (支持列名: translation/meaning/meanings/definition/释义)".to_string()
    })?;
    let phonetic_idx = find_col(&headers, PHONETIC_HEADERS);
    let pos_idx = find_col(&headers, POS_HEADERS);

    let (mut total_rows, mut imported) = (0usize, 0usize);
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO dict_base (word, pos, phonetic, meanings, phrases, source, updated_at, source_id)
             VALUES (?1, ?2, ?3, ?4, '[]', 'custom', ?5, ?6)",
        )
        .map_err(|e| format!("导入准备语句失败: {e}"))?;
    let now = crate::store::now_ms_for_store();
    for rec in rdr.records() {
        let rec = match rec {
            Ok(r) => r,
            Err(_) => continue, // 单行解析失败(比如引号没配平)跳过, 不拖垮整个导入
        };
        let word = rec.get(word_idx).unwrap_or("").trim().to_lowercase();
        let meanings = split_meanings(rec.get(meaning_idx).unwrap_or(""));
        if word.is_empty() || meanings.is_empty() {
            continue;
        }
        total_rows += 1;
        let phonetic = phonetic_idx.and_then(|i| rec.get(i)).unwrap_or("").trim();
        let pos = pos_idx.and_then(|i| rec.get(i)).unwrap_or("").trim();
        let n = stmt
            .execute(params![
                word,
                pos,
                phonetic,
                serde_json::to_string(&meanings).unwrap_or_else(|_| "[]".into()),
                now,
                sid,
            ])
            .map_err(|e| format!("导入失败 (word={word}): {e}"))?;
        imported += n;
    }
    Ok(ImportStats {
        imported,
        skipped_existing: total_rows - imported,
        total_rows,
    })
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
    fn cleanup_failed_entries_removes_poisoned_rows_only() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        repo.upsert_if_absent(
            "suggested",
            "NOUN",
            "",
            &["suggested 的词义查询失败 (词典守护响应超时)".into()],
            &[],
        )
        .unwrap();
        repo.upsert_if_absent("bank", "NOUN", "", &["银行".into()], &[])
            .unwrap();
        let n = repo.cleanup_failed_entries();
        assert_eq!(n, 1);
        assert!(repo.get("suggested").is_none());
        assert!(repo.get("bank").is_some(), "正常词条不受影响");
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
    fn import_jsonl_appends_new_words_and_ignores_existing() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        // 预先有一条(模拟种子/别人已经查过), 导入不该覆盖它。
        repo.upsert_if_absent("existing", "NOUN", "/old/", &["旧释义".into()], &[])
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("aidulc_custom_dict_{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            concat!(
                "{\"word\": \"existing\", \"phonetic\": \"/new/\", \"pos\": \"VERB\", \"meanings\": [\"新释义\"]}\n",
                "{\"word\": \"newword\", \"phonetic\": \"/nw/\", \"pos\": \"NOUN\", \"meanings\": [\"新词\"], \"phrases\": [\"new word up\"]}\n",
                "\n",
                "{\"word\": \"\", \"meanings\": [\"该行应跳过(空词)\"]}\n",
            ),
        )
        .unwrap();
        let stats = repo
            .import_custom_file(path.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(stats.total_rows, 2, "空词那行不该计入");
        assert_eq!(stats.imported, 1, "existing 已存在, 只有 newword 真的插入");
        assert_eq!(stats.skipped_existing, 1);
        assert_eq!(
            repo.get("existing").unwrap().phonetic,
            "/old/",
            "已有词条不该被导入覆盖"
        );
        let nw = repo.get("newword").expect("新词应导入成功");
        assert_eq!(nw.meanings, vec!["新词"]);
        assert_eq!(nw.phrases, vec!["new word up"]);
        assert_eq!(nw.source, "custom");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_csv_with_ecdict_style_headers_and_embedded_commas() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        let path =
            std::env::temp_dir().join(format!("aidulc_custom_dict_{}.csv", std::process::id()));
        // 释义字段内嵌逗号(现实 ECDICT 数据的常态), 必须用真 CSV 解析而不是裸 split(',')
        // 才能拿到完整字段(不然 "带来, 产生" 会被逗号切成两截, 数据错位)。
        std::fs::write(
            &path,
            "word,phonetic,translation,pos\nbring,briŋ,\"带来, 产生\",VERB\n",
        )
        .unwrap();
        let stats = repo
            .import_custom_file(path.to_str().unwrap(), None)
            .unwrap();
        assert_eq!(stats.imported, 1);
        let got = repo.get("bring").expect("应导入成功");
        assert_eq!(got.phonetic, "briŋ");
        assert_eq!(
            got.meanings,
            vec!["带来, 产生"],
            "带内嵌逗号的引号字段不该被裸逗号拆碎"
        );
        assert_eq!(got.source, "custom");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_csv_missing_word_column_gives_readable_error() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        let path =
            std::env::temp_dir().join(format!("aidulc_custom_dict_bad_{}.csv", std::process::id()));
        std::fs::write(&path, "foo,bar\n1,2\n").unwrap();
        let err = repo
            .import_custom_file(path.to_str().unwrap(), None)
            .expect_err("没有 word 列应该报可读错误, 不是崩溃");
        assert!(err.contains("word"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stats_groups_by_source() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        repo.upsert_if_absent("a", "", "", &["x".into()], &[])
            .unwrap();
        repo.upsert_if_absent("b", "", "", &["y".into()], &[])
            .unwrap();
        let s = repo.stats().unwrap();
        assert_eq!(s, vec![("llm".to_string(), 2)]);
    }

    /// 多词典源 (2026-09-04): 带 label 导入 / 不带 label 默认取文件名 / 旧数据
    /// (source_id=NULL, 如 legacy) 不混进列表 / 删除只影响自己那批词条 —— 一次
    /// 走完整个生命周期, 省得每个子场景各自重建 db+repo。
    #[test]
    fn dict_base_sources_lifecycle() {
        let db = temp_db();
        let repo = DictBaseRepo::new(&db);
        repo.upsert_if_absent("kept", "", "", &["保留".into()], &[])
            .unwrap(); // 旧数据, source_id=NULL

        let p1 = std::env::temp_dir().join(format!("aidulc_src_a_{}.jsonl", std::process::id()));
        std::fs::write(&p1, "{\"word\": \"gadfly\", \"meanings\": [\"牛虻\"]}\n").unwrap();
        repo.import_custom_file(p1.to_str().unwrap(), Some("我的牛津词典"))
            .unwrap();
        let p2 = std::env::temp_dir().join(format!("aidulc_src_b_{}.jsonl", std::process::id()));
        std::fs::write(&p2, "{\"word\": \"zed\", \"meanings\": [\"Z\"]}\n").unwrap();
        repo.import_custom_file(p2.to_str().unwrap(), None).unwrap();
        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);

        let sources = repo.list_sources().unwrap();
        assert_eq!(sources.len(), 2, "旧数据(source_id=NULL)不该混进来");
        let labeled = sources.iter().find(|s| s.label == "我的牛津词典").unwrap();
        assert_eq!(labeled.word_count, 1);
        assert_eq!(repo.get("gadfly").unwrap().source, "custom");
        let defaulted = sources.iter().find(|s| s.id != labeled.id).unwrap();
        assert_eq!(
            defaulted.label, defaulted.file_name,
            "无 label 时默认取文件名"
        );

        let deleted = repo.delete_source(&defaulted.id).unwrap();
        assert_eq!(deleted, 1);
        assert!(repo.get("zed").is_none(), "已删除词典源的词条应消失");
        assert!(repo.get("gadfly").is_some(), "不该动其它来源的词条");
        assert!(repo.get("kept").is_some(), "不该动 source_id=NULL 的旧数据");
        assert_eq!(repo.list_sources().unwrap().len(), 1, "只删了一个源记录");
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
