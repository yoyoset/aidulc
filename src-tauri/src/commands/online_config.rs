//! commands/online_config.rs —— 在线 AI 引擎配置命令 (K3, 2026-08-11)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 commands/misc.rs 拆出——
//! OpenAI 兼容在线引擎的配置读写测试是独立于数据根/运行时探针的一个域。

use tauri::State;

// ---- K3 (2026-08-11): 在线 AI 引擎配置 (OpenAI 兼容; key 存 Credential Manager) ----

/// 读在线引擎配置 (endpoint + model; key 只报是否已配置, 不回明文)
#[tauri::command]
pub fn online_config_get(paths: State<crate::DataPaths>) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_get");
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    let key_configured = crate::services::credentials::get_online_key()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "endpoint": cfg.online_endpoint,
        "model": cfg.online_model,
        "key_configured": key_configured,
        "lookup_enabled": cfg.online_lookup_enabled,
        "whole_book_enabled": cfg.online_whole_book_enabled,
    }))
}

/// 写在线引擎配置 (endpoint + model; key 可选, 传入则存 Credential Manager)
/// L8: 两档授权开关独立保存, 默认关; 只有端点+key 齐了才允许开。
#[tauri::command]
pub fn online_config_set(
    paths: State<crate::DataPaths>,
    endpoint: String,
    model: String,
    api_key: Option<String>,
    lookup_enabled: Option<bool>,
    whole_book_enabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_set");
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    cfg.online_endpoint = endpoint;
    cfg.online_model = model;
    if let Some(b) = lookup_enabled {
        cfg.online_lookup_enabled = b;
    }
    if let Some(b) = whole_book_enabled {
        cfg.online_whole_book_enabled = b;
    }
    cfg.save(&cfg_dir)?;
    if let Some(k) = api_key {
        if !k.is_empty() {
            crate::services::credentials::save_online_key(&k)?;
        }
    }
    let key_configured = crate::services::credentials::get_online_key()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "saved": true,
        "key_configured": key_configured,
        "lookup_enabled": cfg.online_lookup_enabled,
        "whole_book_enabled": cfg.online_whole_book_enabled,
    }))
}

/// 在线引擎连通性测试 (最小请求, 确认 endpoint+key+model 可用)
#[tauri::command]
pub fn online_config_test(
    paths: State<crate::DataPaths>,
    endpoint: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_test");
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    let ep = endpoint.unwrap_or(cfg.online_endpoint.clone());
    let md = model.unwrap_or(cfg.online_model.clone());
    let key = match api_key {
        Some(k) if !k.is_empty() => k,
        _ => crate::services::credentials::get_online_key().unwrap_or_default(),
    };
    crate::infrastructure::online_client::test_connection(&ep, &key, &md)
}

/// UX5 #6 (2026-08-13): 「清除在线引擎 key」—— 删 Credential Manager 里的 key。
/// 接上 credentials::delete_online_key (此前写了没接 UI)。清除后 key 未配置态可见,
/// 前端据此置灰两档授权开关。
#[tauri::command]
pub fn online_config_clear_key() -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_clear_key");
    crate::services::credentials::delete_online_key()?;
    Ok(serde_json::json!({
        "cleared": true,
        "key_configured": false,
    }))
}
