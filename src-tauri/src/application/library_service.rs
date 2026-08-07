//! application/library_service.rs —— 书库应用服务 (M 系列: bookpack 登记共享)
//!
//! 解决历史重复: commands/jobs.rs 与 commands/library.rs 各自解析 bookpack.json
//! 构造 Book, 逻辑逐行重复。此模块是唯一登记路径。

use crate::store;
use crate::store::books_repo::Book;

/// 从 bookpack.json 文本提取 (title, chapters, failed_sentences)
/// 解析失败返回 None (调用方按"无书包"处理)。
pub fn parse_bookpack_meta(text: &str) -> Option<(String, i64, i64)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("Untitled").to_string();
    let chapters = v.get("chapters").and_then(|c| c.as_array()).map(|a| a.len() as i64).unwrap_or(0);
    let failed = v.get("quality").and_then(|q| q.get("failedSentences"))
        .and_then(|f| f.as_array()).map(|a| a.len() as i64).unwrap_or(0);
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
    let book = Book {
        id,
        title,
        source_path,
        pack_dir: pack_dir.to_string(),
        profile_id: profile_id.clone(),
        status: if failed > 0 { "partial".into() } else { "ready".into() },
        // v7 架构分离: 完成登记的是一条 AI 成品 (product), 独立于原版书
        kind: "product".into(),
        // v8: 关联原书 + 模型快照 (资产键)
        source_book_id: Some(source_book_id),
        chapter_count: chapters,
        failed_count: failed,
        last_opened_at: None,
        source_language,
        target_language,
        llm_id,
        tts_id,
        nlp_id,
        created_at: store::now_ms_for_store(),
        updated_at: store::now_ms_for_store(),
    };
    let repo = store::books_repo::BooksRepo::new(db);
    let _ = repo.upsert(&book);
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
        let (title, chapters, failed) = parse_bookpack_meta(r#"{"title": "X", "chapters": []}"#).unwrap();
        assert_eq!(title, "X");
        assert_eq!(chapters, 0);
        assert_eq!(failed, 0);
    }
}
