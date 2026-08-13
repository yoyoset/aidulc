//! commands/sync_backend.rs —— 同步状态/配置/多后端管理命令 (I-C, L11/M3)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 commands/reader.rs 拆出——
//! 这些命令管的是"同步后端(哪台服务器/哪个 worker)怎么连、怎么切、怎么断"这一个真实域,
//! 和阅读/词典完全不相关。Tauri 命令名不变, 只是物理文件挪动。

use crate::store;
use tauri::State;

/// M3 (2026-08-13): 解析某 user 在当前生效后端的同步凭据。
/// 返回 (endpoint_key, token, server_user)。兼容迁移:
///   1. 服务端 user: 优先按 (user, url) 新 key, 回退 V6 老 key;
///   2. token: 优先按 (user, endpoint_key) 新 key, 老 V6 key 读得到就迁 (migrate_cf_token_for),
///      迁不动明确报错 (不静默丢 token)。
fn endpoint_state(user_id: &str, url: &str) -> Result<(String, String, String), String> {
    use crate::services::credentials;
    let mut server_user =
        credentials::get_server_user_for_endpoint(user_id, url).unwrap_or_default();
    if server_user.is_empty() {
        server_user = credentials::get_server_user_for(user_id).unwrap_or_default();
    }
    let endpoint_key = format!("{url}|{server_user}");
    // token: 老 V6 key → 新 (user, endpoint) key 迁移 (读得到就迁)
    credentials::migrate_cf_token_for(user_id, &endpoint_key)?;
    let token = credentials::get_cf_token_for_endpoint(user_id, &endpoint_key).unwrap_or_default();
    Ok((endpoint_key, token, server_user))
}

/// 当前 user 的同步状态
/// K2 (2026-08-11): 改 async —— keyring (Credential Manager) 读可能慢/卡 (实测记录过耗时),
/// 网络状态查询也可能走同步链, 不再跑主线程。
#[tauri::command]
pub async fn sync_status(
    db: State<'_, store::Db>,
    services: State<'_, crate::AppServices>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_status user={user_id}"));
    let t0 = crate::store::now_ms_for_store();
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let (endpoint_key, token, _server_user) = endpoint_state(&user_id, &url)?;
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "sync_status keyring_read {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    let s = crate::application::sync_service::get_status(
        db.inner(),
        &url,
        &token,
        &user_id,
        &endpoint_key,
    );
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 立即同步 (某 user): M3 —— 对当前主体已启用后端依次先推后拉。
/// K2 (2026-08-11): 改 async (同 sync_status)。
#[tauri::command]
pub async fn sync_now(
    db: State<'_, store::Db>,
    services: State<'_, crate::AppServices>,
    paths: State<'_, crate::DataPaths>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let t0 = crate::store::now_ms_for_store();
    crate::infrastructure::log::info("cmd", &format!("enter: sync_now user={user_id}"));
    let svc = services.inner();
    let active_url = svc.cf_worker_url.lock().unwrap().clone();
    // 确保当前生效后端的 V6 老 token 迁移到 (user, endpoint) 新 key
    let (epk, _t, _su) = endpoint_state(&user_id, &active_url)?;
    let _ = epk;
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    let (backends, _) = cfg.backends_including_active();
    let results = crate::application::sync_service::sync_now_all(
        db.inner(),
        &user_id,
        &backends,
        &active_url,
    )?;
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "exit: sync_now {}ms ({} 个后端)",
            crate::store::now_ms_for_store() - t0,
            results.len()
        ),
    );
    serde_json::to_value(results).map_err(|e| e.to_string())
}

/// F4 (2026-08-11): 强制全量重推 —— 清该 user 的 sync_state (last_push_at=0, endpoint_key 清空),
/// 下次"立即同步"按从未同步全量重推。服务端数据被清后 endpoint_key 仍匹配, A1 不会自动重推,
/// 用户需要这个手动兜底。本地操作, 无需 async。
#[tauri::command]
pub fn sync_force_full(db: State<store::Db>, user_id: String) -> Result<(), String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_force_full user={user_id}"));
    crate::application::sync_service::force_full_reset(db.inner(), &user_id)
}

