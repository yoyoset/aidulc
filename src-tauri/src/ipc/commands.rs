//! ipc/commands.rs —— 设置/Profile/阅读状态/传输 命令 (M 系列: 职责按域归位)
//! 生词/词典/同步 → commands/reader.rs (新) ; 此文件只留设置与阅读域。

use crate::store::profile_repo::Profile;
use crate::store::reading_repo::ReadingState;
use crate::store::settings_repo::ReaderSettings;
use crate::store::Db;
use tauri::State;

// ---- 阅读设置 (P2) ----

#[tauri::command]
pub fn settings_upsert(db: State<Db>, settings: ReaderSettings) -> Result<(), String> {
    let repo = crate::store::settings_repo::SettingsRepo::new(db.inner());
    repo.upsert(&settings)
}

#[tauri::command]
pub fn settings_get(db: State<Db>, profile_id: String) -> Result<ReaderSettings, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: settings_get profile={profile_id}"));
    let repo = crate::store::settings_repo::SettingsRepo::new(db.inner());
    Ok(repo.get(&profile_id))
}

// ---- Profile ----

/// 用户列表 (V1 身份模型: 顶栏切人数据源)
#[tauri::command]
pub fn users_list(db: State<Db>) -> Result<serde_json::Value, String> {
    let repo = crate::store::users_repo::UsersRepo::new(db.inner());
    serde_json::to_value(repo.list()).map_err(|e| e.to_string())
}

/// S4 (2026-08-10): 新建本地成员 (顶栏下拉"＋ 新建成员")。
/// 本地 user 与 token 无关 —— 新建的成员天然没有同步 token, 同步状态显示
/// "同步未连接" 是正确行为 (token 按本地 user 分账存, 见 credentials.rs)。
/// 返回新建的 User (含 id), 由前端切到新成员。
#[tauri::command]
pub fn users_create(db: State<Db>, name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    let now = crate::store::now_ms_for_store();
    let id = format!(
        "u_{:x}{:x}",
        now as u64,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0)
    );
    let user = crate::store::users_repo::User {
        id,
        name,
        created_at: now,
        updated_at: now,
    };
    let repo = crate::store::users_repo::UsersRepo::new(db.inner());
    repo.upsert(&user)?;
    serde_json::to_value(&user).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_upsert(db: State<Db>, profile: Profile) -> Result<(), String> {
    let repo = crate::store::profile_repo::ProfileRepo::new(db.inner());
    repo.upsert(&profile)
}

#[tauri::command]
pub fn profile_list(db: State<Db>) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: profile_list");
    let repo = crate::store::profile_repo::ProfileRepo::new(db.inner());
    serde_json::to_value(repo.list()).map_err(|e| e.to_string())
}

/// 删除档案 (M6). J7 (2026-08-11): 内建档案也能删 (且可恢复) —— 统一"能删就都能删",
/// 不搞"成人自读不能删、陪小孩读能删"的不对称。删除后前端 ensureBuiltins 会按内建
/// 默认参数重新补回 (设置页可随时再见到这两套), 不影响已生成的书。
#[tauri::command]
pub fn profile_delete(db: State<Db>, id: String) -> Result<(), String> {
    let repo = crate::store::profile_repo::ProfileRepo::new(db.inner());
    repo.delete(&id)
}

// ---- 摘录标注 (M7 R16) ----

/// 某本书的全部摘录 (按 章/句序 排)
#[tauri::command]
pub fn highlights_list(
    db: State<Db>,
    book_key: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let repo = crate::store::highlights_repo::HighlightsRepo::new(db.inner());
    serde_json::to_value(repo.list_by_book(&user_id, &book_key)).map_err(|e| e.to_string())
}

/// 保存摘录 (新增或更新, 同 id 覆盖)
#[tauri::command]
pub fn highlights_save(
    db: State<Db>,
    highlight: crate::store::highlights_repo::Highlight,
) -> Result<(), String> {
    let repo = crate::store::highlights_repo::HighlightsRepo::new(db.inner());
    repo.upsert(&highlight)
}

/// 删除摘录 (K4: 按 user_id 归属校验, 不再是"传对 id 就能删任何人的摘录")
#[tauri::command]
pub fn highlights_remove(db: State<Db>, id: String, user_id: String) -> Result<(), String> {
    let repo = crate::store::highlights_repo::HighlightsRepo::new(db.inner());
    repo.remove(&user_id, &id)
}

// ---- 阅读状态 ----

#[tauri::command]
pub fn reading_save(db: State<Db>, state: ReadingState) -> Result<(), String> {
    // M7 R37: 保存阅读状态 + 按日记账 (time_spent_ms 增量记到当天)
    let repo = crate::store::reading_repo::ReadingRepo::new(db.inner());
    repo.save_with_daily(&state)
}

/// M7 R37: 某书近 N 天每日阅读时长 + 今日累计 (前端"今日已读 X 分钟")
#[tauri::command]
pub fn reading_stats(
    db: State<Db>,
    book_key: String,
    user_id: String,
    days: Option<i64>,
) -> Result<serde_json::Value, String> {
    let repo = crate::store::reading_repo::ReadingRepo::new(db.inner());
    let n = days.unwrap_or(7).clamp(1, 60);
    let today = crate::store::now_ms_for_store() / 86_400_000;
    let from = today - (n - 1);
    let daily: Vec<serde_json::Value> = repo
        .daily_times(&user_id, &book_key, from, today)
        .into_iter()
        .map(|(day, ms)| serde_json::json!({ "day": day, "ms": ms }))
        .collect();
    let today_ms = daily
        .iter()
        .find(|d| d["day"].as_i64() == Some(today))
        .map(|d| d["ms"].as_i64().unwrap_or(0))
        .unwrap_or(0);
    Ok(serde_json::json!({ "today_ms": today_ms, "days": daily }))
}

#[tauri::command]
pub fn reading_get(
    db: State<Db>,
    book_key: String,
    user_id: String,
) -> Result<Option<ReadingState>, String> {
    let repo = crate::store::reading_repo::ReadingRepo::new(db.inner());
    Ok(repo.get(&user_id, &book_key))
}

// ---- .aidu-data 导入/导出 (M1) ----

#[tauri::command]
pub fn transfer_export(db: State<Db>) -> Result<serde_json::Value, String> {
    crate::application::transfer_service::export_aidu_data(db.inner())
}

#[tauri::command]
pub fn transfer_import(
    db: State<Db>,
    backup: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::application::transfer_service::import_aidu_data(db.inner(), &backup)
}
