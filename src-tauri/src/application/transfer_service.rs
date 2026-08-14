//! application/transfer_service.rs —— .aidu-data 导入/导出 (M1: 与 AIDU v3 备份兼容)
//!
//! AIDU 备份格式 v3:
//! { version: 3, timestamp, data: { vocab: {"vocab_<profile>": {...}}, dictionaries: {"dictionary_<profile>": {...}}, ... } }
//!
//! aidulc 导入: 只读取 vocab/dictionaries/highlights/bookmarks/reading_state
//! (不导入 drafts/settings/expertPrompts/dictCache 等隐私/本地数据、也不导入 token)。
//! aidulc 导出: 默认写 vocab/dictionaries/highlights/bookmarks/reading_state 全部,
//! `export_aidu_data_scoped` 支持用户在导出前勾选只要哪几类(K27, 2026-08-14, 用户
//! 拍板"可勾选, 各是个独立边界, 可以全选")。绝不导出 token/设置/书包路径——那些不是
//! "阅读留下的痕迹"这类数据, 是配置/凭据, 见 CLAUDE.md 对配置导入导出的另一条决策。

use crate::store::vocab_repo::VocabRepo;
use crate::store::Db;
use rusqlite::params;

/// 导出为 AIDU v3 兼容 JSON (所有 profile 的 vocab + dictionary)
pub fn export_aidu_data(db: &Db) -> Result<serde_json::Value, String> {
    // 收集所有 profile (从 vocab 表 distinct)
    let profiles: Vec<String> = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT DISTINCT profile_id FROM vocab UNION SELECT DISTINCT profile_id FROM dictionary")
            .map_err(|e| format!("查 profile 失败: {e}"))?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| format!("查 profile 失败: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        rows
    };

    let mut vocab = serde_json::Map::new();
    let mut dictionaries = serde_json::Map::new();
    for profile in &profiles {
        let repo = VocabRepo::new(db);
        // V1 (2026-08-09): 导出按默认 user 合并 (旧数据迁移后全归 'me').
        // V6 接线后按需区分 user —— .aidu-data 格式只有 profile 维度, 多人导出需扩展.
        let entries = repo.list(crate::store::users_repo::DEFAULT_USER_ID, profile);
        let mut vocab_map = serde_json::Map::new();
        for e in &entries {
            let key = e.lemma.to_lowercase();
            vocab_map.insert(
                key,
                serde_json::to_value(e).unwrap_or(serde_json::Value::Null),
            );
        }
        vocab.insert(
            format!("vocab_{profile}"),
            serde_json::Value::Object(vocab_map),
        );

        let dmap = list_dictionary_payloads(db, profile);
        dictionaries.insert(
            format!("dictionary_{profile}"),
            serde_json::Value::Object(dmap),
        );
    }

    // M7 R31: 摘录 (按书分组 highights_<book_key>)。纯增量键 —— aidu 只读 vocab/dictionaries,
    // 未知键忽略, 版本不升 (v3 兼容不破)。
    let mut highlights = serde_json::Map::new();
    {
        let hrepo = crate::store::highlights_repo::HighlightsRepo::new(db);
        for h in hrepo.list_all() {
            let key = format!("highlights_{}", h.book_key);
            let arr = highlights
                .entry(key)
                .or_insert_with(|| serde_json::json!([]));
            if let Some(list) = arr.as_array_mut() {
                list.push(serde_json::to_value(&h).unwrap_or(serde_json::Value::Null));
            }
        }
    }

    // K27 (2026-08-14): 书签 + 阅读进度(此前完全不导出, 是"备份导出边界不一致"那条
    // 审计发现的根因)。按 book_key 分组, 与 highlights 同一惯例; 只导出默认 user
    // (.aidu-data 格式本身是单人设备迁移场景, 和 vocab/dictionary 的既有惯例一致)。
    let mut bookmarks_data = serde_json::Map::new();
    let mut reading_state_data = serde_json::Map::new();
    {
        let uid = crate::store::users_repo::DEFAULT_USER_ID;
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT book_key, chapter, position_ms, bookmarks, verified, time_spent_ms FROM reading_state WHERE user_id = ?1")
            .map_err(|e| format!("查阅读进度失败: {e}"))?;
        let rows: Vec<(String, i64, i64, String, String, i64)> = stmt
            .query_map(params![uid], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(|e| format!("查阅读进度失败: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        for (book_key, chapter, position_ms, bm_text, verified_text, time_spent_ms) in rows {
            let bm_val: serde_json::Value =
                serde_json::from_str(&bm_text).unwrap_or(serde_json::json!({}));
            bookmarks_data.insert(format!("bookmarks_{book_key}"), bm_val);
            let verified_val: serde_json::Value =
                serde_json::from_str(&verified_text).unwrap_or(serde_json::json!({}));
            reading_state_data.insert(
                format!("reading_state_{book_key}"),
                serde_json::json!({
                    "chapter": chapter,
                    "position_ms": position_ms,
                    "verified": verified_val,
                    "time_spent_ms": time_spent_ms,
                }),
            );
        }
    }

    Ok(serde_json::json!({
        "version": 3,
        "timestamp": crate::store::now_ms_for_store(),
        "data": {
            "vocab": vocab,
            "dictionaries": dictionaries,
            "highlights": highlights,
            "bookmarks": bookmarks_data,
            "reading_state": reading_state_data,
        }
    }))
}

/// K27 (2026-08-14, 用户拍板"可勾选, 各是个独立边界, 可以全选"): 导出前按用户勾选的
/// 类别过滤。`scope` 是要保留的顶层 data 键名子集(如 ["vocab","highlights"]); 空/None
/// 视为全选(向后兼容, 也是自动安全备份该走的路径——见 export_aidu_data 的其它调用点,
/// 那些必须永远全量, 不受这个用户手动导出入口的勾选影响)。
pub fn export_aidu_data_scoped(
    db: &Db,
    scope: Option<&[String]>,
) -> Result<serde_json::Value, String> {
    let full = export_aidu_data(db)?;
    let scope = match scope {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(full),
    };
    let data = full
        .get("data")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();
    let mut filtered = serde_json::Map::new();
    for key in scope {
        if let Some(v) = data.get(key) {
            filtered.insert(key.clone(), v.clone());
        }
    }
    Ok(serde_json::json!({
        "version": full.get("version").cloned().unwrap_or(serde_json::json!(3)),
        "timestamp": full.get("timestamp").cloned().unwrap_or(serde_json::json!(0)),
        "data": filtered,
    }))
}

/// 从 AIDU v3 JSON 导入 vocab + dictionary (按 updatedAt 合并, 不覆盖本地更新的条目)
pub fn import_aidu_data(db: &Db, backup: &serde_json::Value) -> Result<serde_json::Value, String> {
    let data = backup.get("data").ok_or("备份缺少 data 段")?;
    let mut imported_vocab = 0usize;
    let mut imported_dict = 0usize;

    // vocab: data.vocab["vocab_<profile>"] = {lemma: entry}
    if let Some(vocab_map) = data.get("vocab").and_then(|v| v.as_object()) {
        let uid = crate::store::users_repo::DEFAULT_USER_ID;
        for (storage_key, entries) in vocab_map {
            let profile = storage_key
                .strip_prefix("vocab_")
                .unwrap_or(storage_key)
                .to_string();
            if let Some(entries_obj) = entries.as_object() {
                let repo = VocabRepo::new(db);
                for (lemma, payload) in entries_obj {
                    match serde_json::from_value::<crate::domain::vocab::VocabEntry>(
                        payload.clone(),
                    ) {
                        Ok(entry) => {
                            let local = repo.get(uid, &profile, lemma);
                            let remote_newer = payload
                                .get("updatedAt")
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0)
                                > local.as_ref().map(|l| l.updated_at).unwrap_or(0);
                            if remote_newer {
                                let _ = repo.upsert_sync(entry, uid, &profile);
                                imported_vocab += 1;
                            }
                        }
                        Err(e) => {
                            let _ = e;
                        }
                    }
                }
            }
        }
    }

    // dictionary: data.dictionaries["dictionary_<profile>"] = {lemma: entry}
    if let Some(dict_map) = data.get("dictionaries").and_then(|v| v.as_object()) {
        for (storage_key, entries) in dict_map {
            let profile = storage_key
                .strip_prefix("dictionary_")
                .unwrap_or(storage_key)
                .to_string();
            if let Some(entries_obj) = entries.as_object() {
                for (lemma, payload) in entries_obj {
                    let _ = upsert_dictionary(db, &profile, lemma, payload);
                    imported_dict += 1;
                }
            }
        }
    }

    // M7 R31: 摘录 (data.highlights["highlights_<book_key>"] = [Highlight...])
    // upsert 按 id 覆盖, 重复备份幂等。
    let mut imported_hl = 0usize;
    if let Some(hl_map) = data.get("highlights").and_then(|v| v.as_object()) {
        let hrepo = crate::store::highlights_repo::HighlightsRepo::new(db);
        for (_key, arr) in hl_map {
            if let Some(items) = arr.as_array() {
                for item in items {
                    if let Ok(h) = serde_json::from_value::<crate::store::highlights_repo::Highlight>(
                        item.clone(),
                    ) {
                        if hrepo.upsert(&h).is_ok() {
                            imported_hl += 1;
                        }
                    }
                }
            }
        }
    }

    // K27 (2026-08-14): 书签(data.bookmarks["bookmarks_<book_key>"])+ 阅读进度
    // (data.reading_state["reading_state_<book_key>"])。ReadingState 结构体没有
    // updated_at 字段暴露给应用层(表里有列, struct 没带), 做不了 vocab 那种
    // "按更新时间谁新谁赢"的合并——这里就是"备份恢复"最朴素的语义: 备份里有就覆盖本地,
    // 缺的那一半(比如只导出了书签, 没导出阅读进度)从本地已有行补, 没有本地行就补 0。
    let mut imported_reading = 0usize;
    {
        let uid = crate::store::users_repo::DEFAULT_USER_ID;
        let repo = crate::store::reading_repo::ReadingRepo::new(db);
        let bm_map = data.get("bookmarks").and_then(|v| v.as_object());
        let rs_map = data.get("reading_state").and_then(|v| v.as_object());
        if bm_map.is_some() || rs_map.is_some() {
            let mut book_keys = std::collections::HashSet::new();
            if let Some(m) = bm_map {
                book_keys.extend(m.keys().filter_map(|k| k.strip_prefix("bookmarks_")));
            }
            if let Some(m) = rs_map {
                book_keys.extend(m.keys().filter_map(|k| k.strip_prefix("reading_state_")));
            }
            for book_key in book_keys {
                let local = repo.get(uid, book_key);
                let bm_val = bm_map.and_then(|m| m.get(&format!("bookmarks_{book_key}")));
                let rs_val = rs_map.and_then(|m| m.get(&format!("reading_state_{book_key}")));
                let bookmarks = match bm_val {
                    Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
                    None => local
                        .as_ref()
                        .map(|l| l.bookmarks.clone())
                        .unwrap_or_default(),
                };
                let (chapter, position_ms, verified, time_spent_ms) = match rs_val {
                    Some(v) => (
                        v.get("chapter").and_then(|x| x.as_i64()).unwrap_or(0),
                        v.get("position_ms").and_then(|x| x.as_i64()).unwrap_or(0),
                        v.get("verified")
                            .and_then(|x| serde_json::from_value(x.clone()).ok())
                            .unwrap_or_default(),
                        v.get("time_spent_ms").and_then(|x| x.as_i64()).unwrap_or(0),
                    ),
                    None => match &local {
                        Some(l) => (
                            l.chapter,
                            l.position_ms,
                            l.verified.clone(),
                            l.time_spent_ms,
                        ),
                        None => (0, 0, Default::default(), 0),
                    },
                };
                let state = crate::store::reading_repo::ReadingState {
                    user_id: uid.to_string(),
                    book_key: book_key.to_string(),
                    chapter,
                    position_ms,
                    bookmarks,
                    verified,
                    time_spent_ms,
                };
                if repo.upsert(&state).is_ok() {
                    imported_reading += 1;
                }
            }
        }
    }

    Ok(serde_json::json!({
        "imported_vocab": imported_vocab,
        "imported_dictionary": imported_dict,
        "imported_highlights": imported_hl,
        "imported_reading_state": imported_reading,
    }))
}

fn list_dictionary_payloads(
    db: &Db,
    profile_id: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let conn = db.conn.lock().unwrap();
    let mut out = serde_json::Map::new();
    let uid = crate::store::users_repo::DEFAULT_USER_ID;
    let prefix = format!("{uid}:{profile_id}:");
    let mut stmt = conn
        .prepare("SELECT key, payload FROM dictionary WHERE user_id = ?1 AND profile_id = ?2")
        .unwrap();
    let rows: Vec<(String, String)> = stmt
        .query_map(params![uid, profile_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    drop(conn);
    for (key, payload) in rows {
        let lemma = key.strip_prefix(&prefix).unwrap_or(&key).to_string();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) {
            out.insert(lemma, v);
        }
    }
    out
}

fn upsert_dictionary(
    db: &Db,
    profile_id: &str,
    lemma: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let repo = crate::store::dict_repo::DictRepo::new(db);
    repo.upsert(
        lemma,
        payload,
        crate::store::users_repo::DEFAULT_USER_ID,
        profile_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        // 每次唯一文件名, 避免测试间复用 (transfer 测试需要两个独立库)
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("aidulc_tr_test_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn vocab_entry(word: &str, updated_at: i64) -> crate::domain::vocab::VocabEntry {
        crate::domain::vocab::VocabEntry {
            word: word.into(),
            lemma: word.to_lowercase(),
            pos: "NOUN".into(),
            meaning: "含义".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: serde_json::Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: updated_at,
            updated_at,
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        }
    }

    #[test]
    fn export_import_roundtrip() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_sync(vocab_entry("bank", 100), "me", "default")
            .unwrap();
        repo.upsert_sync(vocab_entry("bank", 100), "me", "kid")
            .unwrap();

        let backup = export_aidu_data(&db).unwrap();
        assert_eq!(backup["version"], 3);
        assert!(backup["data"]["vocab"].get("vocab_default").is_some());
        assert!(backup["data"]["vocab"].get("vocab_kid").is_some());

        // 导入到新库
        let db2 = temp_db();
        let report = import_aidu_data(&db2, &backup).unwrap();
        assert_eq!(report["imported_vocab"], 2, "report: {report}");
        let repo2 = VocabRepo::new(&db2);
        assert!(
            repo2.get("me", "default", "bank").is_some(),
            "default 应有 bank"
        );
        assert!(repo2.get("me", "kid", "bank").is_some(), "kid 应有 bank");
    }

    #[test]
    fn k27_bookmarks_and_reading_state_export_import_roundtrip() {
        // K27 (2026-08-14): 之前 export_aidu_data 完全不含书签/阅读进度(备份导出边界
        // 不一致的根因), 现在两类都要能导出+导回。
        let db = temp_db();
        let repo = crate::store::reading_repo::ReadingRepo::new(&db);
        repo.upsert(&crate::store::reading_repo::ReadingState {
            user_id: "me".into(),
            book_key: "book-a".into(),
            chapter: 2,
            position_ms: 1500,
            bookmarks: std::collections::HashMap::from([(
                "2".to_string(),
                vec![crate::store::reading_repo::BookmarkEntry { i: 3, at: 999 }],
            )]),
            verified: std::collections::HashMap::from([("2".to_string(), vec![0, 1])]),
            time_spent_ms: 60000,
        })
        .unwrap();

        let backup = export_aidu_data(&db).unwrap();
        assert!(
            backup["data"]["bookmarks"]
                .get("bookmarks_book-a")
                .is_some(),
            "书签应导出: {backup}"
        );
        assert!(
            backup["data"]["reading_state"]
                .get("reading_state_book-a")
                .is_some(),
            "阅读进度应导出: {backup}"
        );

        let db2 = temp_db();
        let report = import_aidu_data(&db2, &backup).unwrap();
        assert_eq!(report["imported_reading_state"], 1, "report: {report}");
        let repo2 = crate::store::reading_repo::ReadingRepo::new(&db2);
        let got = repo2.get("me", "book-a").expect("阅读进度应导入");
        assert_eq!(got.chapter, 2);
        assert_eq!(got.position_ms, 1500);
        assert_eq!(got.time_spent_ms, 60000);
        assert_eq!(
            got.bookmarks.get("2"),
            Some(&vec![crate::store::reading_repo::BookmarkEntry {
                i: 3,
                at: 999
            }])
        );
    }

    #[test]
    fn k27_scoped_export_only_includes_selected_categories() {
        // K27 (用户拍板"可勾选, 各是个独立边界, 可以全选"): scope 过滤 data 顶层键。
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_sync(vocab_entry("bank", 100), "me", "default")
            .unwrap();

        let full = export_aidu_data_scoped(&db, None).unwrap();
        assert!(full["data"]["vocab"].is_object());
        assert!(full["data"]["dictionaries"].is_object());
        assert!(full["data"]["highlights"].is_object());
        assert!(full["data"]["bookmarks"].is_object());
        assert!(full["data"]["reading_state"].is_object());

        let scoped = export_aidu_data_scoped(&db, Some(&["vocab".to_string()])).unwrap();
        assert!(scoped["data"]["vocab"].is_object(), "选中的类别应保留");
        assert!(
            scoped["data"].get("dictionaries").is_none(),
            "没选的类别不应出现在结果里: {scoped}"
        );
        assert!(scoped["data"].get("bookmarks").is_none());
    }

    #[test]
    fn import_keeps_newer_local() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_sync(vocab_entry("bank", 500), "me", "default")
            .unwrap(); // 本地较新

        let backup = serde_json::json!({
            "version": 3,
            "data": {
                "vocab": {
                    "vocab_default": {
                        "bank": serde_json::to_value(vocab_entry("bank", 100)).unwrap() // 远端较旧
                    }
                }
            }
        });
        let report = import_aidu_data(&db, &backup).unwrap();
        assert_eq!(report["imported_vocab"], 0, "远端较旧不应覆盖");
        assert_eq!(repo.get("me", "default", "bank").unwrap().updated_at, 500);
    }

    #[test]
    fn export_never_contains_settings_or_tokens() {
        let db = temp_db();
        let backup = export_aidu_data(&db).unwrap();
        let s = serde_json::to_string(&backup).unwrap();
        assert!(!s.contains("settings"), "不应导出 settings");
        assert!(!s.contains("token"), "不应导出 token");
        assert!(!s.contains("cf_worker"), "不应导出 worker 配置");
    }

    #[test]
    fn highlights_export_import_roundtrip() {
        // M7 R31: 摘录随 .aidu-data 备份/恢复 (纯增量键, aidu 只读 vocab/dictionaries)
        let db = temp_db();
        let hrepo = crate::store::highlights_repo::HighlightsRepo::new(&db);
        let h = crate::store::highlights_repo::Highlight {
            id: "hl-1".into(),
            user_id: "me".into(),
            book_key: "book_a".into(),
            chapter: 0,
            sentence_index: 3,
            selected_text: "the quick fox".into(),
            note: "重点".into(),
            start_seg: Some(1),
            end_seg: Some(2),
            created_at: 100,
            updated_at: 100,
        };
        hrepo.upsert(&h).unwrap();

        let backup = export_aidu_data(&db).unwrap();
        let key = format!("highlights_{}", h.book_key);
        let arr = backup["data"]["highlights"][&key].as_array().unwrap();
        assert_eq!(arr.len(), 1, "摘录应按书分组导出");

        let db2 = temp_db();
        let r = import_aidu_data(&db2, &backup).unwrap();
        assert_eq!(r["imported_highlights"], 1);
        let got =
            crate::store::highlights_repo::HighlightsRepo::new(&db2).list_by_book("me", "book_a");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].selected_text, "the quick fox");
        assert_eq!(got[0].start_seg, Some(1));
        assert_eq!(got[0].end_seg, Some(2));
    }

    #[test]
    fn import_preserves_srs_fields_and_interval_ms_from_days() {
        // P1-D (2026-08-10): 旧 AIDU 扩展数据的 SRS 字段必须无损进库 ——
        // stage/easeFactor/nextReview/interval 原样; intervalMs 由 scripts/import_old_aidu.mjs
        // 换算成天×86400000, 调度器评分才有正确的下一次间隔。
        let db = temp_db();
        let backup = serde_json::json!({
            "version": 3,
            "data": {
                "vocab": {
                    "vocab_default": {
                        "ability": {
                            "word": "ability", "lemma": "ability", "pos": "NOUN", "meaning": "能力",
                            "context": "Humans acquired the ability...", "level": "A2",
                            "collocations": ["natural ability"], "deepData": null,
                            "stage": "review", "interval": 3, "intervalMs": 259200000_i64,
                            "easeFactor": 1.3, "nextReview": 1785664197048_i64, "reviews": 6,
                            "lastReview": 1785577797048_i64, "addedAt": 1772953964358_i64,
                            "updatedAt": 1785577797048_i64
                        }
                    }
                }
            }
        });
        let report = import_aidu_data(&db, &backup).unwrap();
        assert_eq!(report["imported_vocab"], 1, "{report}");
        let e = VocabRepo::new(&db)
            .get("me", "default", "ability")
            .expect("应入库");
        assert_eq!(e.stage, "review", "stage 不能被规范化改坏");
        assert_eq!(e.interval, 3.0, "interval(天) 原样保留");
        assert_eq!(e.interval_ms, 259_200_000, "intervalMs 保留 (3 天)");
        assert_eq!(e.ease_factor, 1.3, "easeFactor 原样保留");
        assert_eq!(e.next_review, Some(1785664197048), "nextReview 原样保留");
        assert_eq!(e.reviews, 6);
        assert_eq!(e.meaning, "能力");
        assert_eq!(e.pos, "NOUN");
    }

    #[test]
    #[ignore = "一次性迁移 (P1-D): 用 env 指定 AIDULC_IMPORT_FILE + AIDULC_IMPORT_DB, 把 .aidu-data v3 导入真实 data.db。cargo test --release -- --ignored import_real_aidu_data_backup --nocapture 运行, 前置已备份原库。"]
    fn import_real_aidu_data_backup() {
        let file = std::env::var("AIDULC_IMPORT_FILE").expect("AIDULC_IMPORT_FILE 未设置");
        let db_path = std::env::var("AIDULC_IMPORT_DB").expect("AIDULC_IMPORT_DB 未设置");
        let text = std::fs::read_to_string(&file).expect("读备份失败");
        let backup: serde_json::Value = serde_json::from_str(&text).expect("解析备份失败");
        let db = Db::open(&db_path).expect("打开目标库失败");
        let report = import_aidu_data(&db, &backup).expect("导入失败");
        eprintln!("IMPORT REPORT: {report}");
    }
}
