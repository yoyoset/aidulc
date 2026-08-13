//! commands/vocab.rs —— 生词本命令 (I-B)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从原 commands/vocab.rs 再拆——
//! 词典(dictionary 表)挪到 commands/dictionary.rs, 背单词调度(SRS 评分)挪到
//! commands/srs.rs, 这里只留生词本(vocab 表, vocab_repo.rs 唯一写者)的增删查统计。

use crate::application::dictionary_service;
use crate::store;
use tauri::State;

/// 显式加入生词本
/// V4 (2026-08-09): source 内含 edition_id/chapter_index/sentence_index 来源定位。
/// 打包成请求结构体是为了不新增命令参数 (clippy 参数过多警告, 基线只降不升)。
/// UX7 #1 (2026-08-13, 真机实测确认): 前端 dictionary_service.js 的 addToVocab() 打的是
/// camelCase 键(userId/profileId/editionId/chapterIndex/sentenceIndex) —— Tauri 只自动把
/// *顶层* invoke 参数名 camelCase→snake_case, `req` 这种打包进请求体的嵌套字段不在这个转换
/// 范围内, serde 按字面量找不到 user_id 直接报 "missing field `user_id`"。全仓库唯一一个
/// "打包成请求结构体"的命令, 之前没人踩过这个坑。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddVocabRequest {
    pub word: String,
    pub user_id: String,
    pub profile_id: String,
    pub context: Option<String>,
    #[serde(default)]
    pub edition_id: Option<String>,
    #[serde(default)]
    pub chapter_index: Option<i64>,
    #[serde(default)]
    pub sentence_index: Option<i64>,
}

#[tauri::command]
pub fn add_vocab(db: State<store::Db>, req: AddVocabRequest) -> Result<serde_json::Value, String> {
    dictionary_service::add_to_vocab(
        db.inner(),
        &req.user_id,
        &req.profile_id,
        &req.word,
        req.context,
        crate::application::dictionary_service::SourceLocation {
            edition_id: req.edition_id,
            chapter_index: req.chapter_index,
            sentence_index: req.sentence_index,
        },
    )
}

#[cfg(test)]
mod add_vocab_request_tests {
    //! UX7 #1 (2026-08-13, 真机实测确认): 前端 addToVocab() 发的是 camelCase
    //! (userId/profileId/editionId/...), AddVocabRequest 没标 rename_all 时 serde
    //! 按字面量找 user_id 找不到, 报 "missing field `user_id`"——用户真机点"加入生词本"
    //! 复现的原始报错。锁定这条 JSON 契约, 防止 rename_all 被误删回归。
    use super::AddVocabRequest;

    #[test]
    fn accepts_camel_case_json_from_frontend() {
        let json = r#"{
            "word": "either", "userId": "me", "profileId": "default",
            "context": "He likes either one.", "editionId": null,
            "chapterIndex": 2, "sentenceIndex": 5
        }"#;
        let req: AddVocabRequest =
            serde_json::from_str(json).expect("camelCase JSON 应能反序列化为 AddVocabRequest");
        assert_eq!(req.user_id, "me");
        assert_eq!(req.profile_id, "default");
        assert_eq!(req.chapter_index, Some(2));
        assert_eq!(req.sentence_index, Some(5));
    }
}

// ---- 生词本 (I-B) ----

/// 生词列表
#[tauri::command]
pub fn vocab_all(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    serde_json::to_value(repo.list(&user_id, &profile_id)).map_err(|e| e.to_string())
}

/// 生词搜索
#[tauri::command]
pub fn vocab_search(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    q: String,
) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    serde_json::to_value(repo.search(&user_id, &profile_id, &q)).map_err(|e| e.to_string())
}

/// 删除生词
#[tauri::command]
pub fn vocab_remove(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    lemma: String,
) -> Result<(), String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    repo.remove(&user_id, &profile_id, &lemma)
}

/// 生词统计
#[tauri::command]
pub fn vocab_stats(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    Ok(repo.stats(&user_id, &profile_id))
}

/// H5 (2026-08-11): 词频批量剔除 —— dry-run 预览: 词表里落在最常见 top_n 词的条目
/// 有多少条、分别是谁 (不实际删除)。用户确认后才调 vocab_remove_common 执行。
#[tauri::command]
pub fn vocab_common_preview(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    top_n: i64,
) -> Result<serde_json::Value, String> {
    let n = (top_n.clamp(100, 10000)) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entries = repo.list(&user_id, &profile_id);
    let common = crate::infrastructure::frequency::top_n(n);
    let hit: Vec<String> = entries
        .iter()
        .filter(|e| common.contains(&e.lemma.to_lowercase()))
        .map(|e| e.lemma.clone())
        .collect();
    Ok(serde_json::json!({
        "count": hit.len(),
        "lemmas": hit,
        "top_n": n,
        "total": entries.len(),
    }))
}

