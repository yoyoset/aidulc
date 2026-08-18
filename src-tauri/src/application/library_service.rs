//! application/library_service.rs —— 书库应用服务 (M 系列: bookpack 登记共享)
//!
//! 解决历史重复: commands/jobs.rs 与 commands/library.rs 各自解析 bookpack.json
//! 构造 Book, 逻辑逐行重复。此模块是唯一登记路径。

use crate::store;
use crate::store::books_repo::Book;
use crate::store::editions_repo::{Edition, EditionsRepo};

/// 从 bookpack.json 文本提取 (title, chapters, failed_sentences)
/// 解析失败返回 None (调用方按"无书包"处理)。
pub fn parse_bookpack_meta(text: &str) -> Option<(String, i64, i64)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let chapters = v
        .get("chapters")
        .and_then(|c| c.as_array())
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    let failed = v
        .get("quality")
        .and_then(|q| q.get("failedSentences"))
        .and_then(|f| f.as_array())
        .map(|a| crate::application::quality_notice::real_failures(a).len() as i64)
        .unwrap_or(0);
    Some((title, chapters, failed))
}

/// G4 (2026-08-11): 从 bookpack.json 文本算 (句子数, 总音频秒数)。
/// 句子数 = 各章 sentences 长度之和; 音频秒数 = 每章最后一个句子的 audio.end_ms (章时长)。
/// 解析失败返回 (0, 0) (书卡信息是展示性的, 失败不阻断列表)。
pub fn parse_bookpack_counts(text: &str) -> (i64, i64) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return (0, 0);
    };
    let Some(chapters) = v.get("chapters").and_then(|c| c.as_array()) else {
        return (0, 0);
    };
    let mut sentences = 0i64;
    let mut audio_ms = 0i64;
    for ch in chapters {
        let mut ch_audio_end = 0i64;
        if let Some(sents) = ch.get("sentences").and_then(|s| s.as_array()) {
            sentences += sents.len() as i64;
            for s in sents {
                if let Some(end) = s
                    .get("audio")
                    .and_then(|a| a.get("end_ms"))
                    .and_then(|e| e.as_i64())
                {
                    ch_audio_end = ch_audio_end.max(end);
                }
            }
        }
        audio_ms += ch_audio_end;
    }
    (sentences, audio_ms / 1000)
}

/// K2-2 (2026-08-13): 从 bookpack.json 文本取封面书包内相对路径 (无封面/解析失败返回 None,
/// 展示性字段, 同 parse_bookpack_counts 的"失败不阻断列表"原则)。
/// 2026-08-17: 生产路径已全部改走 read_bookpack_cover(只读头部)。这份"整份解析"的
/// 实现保留下来当**参考实现**, 供头部解析器的一致性测试对照 —— 头部扫描是手写的
/// 字符串匹配, 单独测它容易测成"跟自己一致", 拿真 JSON 解析器对着比才有意义。
#[cfg(test)]
pub fn parse_bookpack_cover(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.get("cover")?.as_str().map(String::from)
}

/// 2026-08-17 (用户反馈"我的书这个页面显示太慢, 有点卡"): 书库列表为了取一个封面
/// 文件名, 走的是 `fs::read_to_string` 整份读 + `serde_json::from_str` 整份解析。
/// 实测 bookpack.json 一本 5-39 MB(Wild Robot 39.2 MB), 10 本合计约 154 MB ——
/// 每次打开书库页都读+解析一遍。而 `cover` 是顶层字段, 实测就在**第 252 字节**。
///
/// 这里只读文件头 64KB 做一次字符串扫描。判据保持和 `v.get("cover")` 一致(只认顶层):
/// 扫到 `"chapters"`(那个巨大的数组, 一定在 cover 之后)就停, 避免误抓章节里嵌套的
/// 同名字段。头部没扫到就当没有封面 —— 不回退去做整份解析, 那正是要消灭的开销。
const BOOKPACK_HEAD_BYTES: usize = 64 * 1024;

