//! commands/reader.rs —— 查词/生词/词典命令 (I-A/I-B)

use crate::application::dictionary_service;
use crate::store;
use tauri::State;

/// 查词 (本地优先 → LLM 补全)
/// 未命中本地词典时 spawn 侧车 dict-lookup (复用 PrepConfig.llm_model);
/// 侧车不可用/超时 → 占位兜底 (source=llm, 可读提示)。
#[tauri::command]
pub fn word_lookup(
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    word: String,
    profile_id: String,
    context: String,
) -> Result<serde_json::Value, String> {
    let prep_path = cfg.inner().prep_path.clone();
    // M 系列 (单一真相源): LLM 路径从 model_registry 推荐解析
    let (llm_model, _, _) = crate::application::model_service::resolve_paths(db.inner(), "en");
    let lookup_fn = move |w: &str, ctx: &str| {
        let configured = !llm_model.is_empty() && std::path::Path::new(&llm_model).exists();
        if configured {
            // F21 (2026-08-08): 常驻词典守护 —— 侧车加载模型一次, 不再每次重载 2.4GB
            if let Ok(v) =
                crate::infrastructure::dict_daemon::lookup(&prep_path, &llm_model, w, ctx)
            {
                if let Ok(parsed) = daemon_result_to_tuple(&v) {
                    return Ok(parsed);
                }
            }
            // F40 (2026-08-08): 模型在但查询失败 → 明确说"查询失败", 别误导成"未配置"
            return Ok((
                "NOUN".into(),
                String::new(),
                vec![format!("{w} 的词义查询失败 (模型已配置但未返回结果)")],
                vec![],
                vec![],
                String::new(),
                vec![],
            ));
        }
        // 兜底: 未配置 → 占位 (不阻断查词)
        Ok((
            "NOUN".into(),
            String::new(),
            vec![format!("{w} 的词义待补充(未配置 LLM 模型)")],
            vec![],
            vec![],
            String::new(),
            vec![],
        ))
    };
    let result = dictionary_service::lookup(db.inner(), &profile_id, &word, &context, &lookup_fn)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// 词典守护的 result JSON → dictionary_service 的元组。字段缺失给空值, 不报错。
fn daemon_result_to_tuple(
    v: &serde_json::Value,
) -> Result<
    (
        String,
        String,
        Vec<String>,
        Vec<String>,
        Vec<String>,
        String,
        Vec<String>,
    ),
    String,
> {
    let str_vec = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let meanings = str_vec("meanings");
    if meanings.is_empty() {
        return Err("词典守护无释义".into());
    }
    Ok((
        v.get("pos")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        v.get("phonetic")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        meanings,
        str_vec("examples"),
        str_vec("example_zh"),
        v.get("usage")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        str_vec("phrases"),
    ))
}

/// 显式加入生词本
#[tauri::command]
pub fn add_vocab(
    db: State<store::Db>,
    word: String,
    profile_id: String,
    context: Option<String>,
) -> Result<serde_json::Value, String> {
    dictionary_service::add_to_vocab(db.inner(), &profile_id, &word, context)
}

/// 词典列表 (某 profile)
#[tauri::command]
pub fn dict_list(db: State<store::Db>, profile_id: String) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    serde_json::to_value(repo.list_by_profile(&profile_id)).map_err(|e| e.to_string())
}

/// 词典搜索
#[tauri::command]
pub fn dict_search(
    db: State<store::Db>,
    profile_id: String,
    q: String,
) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    serde_json::to_value(repo.search(&profile_id, &q)).map_err(|e| e.to_string())
}

/// 词典删除
#[tauri::command]
pub fn dict_remove(db: State<store::Db>, key: String, profile_id: String) -> Result<(), String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    repo.remove(&key, &profile_id)
}

// ---- 生词本 (I-B) ----

/// 生词列表
#[tauri::command]
pub fn vocab_all(db: State<store::Db>, profile_id: String) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    serde_json::to_value(repo.list(&profile_id)).map_err(|e| e.to_string())
}

/// 生词搜索
#[tauri::command]
pub fn vocab_search(
    db: State<store::Db>,
    profile_id: String,
    q: String,
) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    serde_json::to_value(repo.search(&profile_id, &q)).map_err(|e| e.to_string())
}