/// H5 (2026-08-11): 词频批量剔除 —— 执行删除最常见 top_n 词。
///
/// 数据安全 (GOAL_2026-08-11_UX2): 改/删用户数据前自动备份 (export_aidu_data →
/// 时间戳备份文件, 路径返回给用户), 批量写必须在**单个事务**里, 中途失败整体回滚;
/// dry-run (vocab_common_preview) 已先给"将影响 N 条", 本命令是确认后的执行。
#[tauri::command]
pub fn vocab_remove_common(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    top_n: i64,
) -> Result<serde_json::Value, String> {
    let n = (top_n.clamp(100, 10000)) as usize;
    let common = crate::infrastructure::frequency::top_n(n);

    // 1. 执行前自动备份 (数据安全第 1 条) —— 时间戳文件, 路径告诉用户
    let backup_dir = std::env::var("AIDULC_BACKUP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!("aidulc-backups-{}", std::process::id()))
        });
    let _ = std::fs::create_dir_all(&backup_dir);
    let backup_path = backup_dir.join(format!(
        "aidulc-vocab-remove-{}.aidu-data",
        crate::store::now_ms_for_store()
    ));
    let backup_json = crate::application::transfer_service::export_aidu_data(db.inner())
        .map_err(|e| format!("备份失败: {e}"))?;
    std::fs::write(
        &backup_path,
        serde_json::to_string_pretty(&backup_json).unwrap_or_default(),
    )
    .map_err(|e| format!("写备份文件失败: {e}"))?;

    // 2. 收集待删 lemma
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entries = repo.list(&user_id, &profile_id);
    let hit: Vec<String> = entries
        .iter()
        .filter(|e| common.contains(&e.lemma.to_lowercase()))
        .map(|e| e.lemma.to_lowercase())
        .collect();

    // 3. 单事务删除 (唯一写者 = vocab_repo), 中途失败整体回滚
    repo.remove_many(&user_id, &profile_id, &hit)
        .map_err(|e| format!("批量剔词失败, 已整体回滚: {e}"))?;

    Ok(serde_json::json!({
        "removed": hit.len(),
        "backup_path": backup_path.to_string_lossy(),
    }))
}

/// H4 (2026-08-11): 存量打散 dry-run —— 当前有多少词 next_review 在过去 (存量到期),
/// 按每日可承受量 (daily_cap) 会摊到多少天、今天还剩多少词。不实际改动。
#[tauri::command]
pub fn vocab_backlog_preview(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    daily_cap: i64,
) -> Result<serde_json::Value, String> {
    let cap = daily_cap.clamp(1, 500) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let now = crate::store::now_ms_for_store();
    let entries = repo.list(&user_id, &profile_id);
    // 存量 = next_review 在过去 (含 null), 且不是 mastered (已掌握不参与复习排程)
    let backlog: Vec<(&str, i64)> = entries
        .iter()
        .filter(|e| e.stage != "mastered")
        .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
        .map(|e| (e.lemma.as_str(), e.added_at))
        .collect();
    let days = if cap > 0 {
        backlog.len().div_ceil(cap)
    } else {
        0
    };
    let today_after = backlog.len().min(cap);
    let spread = crate::domain::srs::spread_backlog_dates(&backlog, cap, now);
    Ok(serde_json::json!({
        "backlog_count": backlog.len(),
        "daily_cap": cap,
        "days": days,
        "today_after": today_after,
        "today_before": entries.iter().filter(|e| e.stage != "mastered").filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true)).count(),
        "sample_after": spread.iter().take(5).map(|(l, t)| serde_json::json!({"lemma": l, "next_review": t})).collect::<Vec<_>>(),
    }))
}

