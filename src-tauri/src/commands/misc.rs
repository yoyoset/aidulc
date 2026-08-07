//! commands/misc.rs —— 杂项命令 (M 系列: 从 main.rs 移出, main 只做组装)
//! runtime_config / components_health / boot_ping / log_*

use crate::{LibraryState, PrepConfig};
use tauri::State;

/// 运行时配置 (模型/工具路径) — 前端 ImportService 组装 job 参数用
/// M 系列: 模型路径从 model_registry 推荐解析 (单一真相源)
#[tauri::command]
pub fn runtime_config(
    cfg: State<PrepConfig>,
    db: State<crate::store::Db>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    Ok(serde_json::json!({
        "llm_model": llm,
        "tts_model": tts,
        "ffmpeg": cfg.ffmpeg.to_string_lossy(),
    }))
}

/// G5: 组件健康检查 (首次运行向导/组件中心)
/// M 系列: 模型从 model_registry 解析 (单一真相源), 不再读 PrepConfig 第二份状态
#[tauri::command]
pub fn components_health(
    cfg: State<PrepConfig>,
    state: State<LibraryState>,
    db: State<crate::store::Db>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let lib = state.dir.lock().unwrap().clone();
    let hf = std::env::var("HF_HOME").unwrap_or_default();
    // en 是当前唯一支持语言 (H4); 多语言后按书语言查询
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    let checks = crate::services::components::health_check(cfg.inner(), &lib, &hf, &llm, &tts);
    serde_json::to_value(checks).map_err(|e| e.to_string())
}

/// boot 探针 (开发用: 验证进程活着)
#[tauri::command]
pub fn boot_ping(message: String) -> String {
    let path = std::env::temp_dir().join("aidulc_boot_ping.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(f, "boot_ping: {}", message);
    }
    format!("pong: {}", message)
}
