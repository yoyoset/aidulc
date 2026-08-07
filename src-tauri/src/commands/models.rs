//! commands/models.rs —— 模型管理命令 (H2/H4)
//! 薄层: 参数转换 → application::model_service

use crate::application::model_service;
use crate::store;
use tauri::State;

/// 已安装模型列表
#[tauri::command]
pub fn models_list(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let repo = store::model_repo::ModelRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list_all()).map_err(|e| e.to_string())?)
}

/// 某语言某家族的模型 (供书级选择)
#[tauri::command]
pub fn models_by(
    db: State<store::Db>,
    family: String,
    language: String,
) -> Result<serde_json::Value, String> {
    let repo = store::model_repo::ModelRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list_by(&family, &language)).map_err(|e| e.to_string())?)
}

/// 推荐组合 (导入书时自动带出)
#[tauri::command]
pub fn models_recommend(
    db: State<store::Db>,
    language: String,
) -> Result<serde_json::Value, String> {
    let (llm, tts, nlp) = model_service::recommend_bundle(db.inner(), &language);
    Ok(serde_json::json!({
        "llm": llm.map(|m| serde_json::to_value(&m).unwrap_or_default()),
        "tts": tts.map(|m| serde_json::to_value(&m).unwrap_or_default()),
        "nlp": nlp.map(|m| serde_json::to_value(&m).unwrap_or_default()),
    }))
}

/// 登记一个模型 (复用扫描后 / 下载后)
#[tauri::command]
pub fn models_register(
    db: State<store::Db>,
    family: String,
    language: String,
    model_id: String,
    version: String,
    variant: String,
    path: String,
    source_type: String,
    source_ref: String,
    sha256: String,
    size_bytes: i64,
    custom: bool,
) -> Result<String, String> {
    let id = model_service::entry_id(&family, &language, &model_id, &version);
    let mut e = store::model_repo::ModelEntry {
        id: id.clone(),
        family,
        language,
        model_id,
        version,
        variant,
        path,
        source_type,
        source_ref,
        commit_sha: String::new(),
        sha256,
        size_bytes,
        installed_at: crate::commands::library::now_ms(),
        active: false,
        custom,
    };
    model_service::register(db.inner(), &mut e)?;
    Ok(id)
}

/// 设置推荐
#[tauri::command]
pub fn models_set_recommended(db: State<store::Db>, id: String) -> Result<(), String> {
    model_service::set_recommended(db.inner(), &id)
}

/// 移除
#[tauri::command]
pub fn models_remove(db: State<store::Db>, id: String) -> Result<(), String> {
    model_service::remove(db.inner(), &id)
}

/// 扫描模型目录 → 可复用候选
#[tauri::command]
pub fn models_scan(db: State<store::Db>, model_dir: String) -> Result<serde_json::Value, String> {
    let suggestions = model_service::scan_and_suggest(db.inner(), &model_dir);
    Ok(serde_json::json!(suggestions))
}

/// 书级绑定
#[tauri::command]
pub fn models_bind_book(
    db: State<store::Db>,
    book_id: String,
    source_language: String,
    target_language: String,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
) -> Result<(), String> {
    model_service::bind_book(
        db.inner(),
        &book_id,
        &source_language,
        &target_language,
        llm_id,
        tts_id,
        nlp_id,
    )
}

/// 读书级绑定 (书设置弹窗回显用)
#[tauri::command]
pub fn models_book_binding(
    db: State<store::Db>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    Ok(model_service::book_binding(db.inner(), &book_id))
}

/// 下载模型 (阻塞式, 大文件在前端分步调用; 首次实现同步下载)
#[tauri::command]
pub fn models_download(
    url: String,
    dest: String,
    sha256: Option<String>,
) -> Result<serde_json::Value, String> {
    let done = crate::infrastructure::downloader::download(
        &url,
        std::path::PathBuf::from(&dest),
        sha256.as_deref(),
        60,
    )?;
    Ok(serde_json::json!({"path": done.to_string_lossy(), "done": true}))
}

/// 硬件检测 (向导第 2 步)
#[tauri::command]
pub fn hardware_detect(model_dir: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "gpu": crate::infrastructure::downloader::has_nvidia_gpu(),
        "disk_free_bytes": crate::infrastructure::downloader::disk_free_bytes(&model_dir),
    }))
}

// ---- 首次运行向导 (H3) ----

/// 向导状态
#[tauri::command]
pub fn wizard_state(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let (step, status) = crate::application::wizard_service::get_state(db.inner());
    Ok(
        serde_json::json!({"step": step, "status": status, "total": crate::application::wizard_service::TOTAL_STEPS}),
    )
}

/// 提交向导步骤
#[tauri::command]
pub fn wizard_submit(db: State<store::Db>, step: i64, status: String) -> Result<(), String> {
    crate::application::wizard_service::set_step(db.inner(), step, &status)
}

/// 向导完成
#[tauri::command]
pub fn wizard_finish(db: State<store::Db>) -> Result<(), String> {
    crate::application::wizard_service::set_step(
        db.inner(),
        crate::application::wizard_service::TOTAL_STEPS,
        "done",
    )
}
