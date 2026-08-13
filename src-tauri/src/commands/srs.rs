//! commands/srs.rs —— 背单词调度器命令 (V2, 2026-08-09)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从原 commands/vocab.rs 再拆——
//! 评分/间隔算法调度是独立于"生词本增删查"的一个域(调用 domain::srs 纯函数),
//! 单独成文件。

use crate::store;
use tauri::State;

// ---- 背单词调度器 (V2, 2026-08-09) ----

/// 撤销评分: 把词条恢复到评分前的完整状态 (含 SRS), 用 sync 语义整体覆盖。
/// V3 桌面端"3 秒可撤销"的后端支撑 (撤销栈只存评分前快照, 这里落库还原)。
#[tauri::command]
pub fn vocab_restore(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    entry: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let e: crate::domain::vocab::VocabEntry =
        serde_json::from_value(entry).map_err(|err| format!("撤销快照解析失败: {err}"))?;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let saved = repo.upsert_sync(e, &user_id, &profile_id)?;
    serde_json::to_value(saved).map_err(|e| e.to_string())
}

/// 四档间隔预览: 对当前词按调度器算出 4 个按钮的到期时间 (设计裁决冲突 3:
/// 按钮时间由调度器对当前词算出后返回, 前端不写死)。
#[tauri::command]
pub fn srs_preview(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    lemma: String,
) -> Result<serde_json::Value, String> {
    use crate::domain::srs;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entry = repo
        .get(&user_id, &profile_id, &lemma)
        .ok_or_else(|| "词条不存在".to_string())?;
    let now = crate::store::now_ms_for_store();
    let state = srs::state_from_entry(&entry);
    let opts: Vec<serde_json::Value> = srs::interval_options(&state, now)
        .iter()
        .map(|o| {
            serde_json::json!({
                "grade": o.grade,
                "label": o.label,
                "human": o.human,
                "delta_ms": o.delta_ms,
                "next_review": o.next_review,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "word": entry.word,
        "stage": entry.stage,
        "due": srs::is_due(&state, now),
        "options": opts,
    }))
}

/// 评分: 取 → 算 → 写 (唯一写者 vocab_repo)。返回评分后的新状态。
#[tauri::command]
pub fn srs_grade(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    lemma: String,
    grade: i64,
) -> Result<serde_json::Value, String> {
    use crate::domain::srs;
    if !(1..=4).contains(&grade) {
        return Err("评分必须是 1-4".into());
    }
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entry = repo
        .get(&user_id, &profile_id, &lemma)
        .ok_or_else(|| "词条不存在".to_string())?;
    let now = crate::store::now_ms_for_store();
    let state = srs::state_from_entry(&entry);
    let outcome = srs::apply_grade(&state, grade as u8, now);
    let updated = srs::apply_outcome(entry, &outcome);
    let saved = repo.upsert_sync(updated, &user_id, &profile_id)?;
    serde_json::to_value(saved).map_err(|e| e.to_string())
}