// ---- L11/M3 (2026-08-11/13): 多后端配置 —— 主体 × 后端矩阵 ----

/// 后端列表: 每项 = 名称 + URL + 状态 (当前生效高亮 / 是否已连接 / 该 user 是否启用)。
/// M3 (2026-08-13): 每项加「同步此后端」勾选状态 (当前主体自己的启用状态) + 所属主体。
/// 首次读时把当前 cf_worker_url 补成「默认后端」, 列表不为空。
#[tauri::command]
pub fn sync_backends_list(
    paths: State<'_, crate::DataPaths>,
    services: State<'_, crate::AppServices>,
    db: State<'_, store::Db>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_backends_list user={user_id}"));
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    let (list, changed) = cfg.backends_including_active();
    if changed {
        let _ = cfg.save(&cfg_dir);
    }
    let active_url = services.inner().cf_worker_url.lock().unwrap().clone();
    let user_name = store::users_repo::UsersRepo::new(db.inner())
        .get(&user_id)
        .map(|u| u.name)
        .unwrap_or_else(|| user_id.clone());
    let out: Vec<serde_json::Value> = list
        .into_iter()
        .map(|b| {
            use crate::application::sync_service::endpoint_key_for;
            use crate::services::credentials;
            let server_user =
                credentials::get_server_user_for_endpoint(&user_id, &b.url).unwrap_or_default();
            let endpoint_key = endpoint_key_for(&b.url, &server_user);
            // token: 新 (user, endpoint) key 优先, 老 V6 key 兜底
            let mut token =
                credentials::get_cf_token_for_endpoint(&user_id, &endpoint_key).unwrap_or_default();
            if token.is_empty() {
                token = credentials::get_cf_token_for(&user_id).unwrap_or_default();
            }
            let connected = !b.url.is_empty() && !token.is_empty();
            let (has_row, en) = store::sync_state_repo::SyncStateRepo::new(db.inner())
                .enabled_flag(&user_id, &endpoint_key);
            let enabled = if has_row { en } else { b.url == active_url };
            serde_json::json!({
                "name": b.name,
                "url": b.url,
                "active": b.url == active_url,
                "connected": connected,
                "enabled": enabled,
                "subject": user_name,
            })
        })
        .collect();
    crate::infrastructure::log::info("cmd", &format!("sync_backends_list {} 个", out.len()));
    serde_json::to_value(out).map_err(|e| e.to_string())
}

/// M3 (2026-08-13): 勾选/取消某后端的「同步此后端」—— 当前主体 × 该后端 一格。
#[tauri::command]
pub fn sync_backend_toggle(
    paths: State<'_, crate::DataPaths>,
    db: State<'_, store::Db>,
    user_id: String,
    name: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info(
        "cmd",
        &format!("enter: sync_backend_toggle {name} user={user_id} enabled={enabled}"),
    );
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    let backend = cfg
        .sync_backends
        .iter()
        .find(|b| b.name == name)
        .ok_or_else(|| format!("后端不存在: {name}"))?;
    use crate::application::sync_service::endpoint_key_for;
    use crate::services::credentials;
    let server_user =
        credentials::get_server_user_for_endpoint(&user_id, &backend.url).unwrap_or_default();
    let endpoint_key = endpoint_key_for(&backend.url, &server_user);
    store::sync_state_repo::SyncStateRepo::new(db.inner()).set_enabled(
        &user_id,
        &endpoint_key,
        enabled,
    )?;
    Ok(serde_json::json!({
        "ok": true,
        "name": name,
        "enabled": enabled,
        "endpoint_key": endpoint_key,
    }))
}