pub fn parse_bookpack_cover_head(head: &str) -> Option<String> {
    let stop = head.find("\"chapters\"").unwrap_or(head.len());
    let scope = &head[..stop];
    let key = scope.find("\"cover\"")?;
    let rest = &scope[key + "\"cover\"".len()..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let mut chars = after.char_indices();
    // 只接受字符串值; null / 数字都当"没有封面"
    if chars.next()?.1 != '"' {
        return None;
    }
    let body = &after[1..];
    let end = body.find('"')?;
    let val = &body[..end];
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

/// 读 bookpack.json 的封面字段(只读头部, 见 parse_bookpack_cover_head 的说明)。
pub fn read_bookpack_cover(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; BOOKPACK_HEAD_BYTES];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    parse_bookpack_cover_head(&String::from_utf8_lossy(&buf))
}

/// 登记一本书到书库 (幂等: 同 id 覆盖)。
/// v8 资产模型: source_book_id 关联原书; llm_id/tts_id/nlp_id 是本次处理用的模型快照
/// (不同模型组合 = 不同资产, 完成库按 (原书, 模型) 分组展示)。
/// 返回 None 表示 pack_dir 无 bookpack.json (不登记)。
pub fn register_book(
    db: &store::Db,
    id: String,
    pack_dir: &str,
    source_path: String,
    source_book_id: String,
    profile_id: String,
    source_language: String,
    target_language: String,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
) -> Option<()> {
    let bp = std::path::Path::new(pack_dir).join("bookpack.json");
    let text = std::fs::read_to_string(&bp).ok()?;
    let (title, chapters, failed) = parse_bookpack_meta(&text)?;
    let now = store::now_ms_for_store();
    let source_id = source_book_id;
    let books = store::books_repo::BooksRepo::new(db);
    if books.get(&source_id).is_none() {
        books
            .upsert(&Book {
                id: source_id.clone(),
                title: title.clone(),
                source_path: source_path.clone(),
                pack_dir: String::new(),
                profile_id: profile_id.clone(),
                status: "done".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: source_language.clone(),
                target_language: target_language.clone(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: now,
                updated_at: now,
            })
            .ok()?;
    }
    let repo = EditionsRepo::new(db);
    let existing = repo.find_by_asset_key(
        &source_id,
        &profile_id,
        &source_language,
        &target_language,
        llm_id.as_deref(),
        tts_id.as_deref(),
        nlp_id.as_deref(),
    );
    let old_pack = existing.as_ref().map(|e| e.pack_dir.clone());
    let id = existing.map(|e| e.id).unwrap_or(id);
    let edition = Edition {
        id,
        source_id,
        title,
        pack_dir: pack_dir.to_string(),
        profile_id: profile_id.clone(),
        status: if failed > 0 {
            "partial".into()
        } else {
            "ready".into()
        },
        chapter_count: chapters,
        failed_count: failed,
        last_opened_at: None,
        source_language,
        target_language,
        llm_id,
        tts_id,
        nlp_id,
        created_at: now,
        updated_at: now,
    };
    if repo.upsert(&edition).is_err() {
        return None;
    }
    if let Some(old) = old_pack {
        if old != pack_dir {
            let _ = std::fs::remove_dir_all(old);
        }
    }
    Some(())
}

/// v7: 原版书处理完成 → 标记 done (保留历史, 与成品分离)
pub fn mark_original_done(db: &store::Db, book_id: &str) {
    let repo = store::books_repo::BooksRepo::new(db);
    if let Some(mut b) = repo.get(book_id) {
        if b.kind == "original" && (b.status == "processing" || b.status == "pending") {
            b.status = "done".into();
            b.updated_at = store::now_ms_for_store();
            let _ = repo.upsert(&b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_db(name: &str) -> crate::store::Db {
        let path = std::env::temp_dir().join(format!("aidulc_{name}_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        crate::store::Db::open(path.to_str().unwrap()).unwrap()
    }

    fn write_pack(dir: &std::path::Path, title: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let bp = serde_json::json!({
            "schemaVersion": 1, "title": title,
            "profile": {"id": "default", "name": "成人自读"},
            "generatedAt": "1700000000000", "prepVersion": "0.1.0",
            "chapters": [{"index":0,"title":"C0","audioFile":"a.opus","sentences":[
                {"original_text":"Hi.","translation":"嗨。","segments":[["Hi","INTJ","hi"]],"audio":{"chapter":0,"start_ms":0,"end_ms":500}}
            ]}],
            "quality": {"stages": {}}, "models": {}
        });
        let mut f = std::fs::File::create(dir.join("bookpack.json")).unwrap();
        f.write_all(serde_json::to_string(&bp).unwrap().as_bytes())
            .unwrap();
    }

    #[test]
    fn parse_meta_extracts_fields() {
        let text = r#"{
            "title": "Alice",
            "chapters": [{"id": "c0"}, {"id": "c1"}],
            "quality": {"failedSentences": [{"index": 0}, {"index": 3}]}
        }"#;
        let (title, chapters, failed) = parse_bookpack_meta(text).unwrap();
        assert_eq!(title, "Alice");
        assert_eq!(chapters, 2);
        assert_eq!(failed, 2);
    }

    #[test]
    fn parse_meta_invalid_returns_none() {
        assert!(parse_bookpack_meta("not json").is_none());
    }

    #[test]
    fn parse_meta_missing_quality_ok() {
        let (title, chapters, failed) =
            parse_bookpack_meta(r#"{"title": "X", "chapters": []}"#).unwrap();
        assert_eq!(title, "X");
        assert_eq!(chapters, 0);
        assert_eq!(failed, 0);
    }

    #[test]
    fn parse_counts_sums_sentences_and_audio() {
        // G4: 句数 = 各章 sentences 之和; 音频 = 每章最后一个句子 end_ms (章时长) 之和
        let text = r#"{
            "chapters": [
                {"sentences": [
                    {"audio": {"end_ms": 5000}},
                    {"audio": {"end_ms": 12000}}
                ]},
                {"sentences": [
                    {"audio": {"end_ms": 3000}}
                ]}
            ]
        }"#;
        let (sentences, audio_sec) = parse_bookpack_counts(text);
        assert_eq!(sentences, 3, "2+1 句");
        assert_eq!(audio_sec, 15, "12s + 3s");
    }

    #[test]
    fn parse_counts_invalid_is_zero_not_error() {
        assert_eq!(parse_bookpack_counts("not json"), (0, 0));
        assert_eq!(parse_bookpack_counts(r#"{"no":"chapters"}"#), (0, 0));
        assert_eq!(parse_bookpack_counts(r#"{"chapters":[]}"#), (0, 0));
    }

    #[test]
    fn parse_cover_reads_top_level_field() {
        assert_eq!(
            parse_bookpack_cover(r#"{"cover":"cover.jpg"}"#),
            Some("cover.jpg".to_string())
        );
    }

    #[test]
    fn parse_cover_missing_or_null_is_none_not_error() {
        assert_eq!(parse_bookpack_cover("not json"), None);
        assert_eq!(parse_bookpack_cover(r#"{"no":"cover"}"#), None);
        assert_eq!(parse_bookpack_cover(r#"{"cover":null}"#), None);
    }

    // 2026-08-17 头部读取(书库页卡顿修复): 判据必须和整份解析的 parse_bookpack_cover
    // 一致 —— 只认顶层 cover, 缺失/null/空串都当没有封面。
    #[test]
    fn head_parse_matches_full_parse_on_normal_pack() {
        let head = r#"{"schemaVersion":1,"title":"T","cover":"cover.png","chapters":[]}"#;
        assert_eq!(
            parse_bookpack_cover_head(head),
            Some("cover.png".to_string())
        );
        assert_eq!(parse_bookpack_cover_head(head), parse_bookpack_cover(head));
    }

    #[test]
    fn head_parse_missing_null_or_empty_is_none() {
        assert_eq!(parse_bookpack_cover_head(r#"{"title":"T"}"#), None);
        assert_eq!(parse_bookpack_cover_head(r#"{"cover":null}"#), None);
        assert_eq!(parse_bookpack_cover_head(r#"{"cover":""}"#), None);
        assert_eq!(parse_bookpack_cover_head(""), None);
    }

    #[test]
    fn head_parse_ignores_cover_nested_inside_chapters() {
        // 章节里可能有同名字段; 顶层没有封面时不能把它当封面(与 v.get("cover") 一致)
        let head = r#"{"title":"T","chapters":[{"cover":"wrong.jpg"}]}"#;
        assert_eq!(parse_bookpack_cover_head(head), None);
        assert_eq!(parse_bookpack_cover_head(head), parse_bookpack_cover(head));
    }

    #[test]
    fn head_read_only_touches_file_head() {
        // 真正的价值在这里: 文件后面接一大坨内容也不影响结果, 也不需要读进来。
        let dir = std::env::temp_dir().join(format!("aidulc_bphead_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("bookpack.json");
        let mut text = String::from(r#"{"title":"T","cover":"c.png","chapters":["#);
        text.push_str(&"{\"sentences\":[]},".repeat(20000));
        text.push_str("{}]}");
        assert!(text.len() > 300_000, "构造的文件要明显大于 64KB 头部窗口");
        std::fs::write(&p, &text).unwrap();
        assert_eq!(read_bookpack_cover(&p), Some("c.png".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn head_read_missing_file_is_none_not_panic() {
        assert_eq!(
            read_bookpack_cover(std::path::Path::new("Z:/nope/bookpack.json")),
            None
        );
    }

    #[test]
    fn same_params_overwrites_edition_keeping_stable_id() {
        // 阶段4: 相同参数组合重跑 → 覆盖原 edition, 保留稳定 edition id, 旧 pack 被清理
        let db = temp_db("ovr");
        let d1 = std::env::temp_dir().join(format!("aidulc_ovr1_{}", std::process::id()));
        let d2 = std::env::temp_dir().join(format!("aidulc_ovr2_{}", std::process::id()));
        write_pack(&d1, "Alice");
        write_pack(&d2, "Alice");
        let src = "s1";
        // 第一次登记
        register_book(
            &db,
            "e1".into(),
            d1.to_str().unwrap(),
            "/tmp/a.epub".into(),
            src.into(),
            "default".into(),
            "en".into(),
            "zh-CN".into(),
            Some("llmA".into()),
            Some("ttsA".into()),
            None,
        )
        .unwrap();
        let repo = crate::store::editions_repo::EditionsRepo::new(&db);
        let e1 = repo.list_by_source(src);
        assert_eq!(e1.len(), 1);
        let first_id = e1[0].id.clone();
        // 相同参数再跑 → 覆盖, id 稳定, pack_dir 换成新目录
        register_book(
            &db,
            "e-new".into(),
            d2.to_str().unwrap(),
            "/tmp/a.epub".into(),
            src.into(),
            "default".into(),
            "en".into(),
            "zh-CN".into(),
            Some("llmA".into()),
            Some("ttsA".into()),
            None,
        )
        .unwrap();
        let e2 = repo.list_by_source(src);
        assert_eq!(e2.len(), 1, "相同参数只保留一个 edition");
        assert_eq!(e2[0].id, first_id, "覆盖保留稳定 edition id");
        assert_eq!(
            e2[0].pack_dir,
            d2.to_string_lossy().to_string(),
            "pack_dir 换成新目录"
        );
        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
        let _ = std::fs::remove_file(
            std::env::temp_dir().join(format!("aidulc_ovr_{}.db", std::process::id())),
        );
    }

    #[test]
    fn different_params_create_multiple_editions() {
        // 阶段4: 不同参数组合 → 多个 edition (模型/档案不同 = 不同资产)
        let db = temp_db("multi");
        let d1 = std::env::temp_dir().join(format!("aidulc_multi1_{}", std::process::id()));
        let d2 = std::env::temp_dir().join(format!("aidulc_multi2_{}", std::process::id()));
        write_pack(&d1, "Alice");
        write_pack(&d2, "Alice");
        let src = "s1";
        // 档案不同
        register_book(
            &db,
            "e1".into(),
            d1.to_str().unwrap(),
            "/tmp/a.epub".into(),
            src.into(),
            "default".into(),
            "en".into(),
            "zh-CN".into(),
            Some("llmA".into()),
            Some("ttsA".into()),
            None,
        )
        .unwrap();
        // 模型不同 (kid + 不同 llm)
        register_book(
            &db,
            "e2".into(),
            d2.to_str().unwrap(),
            "/tmp/a.epub".into(),
            src.into(),
            "kid".into(),
            "en".into(),
            "zh-CN".into(),
            Some("llmB".into()),
            Some("ttsA".into()),
            None,
        )
        .unwrap();
        let repo = crate::store::editions_repo::EditionsRepo::new(&db);
        let list = repo.list_by_source(src);
        assert_eq!(list.len(), 2, "不同参数组合应生成两个 edition");
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"e1") && ids.contains(&"e2"));
        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
        let _ = std::fs::remove_file(
            std::env::temp_dir().join(format!("aidulc_multi_{}.db", std::process::id())),
        );
    }
}