/// H4 (2026-08-11): 存量打散 —— 按加入顺序把 next_review 摊到未来 N 天。
///
/// 数据安全 (GOAL_2026-08-11_UX2): 执行前自动备份 (export_aidu_data → 时间戳文件);
/// 批量写必须**单事务**, 中途失败整体回滚; dry-run (vocab_backlog_preview) 先给数字。
#[tauri::command]
pub fn vocab_backlog_spread(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    daily_cap: i64,
) -> Result<serde_json::Value, String> {
    let cap = daily_cap.clamp(1, 500) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let now = crate::store::now_ms_for_store();
    let entries = repo.list(&user_id, &profile_id);
    let backlog: Vec<(&str, i64)> = entries
        .iter()
        .filter(|e| e.stage != "mastered")
        .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
        .map(|e| (e.lemma.as_str(), e.added_at))
        .collect();
    if backlog.is_empty() {
        return Ok(serde_json::json!({ "spread": 0, "days": 0, "backup_path": "" }));
    }

    // 1. 执行前自动备份 (数据安全第 1 条)
    let backup_dir = std::env::var("AIDULC_BACKUP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!("aidulc-backups-{}", std::process::id()))
        });
    let _ = std::fs::create_dir_all(&backup_dir);
    let backup_path = backup_dir.join(format!(
        "aidulc-vocab-spread-{}.aidu-data",
        crate::store::now_ms_for_store()
    ));
    let backup_json = crate::application::transfer_service::export_aidu_data(db.inner())
        .map_err(|e| format!("备份失败: {e}"))?;
    std::fs::write(
        &backup_path,
        serde_json::to_string_pretty(&backup_json).unwrap_or_default(),
    )
    .map_err(|e| format!("写备份文件失败: {e}"))?;

    // 2. 打散计划
    let spread = crate::domain::srs::spread_backlog_dates(&backlog, cap, now);
    let days = if cap > 0 {
        backlog.len().div_ceil(cap)
    } else {
        0
    };

    // 3. 单事务写 next_review, 中途失败整体回滚 (唯一写者 = vocab_repo)
    let spread_plan: Vec<(String, i64)> = spread.iter().map(|(l, t)| (l.to_string(), *t)).collect();
    repo.spread_next_review(&user_id, &profile_id, &spread_plan)
        .map_err(|e| format!("存量打散失败, 已整体回滚: {e}"))?;

    Ok(serde_json::json!({
        "spread": spread.len(),
        "days": days,
        "backup_path": backup_path.to_string_lossy(),
    }))
}

#[cfg(test)]
mod h5_tests {
    //! H5 (2026-08-11): 词频批量剔除 —— 只删该 user+profile 的词, 不误删别人的;
    //! 单词事务回滚: 构造"删到一半出错"的场景 → 已删的也回滚。
    use crate::store::vocab_repo::VocabRepo;

    fn temp_db() -> crate::store::Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("aidulc_h5_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        crate::store::Db::open(path.to_str().unwrap()).unwrap()
    }