/// 删除生词
#[tauri::command]
pub fn vocab_remove(db: State<store::Db>, profile_id: String, lemma: String) -> Result<(), String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    repo.remove(&profile_id, &lemma)
}

/// 生词统计
#[tauri::command]
pub fn vocab_stats(db: State<store::Db>, profile_id: String) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    Ok(repo.stats(&profile_id))
}

// ---- 同步 (I-C: 状态机 + 配置) ----

/// 同步状态
#[tauri::command]
pub fn sync_status(
    db: State<store::Db>,
    services: State<crate::AppServices>,
) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::get_status(db.inner(), &url, &token);
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 立即同步 (push)
#[tauri::command]
pub fn sync_now(
    db: State<store::Db>,
    services: State<crate::AppServices>,
) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::sync_now(db.inner(), &url, &token)?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 拉取合并
#[tauri::command]
pub fn sync_pull_now(
    db: State<store::Db>,
    services: State<crate::AppServices>,
) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::sync_pull(db.inner(), &url, &token)?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 同步配置 (URL + token; token 存 Credential Manager; 即时生效)
#[tauri::command]
pub fn sync_config_set(
    services: State<crate::AppServices>,
    worker_url: String,
    token: String,
) -> Result<(), String> {
    use crate::services::config;
    // 持久化 worker_url 到 config.toml
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let mut cfg = config::Config::load(&exe_dir);
    cfg.cf_worker_url = worker_url.clone();
    let _ = std::fs::write(
        exe_dir.join("config.toml"),
        toml::to_string_pretty(&cfg).unwrap_or_default(),
    );
    // token 存 Credential Manager (永不落明文)
    if !token.is_empty() {
        crate::services::credentials::save_cf_token(&token)?;
    }
    // 更新内存态 (即时生效)
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = worker_url;
    *svc.cf_token.lock().unwrap() =
        crate::services::credentials::get_cf_token().unwrap_or_default();
    Ok(())
}

/// R2-1 (2026-08-08): 断开同步 —— 三处一起清, 否则语义不干净:
/// 只删 token 的话 sync_status 会回 unconfigured, 但 config.toml 残留旧 URL,
/// 日后重配 token 会"复活"旧地址; 内存态不清则当前会话仍显示已配置。
#[tauri::command]
pub fn sync_disconnect(services: State<crate::AppServices>) -> Result<(), String> {
    use crate::services::config;
    // 1. 删 Credential Manager 里的 token (没配置时无可删, 忽略)
    let _ = crate::services::credentials::delete_cf_token();
    // 2. 清 config.toml 的 cf_worker_url
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let mut cfg = config::Config::load(&exe_dir);
    cfg.cf_worker_url = String::new();
    std::fs::write(
        exe_dir.join("config.toml"),
        toml::to_string_pretty(&cfg).unwrap_or_default(),
    )
    .map_err(|e| {
        format!("清 config.toml 失败 (token 已删但 URL 残留, 请手动删除 config.toml): {e}")
    })?;
    // 3. 清内存态 (即时生效)
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = String::new();
    *svc.cf_token.lock().unwrap() = String::new();
    // 4. 清上次同步结果 (防断开后旧的 "synced 时间" 残留展示)
    crate::application::sync_service::reset_last_sync();
    Ok(())
}

// ---- 书签 (I-D) ----

/// 书签列表 (本书所有书签句子)
#[tauri::command]
pub fn bookmarks_list(
    db: State<store::Db>,
    book_key: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::reading_repo::ReadingRepo::new(db.inner());
    let state = repo.get(&book_key);
    // 返回带句文本的书签 (前端从 bookpack 拿文本; 这里先返回下标)
    Ok(serde_json::json!({
        "book_key": book_key,
        "profile_id": profile_id,
        "bookmarks": state.map(|s| s.bookmarks).unwrap_or_default(),
    }))
}

// ---- 日志 (用户反馈排查) ----

/// 前端错误/警告落盘 (全局 error/unhandledrejection 捕获)
#[tauri::command]
pub fn log_from_frontend(level: String, module: String, message: String) -> Result<(), String> {
    crate::infrastructure::log::log_from_frontend(level, module, message)
}

/// 当前日志文件路径 (设置页"打开日志")
#[tauri::command]
pub fn log_path() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "path": crate::infrastructure::log::log_path() }))
}