/// 新增后端 (只加进列表, 不切换)。名称重复或 URL 重复 → 拒绝。
#[tauri::command]
pub fn sync_backend_add(
    paths: State<'_, crate::DataPaths>,
    name: String,
    url: String,
) -> Result<(), String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_backend_add {name} {url}"));
    let name = name.trim().to_string();
    let url = url.trim().to_string();
    if name.is_empty() || url.is_empty() {
        return Err("名称和 Worker URL 都要填".into());
    }
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    if cfg.sync_backends.iter().any(|b| b.name == name) {
        return Err(format!("已存在同名后端: {name}"));
    }
    if cfg.sync_backends.iter().any(|b| b.url == url) {
        return Err("已存在相同 URL 的后端".into());
    }
    cfg.sync_backends
        .push(crate::services::config::SyncBackend::new(name, url));
    cfg.save(&cfg_dir)
}

/// 切换后端 —— 改 cf_worker_url。sync_state.endpoint_key 按 URL+服务端 user 分账,
/// 不匹配时下次同步自动全量重推 (A1 机制, 天然支持, 不新造)。
#[tauri::command]
pub fn sync_backend_switch(
    paths: State<'_, crate::DataPaths>,
    services: State<'_, crate::AppServices>,
    name: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_backend_switch {name}"));
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    let (new_url, switched) = backend_switch_target(&cfg.sync_backends, &cfg.cf_worker_url, &name)?;
    if !switched {
        return Ok(serde_json::json!({ "switched": false, "already": true, "url": new_url }));
    }
    cfg.cf_worker_url = new_url.clone();
    cfg.save(&cfg_dir)?;
    // 运行时生效 (AppServices.cf_worker_url 是同步命令读的)
    *services.inner().cf_worker_url.lock().unwrap() = new_url.clone();
    crate::infrastructure::log::info(
        "cmd",
        &format!("sync_backend_switch -> {url}", url = new_url),
    );
    Ok(serde_json::json!({
        "switched": true,
        "url": new_url,
        "full_repush_on_next_sync": true,
    }))
}

/// L11: 纯逻辑判定"切到 name 后 cf_worker_url 变成什么"。
/// 返回 (新 url, 是否真的切换)。不含 config 文件 IO 与 State, 命令与单测共用。
fn backend_switch_target(
    backends: &[crate::services::config::SyncBackend],
    current_url: &str,
    name: &str,
) -> Result<(String, bool), String> {
    let target = backends
        .iter()
        .find(|b| b.name == name)
        .ok_or_else(|| format!("后端不存在: {name}"))?;
    if target.url == current_url {
        Ok((target.url.clone(), false))
    } else {
        Ok((target.url.clone(), true))
    }
}

/// 删除后端 (不能删当前生效的那个)。
#[tauri::command]
pub fn sync_backend_remove(
    paths: State<'_, crate::DataPaths>,
    services: State<'_, crate::AppServices>,
    name: String,
) -> Result<(), String> {
    crate::infrastructure::log::info("cmd", &format!("enter: sync_backend_remove {name}"));
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    let active_url = services.inner().cf_worker_url.lock().unwrap().clone();
    let idx = cfg
        .sync_backends
        .iter()
        .position(|b| b.name == name)
        .ok_or_else(|| format!("后端不存在: {name}"))?;
    if cfg.sync_backends[idx].url == active_url {
        return Err("不能删除当前生效的后端, 先切换到别处再删".into());
    }
    cfg.sync_backends.remove(idx);
    cfg.save(&cfg_dir)
}