    fn entry(word: &str) -> crate::domain::vocab::VocabEntry {
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
            added_at: crate::store::now_ms_for_store(),
            updated_at: crate::store::now_ms_for_store(),
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        }
    }

    #[test]
    fn preview_counts_only_common_words() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("hieroglyphics"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("ability"), "me", "default")
            .unwrap();

        // 直接复用命令内部逻辑: top_n 集合取词
        let common = crate::infrastructure::frequency::top_n(3000);
        let entries = repo.list("me", "default");
        let hit: Vec<String> = entries
            .iter()
            .filter(|e| common.contains(&e.lemma.to_lowercase()))
            .map(|e| e.lemma.clone())
            .collect();
        assert_eq!(
            hit.len(),
            2,
            "either + ability 命中, hieroglyphics 不命中: {hit:?}"
        );
        assert!(!hit.contains(&"hieroglyphics".to_string()));
        assert!(hit.contains(&"either".to_string()));
        assert!(hit.contains(&"ability".to_string()));
    }

    #[test]
    fn add_vocab_reports_common_word_flag() {
        // 入库侧门槛: 默认不拦 (加入成功) 但给 common_word 提示
        let db = temp_db();
        let r = crate::application::dictionary_service::add_to_vocab(
            &db,
            "me",
            "default",
            "either",
            Some("He likes either one.".into()),
            crate::application::dictionary_service::SourceLocation::default(),
        )
        .unwrap();
        assert_eq!(r["added"], "either");
        assert_eq!(r["common_word"], true, "either 应标 common_word");
        // 生僻词不提示
        let r2 = crate::application::dictionary_service::add_to_vocab(
            &db,
            "me",
            "default",
            "hieroglyphics",
            None,
            crate::application::dictionary_service::SourceLocation::default(),
        )
        .unwrap();
        assert_eq!(r2["common_word"], false);
    }

    #[test]
    fn remove_common_only_touches_target_profile() {
        // 同 user 不同 profile: 只删 default 的 either, 不动 kid 的 either
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("either"), "me", "kid").unwrap();

        // 先取待删 lemma (不持锁调 repo.list, 避免 std Mutex 自锁)
        let common = crate::infrastructure::frequency::top_n(3000);
        let to_delete: Vec<String> = repo
            .list("me", "default")
            .iter()
            .filter(|e| common.contains(&e.lemma.to_lowercase()))
            .map(|e| e.lemma.to_lowercase())
            .collect();

        // 模拟命令的删除事务 (只删 default)
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
            let mut stmt = conn
                .prepare("DELETE FROM vocab WHERE user_id = ?1 AND profile_id = ?2 AND lemma = ?3")
                .unwrap();
            for lemma in to_delete {
                stmt.execute(rusqlite::params!["me", "default", lemma])
                    .unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }
        assert!(
            repo.get("me", "default", "either").is_none(),
            "default 应删"
        );
        assert!(repo.get("me", "kid", "either").is_some(), "kid 不应被误删");
    }

    #[test]
    fn remove_common_transaction_rolls_back_on_error() {
        // 单词事务: 中途出错 (用不存在的 user 列制造错误) → 整体回滚, 不留半套状态
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();

        let result = (|| -> Result<(), String> {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| e.to_string())?;
            // 第一条成功删
            conn.execute(
                "DELETE FROM vocab WHERE user_id='me' AND profile_id='default' AND lemma='either'",
                [],
            )
            .map_err(|e| e.to_string())?;
            // 第二条故意失败 (不存在这一列) → 触发回滚
            let r = conn.execute("DELETE FROM vocab WHERE no_such_column = 1", []);
            if r.is_err() {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err("模拟失败".into());
            }
            let _ = conn.execute_batch("COMMIT;");
            Ok(())
        })();
        assert!(result.is_err(), "应失败");
        assert!(
            repo.get("me", "default", "either").is_some(),
            "失败后要么仍在 (回滚), 要么从未被删"
        );
    }

    #[test]
    fn backlog_spread_moves_due_into_future() {
        // H4: 存量打散 —— 模拟命令的"取到期 → 单事务写 next_review"链路
        use crate::domain::srs;
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        let mut e1 = entry("bank");
        e1.next_review = Some(now - 1000); // 已到期
        e1.added_at = now - 5000;
        let mut e2 = entry("languid");
        e2.next_review = Some(now - 2000); // 已到期
        e2.added_at = now - 1000;
        let mut e3 = entry("future");
        e3.next_review = Some(now + 86_400_000); // 未到期, 不应被打散
        e3.added_at = now;
        repo.upsert_content(e1, "me", "default").unwrap();
        repo.upsert_content(e2, "me", "default").unwrap();
        repo.upsert_content(e3, "me", "default").unwrap();

        // 取存量 (next_review <= now)
        let entries = repo.list("me", "default");
        let backlog: Vec<(&str, i64)> = entries
            .iter()
            .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
            .map(|e| (e.lemma.as_str(), e.added_at))
            .collect();
        assert_eq!(backlog.len(), 2, "只有 2 个到期");

        // 打散 (每日 1 词 → 摊到 2 天)
        let spread = srs::spread_backlog_dates(&backlog, 1, now);
        assert_eq!(spread.len(), 2);
        // 按 added_at 排序: bank 先 (更早加入) → 今天; languid → 明天
        assert_eq!(spread[0].0, "bank");
        assert_eq!(spread[1].0, "languid");
        let day0 = now - (now % srs::DAY_1);
        assert_eq!(spread[0].1, day0);
        assert_eq!(spread[1].1, day0 + srs::DAY_1);

        // 单事务写回 (与命令一致: json_set payload, 只改散列列会让 repo.list 读到旧值)
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
            let mut stmt = conn
                .prepare(
                    "UPDATE vocab SET next_review = ?1, updated_at = ?2,
                     payload = json_set(payload, '$.nextReview', ?1, '$.updatedAt', ?2)
                     WHERE user_id='me' AND profile_id='default' AND lemma = ?3",
                )
                .unwrap();
            for (lemma, ts) in &spread {
                stmt.execute(rusqlite::params![ts, now, lemma]).unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }
        // 今天只留 1 词 (每日上限 1), 未到期的 future 不动
        let now2 = crate::store::now_ms_for_store();
        let due_after: Vec<String> = repo
            .list("me", "default")
            .iter()
            .filter(|e| e.next_review.map(|t| t <= now2).unwrap_or(true))
            .map(|e| e.lemma.clone())
            .collect();
        assert_eq!(
            due_after,
            vec!["bank"],
            "打散后今天只留 1 词: {due_after:?}"
        );
        assert_eq!(
            repo.get("me", "default", "future").unwrap().next_review,
            Some(now + 86_400_000),
            "未到期词不受影响"
        );
    }
}
