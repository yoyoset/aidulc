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
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    Some((title, chapters, failed))
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
