//! application/transfer_service.rs —— .aidu-data 导入/导出 (M1: 与 AIDU v3 备份兼容)
//!
//! AIDU 备份格式 v3:
//! { version: 3, timestamp, data: { vocab: {"vocab_<profile>": {...}}, dictionaries: {"dictionary_<profile>": {...}}, ... } }
//!
//! aidulc 导入: 只读取 vocab/dictionaries (不导入 drafts/settings/expertPrompts/dictCache 等隐私/本地数据)。
//! aidulc 导出: 只写 vocab/dictionaries, 绝不导出 token/设置/阅读状态/书包路径。

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

    Ok(serde_json::json!({
        "version": 3,
        "timestamp": crate::store::now_ms_for_store(),
        "data": {
            "vocab": vocab,
            "dictionaries": dictionaries,
            "highlights": highlights,
        }
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

    Ok(serde_json::json!({
        "imported_vocab": imported_vocab,
        "imported_dictionary": imported_dict,
        "imported_highlights": imported_hl,
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
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: updated_at,
            updated_at,
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
}
