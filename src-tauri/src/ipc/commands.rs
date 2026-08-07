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
    let repo = crate::store::settings_repo::SettingsRepo::new(db.inner());
    Ok(repo.get(&profile_id))
}

// ---- Profile ----

#[tauri::command]
pub fn profile_upsert(db: State<Db>, profile: Profile) -> Result<(), String> {
    let repo = crate::store::profile_repo::ProfileRepo::new(db.inner());
    repo.upsert(&profile)
}

#[tauri::command]
pub fn profile_list(db: State<Db>) -> Result<serde_json::Value, String> {
    let repo = crate::store::profile_repo::ProfileRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list()).map_err(|e| e.to_string())?)
}

// ---- 阅读状态 ----

#[tauri::command]
pub fn reading_save(db: State<Db>, state: ReadingState) -> Result<(), String> {
    let repo = crate::store::reading_repo::ReadingRepo::new(db.inner());
    repo.upsert(&state)
}

#[tauri::command]
pub fn reading_get(db: State<Db>, book_key: String) -> Result<Option<ReadingState>, String> {
    let repo = crate::store::reading_repo::ReadingRepo::new(db.inner());
    Ok(repo.get(&book_key))
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