/// 拉取合并 (某 user, 当前生效后端)
/// K2 (2026-08-11): 改 async (同 sync_now)。
#[tauri::command]
pub async fn sync_pull_now(
    db: State<'_, store::Db>,
    services: State<'_, crate::AppServices>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let t0 = crate::store::now_ms_for_store();
    crate::infrastructure::log::info("cmd", &format!("enter: sync_pull_now user={user_id}"));
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let (endpoint_key, token, server_user) = endpoint_state(&user_id, &url)?;
    let s = crate::application::sync_service::sync_pull(
        db.inner(),
        &url,
        &token,
        &server_user,
        &user_id,
        &endpoint_key,
    )?;
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "exit: sync_pull_now {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// V6: 首台 (ROOT_SECRET) 或 6 位码 换该 user 的 token (协议 v1 auth/device)。
/// root_secret 与 code 二选一; 成功后存 Credential Manager (按 user 分账) + 存 worker_url。
/// K2 (2026-08-11): 改 async + spawn_blocking —— auth_device 是网络调用 (15s 超时 ×3 重试)。
#[tauri::command]
pub async fn sync_auth_device(
    services: State<'_, crate::AppServices>,
    paths: State<'_, crate::DataPaths>,
    worker_url: String,
    user_id: String,
    root_secret: Option<String>,
    code: Option<String>,
    device_name: String,
) -> Result<serde_json::Value, String> {
    use crate::services::config;
    let t0 = crate::store::now_ms_for_store();
    crate::infrastructure::log::info("cmd", &format!("enter: sync_auth_device user={user_id}"));
    let rs = root_secret.clone();
    let cd = code.clone();
    let dn = device_name.clone();
    let wu = worker_url.clone();
    let auth = tauri::async_runtime::spawn_blocking(move || {
        crate::infrastructure::sync_v1_client::auth_device(&wu, rs.as_deref(), cd.as_deref(), &dn)
    })
    .await
    .map_err(|e| format!("换 token 任务执行失败: {e}"))??;
    if !auth.token.is_empty() {
        crate::services::credentials::save_cf_token_for(&user_id, &auth.token)?;
    }
    // UX A1: 记下 token 属于服务端哪个 user (此前被丢掉) —— endpoint_key 用它在下次
    // 同步时判定"换 URL / 换 token 后是否还是同一份同步进度"。忘了记 = 下次同步按
    // 从未同步全量重推 (宁可多推, 不可少推), 不造成数据丢失。
    crate::services::credentials::save_server_user_for(&user_id, &auth.user_id)?;
    // UX5 #3 (M3): token/服务端 user 也按 (主体, 后端) 分账 —— 同 URL 不同服务端 user 是另一格
    crate::services::credentials::save_cf_token_for_endpoint(
        &user_id,
        &format!("{worker_url}|{}", auth.user_id),
        &auth.token,
    )?;
    crate::services::credentials::save_server_user_for_endpoint(
        &user_id,
        &worker_url,
        &auth.user_id,
    )?;
    // 持久化 worker_url 到 config.toml (J0: 配置文件随数据根走)
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = config::Config::load(&cfg_dir);
    cfg.cf_worker_url = worker_url.clone();
    // Bug fix (2026-08-13): 原来 `let _ = std::fs::write(...unwrap_or_default())` 吞掉序列化/写盘
    // 失败 —— 序列化失败会写空文件、写盘失败静默, 配置悄悄丢。改走 Config::save 显式报错。
    cfg.save(&cfg_dir)
        .map_err(|e| format!("保存同步配置失败: {e}"))?;
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = worker_url;
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "exit: sync_auth_device {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    serde_json::to_value(auth).map_err(|e| e.to_string())
}

/// V6: 已登录 user 生成 6 位一次性码 (add-device / invite-user)
/// K2 (2026-08-11): 改 async + spawn_blocking —— make_code 是网络调用。
#[tauri::command]
pub async fn sync_make_code(
    services: State<'_, crate::AppServices>,
    user_id: String,
    code_type: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let t0 = crate::store::now_ms_for_store();
    crate::infrastructure::log::info("cmd", &format!("enter: sync_make_code user={user_id}"));
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    let nm = name;
    let ct = code_type;
    let r = tauri::async_runtime::spawn_blocking(move || {
        crate::infrastructure::sync_v1_client::make_code(&url, &token, &ct, nm.as_deref())
    })
    .await
    .map_err(|e| format!("生成邀请码任务执行失败: {e}"))??;
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "exit: sync_make_code {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    serde_json::to_value(r).map_err(|e| e.to_string())
}

/// V6: 断开该 user 的同步 —— 删该 user 的 token (URL 共享, 只清 token)。
/// M3 (2026-08-13): 同时删 (user, endpoint) 新 key 的 token (当前生效后端那一格); 老 V6 key 一并删。
/// K2: 本地操作 (Credential Manager + 读内存态), 无网络, 无需 async。
#[tauri::command]
pub fn sync_disconnect(
    services: State<'_, crate::AppServices>,
    user_id: String,
) -> Result<(), String> {
    let url = services.inner().cf_worker_url.lock().unwrap().clone();
    let _ = endpoint_state(&user_id, &url).map(|(endpoint_key, _, _)| {
        let _ = crate::services::credentials::delete_cf_token_for_endpoint(&user_id, &endpoint_key);
    });
    let _ = crate::services::credentials::delete_cf_token_for(&user_id);
    crate::application::sync_service::reset_last_sync(&user_id);
    Ok(())
}

/// P0-C (2026-08-10): 手机扫码配对 —— 复用现成链路 (auth/code 生成 add-device 码 →
/// auth/device 立即兑换) 换取一个**独立的 device token**, 生成二维码内容
/// `https://aidulc-mobile.pages.dev/#t=<token>&u=<worker_url>`。
/// 与 sync_make_code/sync_auth_device 的差别: 新 token **不**写入 Credential Manager,
/// 桌面端保留自己的 token (手机 token 是给"另一台设备"的, 错了能踢)。
/// K2 (2026-08-11): 改 async + spawn_blocking —— 两次网络调用。
#[tauri::command]
pub async fn sync_pair_qr(
    services: State<'_, crate::AppServices>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    if url.is_empty() || token.is_empty() {
        return Err("先配置同步 (Worker URL + 换 token) 才能生成配对码".into());
    }
    let u = url.clone();
    let t = token;
    let (_code, auth) = tauri::async_runtime::spawn_blocking(move || {
        // 1. 生成 add-device 码 (绑当前 user, 现成接口)
        let code = crate::infrastructure::sync_v1_client::make_code(&u, &t, "add-device", None)
            .map_err(|e| format!("生成配对码失败: {e}"))?;
        // 2. 立即兑换成独立 device token (现成接口)
        let auth =
            crate::infrastructure::sync_v1_client::auth_device(&u, None, Some(&code.code), "手机")
                .map_err(|e| format!("兑换手机 token 失败: {e}"))?;
        Ok::<_, String>((code, auth))
    })
    .await
    .map_err(|e| format!("配对任务执行失败: {e}"))??;
    let mobile_url = crate::infrastructure::sync_v1_client::MOBILE_APP_URL.to_string();
    let content = format!(
        "{mobile_url}#t={}&u={}",
        auth.token,
        crate::infrastructure::sync_v1_client::url_encode_component(&url)
    );
    let svg = qrcode_svg(&content);
    Ok(serde_json::json!({
        "worker_url": url,
        "token": auth.token,
        "user_id": auth.user_id,
        "device_id": auth.device_id,
        "qr_svg": svg,
        "qr_content": content,
    }))
}

