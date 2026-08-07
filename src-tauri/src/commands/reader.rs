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
        if !llm_model.is_empty() && std::path::Path::new(&llm_model).exists() {
            if let Ok(v) = llm_dict_lookup(&prep_path, &llm_model, w, ctx) {
                return Ok(v);
            }
        }
        // 兜底: 无模型/失败 → 占位 (不阻断查词)
        Ok(("NOUN".into(), String::new(), vec![format!("{w} 的词义待补充(未配置 LLM 模型)")], vec![], vec![], String::new(), vec![]))
    };
    let result = dictionary_service::lookup(db.inner(), &profile_id, &word, &context, &lookup_fn)?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

/// spawn 侧车 dict-lookup: python -m aidulc_prep.dict_lookup --model <m> --word <w> --context <ctx>
/// 阻塞读 stdout 一行 JSON (词查询 <2s), 8s 超时兜底。
fn llm_dict_lookup(
    prep_path: &std::path::Path,
    model: &str,
    word: &str,
    context: &str,
) -> Result<(String, String, Vec<String>, Vec<String>, Vec<String>, String, Vec<String>), String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(prep_path);
    cmd.args(["--lookup-model", model, "--lookup-word", word])
        .args(["--lookup-context", context])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("启动词典补全失败: {e}"))?;
    let mut out = String::new();
    child.stdout.take().ok_or("无法取得词典补全输出")?.read_to_string(&mut out)
        .map_err(|e| format!("读词典补全输出失败: {e}"))?;
    // 等待 + 超时 (8s; 单词查询应 <2s)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err("词典补全超时".into());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(format!("等待词典补全失败: {e}")),
        }
    }
    let line = out.lines().find(|l| l.trim_start().starts_with('{')).ok_or("词典补全无输出")?;
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("词典补全输出非法: {e}"))?;
    let pos = v.get("pos").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let phonetic = v.get("phonetic").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let meanings: Vec<String> = v.get("meanings").and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let examples: Vec<String> = v.get("examples").and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let example_zh: Vec<String> = v.get("example_zh").and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let usage = v.get("usage").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let phrases: Vec<String> = v.get("phrases").and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if meanings.is_empty() {
        return Err("词典补全无释义".into());
    }
    Ok((pos, phonetic, meanings, examples, example_zh, usage, phrases))
}

/// 显式加入生词本
#[tauri::command]
pub fn add_vocab(db: State<store::Db>, word: String, profile_id: String) -> Result<serde_json::Value, String> {
    dictionary_service::add_to_vocab(db.inner(), &profile_id, &word)
}

/// 词典列表 (某 profile)
#[tauri::command]
pub fn dict_list(db: State<store::Db>, profile_id: String) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list_by_profile(&profile_id)).map_err(|e| e.to_string())?)
}

/// 词典搜索
#[tauri::command]
pub fn dict_search(db: State<store::Db>, profile_id: String, q: String) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    Ok(serde_json::to_value(repo.search(&profile_id, &q)).map_err(|e| e.to_string())?)
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
    Ok(serde_json::to_value(repo.list(&profile_id)).map_err(|e| e.to_string())?)
}

/// 生词搜索
#[tauri::command]
pub fn vocab_search(db: State<store::Db>, profile_id: String, q: String) -> Result<serde_json::Value, String> {
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    Ok(serde_json::to_value(repo.search(&profile_id, &q)).map_err(|e| e.to_string())?)
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
pub fn sync_status(db: State<store::Db>, services: State<crate::AppServices>) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::get_status(db.inner(), &url, &token);
    Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
}

/// 立即同步 (push)
#[tauri::command]
pub fn sync_now(db: State<store::Db>, services: State<crate::AppServices>) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::sync_now(db.inner(), &url, &token)?;
    Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
}

/// 拉取合并
#[tauri::command]
pub fn sync_pull_now(db: State<store::Db>, services: State<crate::AppServices>) -> Result<serde_json::Value, String> {
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = svc.cf_token.lock().unwrap().clone();
    let s = crate::application::sync_service::sync_pull(db.inner(), &url, &token)?;
    Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
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
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let mut cfg = config::Config::load(&exe_dir);
    cfg.cf_worker_url = worker_url.clone();
    let _ = std::fs::write(exe_dir.join("config.toml"), toml::to_string_pretty(&cfg).unwrap_or_default());
    // token 存 Credential Manager (永不落明文)
    if !token.is_empty() {
        crate::services::credentials::save_cf_token(&token)?;
    }
    // 更新内存态 (即时生效)
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = worker_url;
    *svc.cf_token.lock().unwrap() = crate::services::credentials::get_cf_token().unwrap_or_default();
    Ok(())
}

// ---- 书签 (I-D) ----

/// 书签列表 (本书所有书签句子)
#[tauri::command]
pub fn bookmarks_list(db: State<store::Db>, book_key: String, profile_id: String) -> Result<serde_json::Value, String> {
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