/// P0-C (2026-08-10): 踢掉配对设备 —— 调 worker /v1/auth/revoke (删 auth:{token} 即失效)。
/// 手机端"拿到链接的人就能读你的词库"的收回手段: 配对后随时可踢, 被踢 token 立刻 401。
/// K2 (2026-08-11): 改 async + spawn_blocking —— revoke 是网络调用。
#[tauri::command]
pub async fn sync_revoke_token(
    services: State<'_, crate::AppServices>,
    user_id: String,
    target_token: String,
) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    if url.is_empty() || token.is_empty() {
        return Err("先配置同步才能踢设备".into());
    }
    let tt = target_token;
    tauri::async_runtime::spawn_blocking(move || {
        crate::infrastructure::sync_v1_client::revoke_token(&url, &token, &tt)
    })
    .await
    .map_err(|e| format!("踢设备任务执行失败: {e}"))?
}

/// 二维码 → SVG 字符串 (qrcode crate, ECC 默认 L/M 由 crate 自动选版; 白底黑块)。
/// 内容太长 (token 48 hex + 编码后的 url) 由 crate 自动升版, 手机相机都能扫。
fn qrcode_svg(content: &str) -> String {
    use qrcode::render::svg;
    use qrcode::QrCode;
    match QrCode::new(content.as_bytes()) {
        Ok(code) => {
            let img = code.render::<svg::Color>().min_dimensions(5, 5).build();
            img.to_string()
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod pairing_tests {
    use super::qrcode_svg;

    #[test]
    fn qr_svg_is_nonempty_svg() {
        // P0-C: 二维码必须是可渲染的 SVG (内容含 token, 长度 ~260 字符 → 高版本)
        let content = format!(
            "https://aidulc-mobile.pages.dev/#t={}&u=https%3A%2F%2Faidulc.example.workers.dev",
            "a".repeat(48)
        );
        let svg = qrcode_svg(&content);
        assert!(
            svg.contains("<svg"),
            "应产出 svg: {}",
            &svg[..40.min(svg.len())]
        );
        assert!(svg.len() > 200, "SVG 内容不应为空壳: len={}", svg.len());
        assert!(svg.contains("<path"), "应有 path 数据块");
        assert!(
            !svg.contains("a".repeat(40).as_str()),
            "SVG 不应泄漏 token 明文"
        );
    }

    #[test]
    fn qr_svg_handles_unencodable_gracefully() {
        // 极端长度 → 超 QR 容量时返回空串 (不 panic), 前端降级成文本链接
        let svg = qrcode_svg(&"x".repeat(4000));
        assert!(svg.is_empty() || svg.starts_with("<svg"));
    }
}

/// 同步配置 (URL + token; token 存 Credential Manager; 即时生效)
/// 保留旧命令面 (旧前端/兼容); V6 新流程走 sync_auth_device。
#[tauri::command]
pub fn sync_config_set(
    services: State<crate::AppServices>,
    paths: State<crate::DataPaths>,
    worker_url: String,
    token: String,
) -> Result<(), String> {
    use crate::services::config;
    // 持久化 worker_url 到 config.toml (J0: 配置文件随数据根走)
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = config::Config::load(&cfg_dir);
    cfg.cf_worker_url = worker_url.clone();
    // Bug fix (2026-08-13): 同 sync_auth_device —— 吞掉写盘失败会让配置悄悄丢。
    cfg.save(&cfg_dir)
        .map_err(|e| format!("保存同步配置失败: {e}"))?;
    // token 存 Credential Manager (永不落明文); 兼容旧默认 user
    if !token.is_empty() {
        crate::services::credentials::save_cf_token_for(
            crate::store::users_repo::DEFAULT_USER_ID,
            &token,
        )?;
    }
    // 更新内存态 (即时生效)
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = worker_url;
    Ok(())
}

#[cfg(test)]
mod l11_backend_switch_tests {
    use super::backend_switch_target;
    use crate::services::config::SyncBackend;

    #[test]
    fn switch_changes_url_and_marks_repush() {
        // L11 (2026-08-11): 切换后端 → cf_worker_url 变成目标 URL 且标记需全量重推
        // (endpoint_key 不匹配 → 下次同步全量对齐, 即"切换后生词本内容随之切换"的机制)。
        let backends = vec![
            SyncBackend::new("家里".into(), "https://home.example.workers.dev".into()),
            SyncBackend::new("单位".into(), "https://work.example.workers.dev".into()),
        ];
        let (url, switched) =
            backend_switch_target(&backends, "https://home.example.workers.dev", "单位").unwrap();
        assert_eq!(url, "https://work.example.workers.dev");
        assert!(switched, "切到不同 URL 应视为切换");
    }

    #[test]
    fn switch_to_same_url_is_noop() {
        // 切到当前已生效的后端 → 不切换 (返回 already, 不重复全量重推)
        let backends = vec![SyncBackend::new(
            "家里".into(),
            "https://home.example.workers.dev".into(),
        )];
        let (url, switched) =
            backend_switch_target(&backends, "https://home.example.workers.dev", "家里").unwrap();
        assert_eq!(url, "https://home.example.workers.dev");
        assert!(!switched, "同 URL 不应视为切换");
    }

    #[test]
    fn switch_to_unknown_name_errors() {
        let backends = vec![SyncBackend::new(
            "家里".into(),
            "https://home.example.workers.dev".into(),
        )];
        assert!(
            backend_switch_target(&backends, "https://home.example.workers.dev", "不存在").is_err()
        );
    }
}
