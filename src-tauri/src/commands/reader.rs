//! commands/reader.rs —— 查词/生词/词典命令 (I-A/I-B)

use crate::application::dictionary_service;
use crate::store;
use tauri::State;

/// 查词元组 (pos, phonetic, meanings, examples, example_zh, usage, phrases)。
/// 抽取为类型别名: 三处返回它的函数共用, 避免 clippy 的 very-complex-type 警告
/// (clippy 基线 8 只降不升, 2026-08-11 K2 新增 daemon_outcome/fallback/persist 共用)。
pub type LookupTuple = (
    String,
    String,
    Vec<String>,
    Vec<String>,
    Vec<String>,
    String,
    Vec<String>,
);

/// 查词 (本地优先 → LLM 补全)
/// 未命中本地词典时 spawn 侧车 dict-lookup (复用 PrepConfig.llm_model);
/// 侧车不可用/超时 → 占位兜底 (source=llm, 可读提示)。
///
/// K2 (2026-08-11): 改 async + spawn_blocking —— dict_daemon 是 spawn 子进程 + 阻塞读
/// (现已有超时), 同步命令跑主线程会让整窗假死。照 S0 对 components_health 的做法:
/// 本地词典命中 (纯 DB 读, 快) 留在异步线程; 只有"未命中 → 起侧车"这步进 spawn_blocking。
#[tauri::command]
pub async fn word_lookup(
    db: State<'_, store::Db>,
    cfg: State<'_, crate::PrepConfig>,
    word: String,
    user_id: String,
    profile_id: String,
    context: String,
) -> Result<serde_json::Value, String> {
    use crate::application::dictionary_service;
    crate::infrastructure::log::info("cmd", "enter: word_lookup (async)");
    let key = word.trim().to_lowercase();
    if key.is_empty() {
        return Err("空词".into());
    }

    // 1. 本地命中 → 直接返回 (纯 DB 读, 快)
    if let Some(local) = dictionary_service::lookup_local(db.inner(), &user_id, &profile_id, &key)?
    {
        crate::infrastructure::log::info("cmd", "exit: word_lookup (local hit)");
        return serde_json::to_value(local).map_err(|e| e.to_string());
    }

    // 2. 未命中 → 侧车查词放 spawn_blocking (子进程 + 阻塞读 + 30s 超时都在后台)
    let prep_path = cfg.inner().prep_path.clone();
    let (llm_model, _, _) = crate::application::model_service::resolve_paths(db.inner(), "en");
    let w = key.clone();
    let ctx = context;
    let configured = !llm_model.is_empty() && std::path::Path::new(&llm_model).exists();
    let daemon_result = tauri::async_runtime::spawn_blocking(move || {
        if configured {
            let call = crate::infrastructure::dict_daemon::lookup(&prep_path, &llm_model, &w, &ctx);
            daemon_outcome_to_tuple(call, &w)
        } else {
            // 兜底: 未配置 → 占位 (不阻断查词), 措辞保持原样"待补充"
            (
                "NOUN".into(),
                String::new(),
                vec![format!("{w} 的词义待补充(未配置 LLM 模型)")],
                vec![],
                vec![],
                String::new(),
                vec![],
            )
        }
    })
    .await
    .map_err(|e| format!("查词任务执行失败: {e}"))?;

    // 3. 回主线程写库 (快操作) + 组装响应
    let result =
        dictionary_service::persist_llm(db.inner(), &user_id, &profile_id, &key, daemon_result)?;
    crate::infrastructure::log::info("cmd", "exit: word_lookup (llm)");
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// K1 (2026-08-11): 词典守护调用结果 → 面板元组。真实失败原因上屏 + 记日志,
/// 不再统一说成"未返回结果"。纯函数, 便于对四种失败逐类单测。
fn daemon_outcome_to_tuple(call: Result<serde_json::Value, String>, w: &str) -> LookupTuple {
    match call {
        Ok(v) => match daemon_result_to_tuple(&v) {
            Ok(parsed) => parsed,
            Err(parse_err) => {
                // 侧车回了, 但内容看不懂 —— 一句话说清"不是没回, 是回了看不懂"
                crate::infrastructure::log::error(
                    "dict",
                    &format!("{w} 词典守护响应解析失败: {parse_err}"),
                );
                fallback_tuple(w, "侧车已返回但结果无法解析, 详见 aidulc.log")
            }
        },
        Err(call_err) => {
            // 侧车没回 —— 把调用层的真实原因直接上屏
            crate::infrastructure::log::error("dict", &format!("{w} 词典守护调用失败: {call_err}"));
            fallback_tuple(w, &call_err)
        }
    }
}

/// 失败占位元组: 面板能看到 {w} 的词义查询失败 ({原因})
fn fallback_tuple(w: &str, detail: &str) -> LookupTuple {
    (
        "NOUN".into(),
        String::new(),
        vec![format!("{w} 的词义查询失败 ({detail})")],
        vec![],
        vec![],
        String::new(),
        vec![],
    )
}

/// 词典守护的 result JSON → dictionary_service 的元组。字段缺失给空值, 不报错。
fn daemon_result_to_tuple(v: &serde_json::Value) -> Result<LookupTuple, String> {
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
/// V4 (2026-08-09): source 内含 edition_id/chapter_index/sentence_index 来源定位。
/// 打包成请求结构体是为了不新增命令参数 (clippy 参数过多警告, 基线只降不升)。
#[derive(serde::Deserialize)]
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

/// 词典列表 (某 user 某 profile)
#[tauri::command]
pub fn dict_list(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    serde_json::to_value(repo.list_by_profile(&user_id, &profile_id)).map_err(|e| e.to_string())
}

/// 词典搜索
#[tauri::command]
pub fn dict_search(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    q: String,
) -> Result<serde_json::Value, String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    serde_json::to_value(repo.search(&user_id, &profile_id, &q)).map_err(|e| e.to_string())
}

/// 词典删除
#[tauri::command]
pub fn dict_remove(
    db: State<store::Db>,
    key: String,
    user_id: String,
    profile_id: String,
) -> Result<(), String> {
    let repo = store::dict_repo::DictRepo::new(db.inner());
    repo.remove(&key, &user_id, &profile_id)
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

// ---- 同步 (I-C: 状态机 + 配置, V6 按 user 分账) ----

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
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "sync_status keyring_read {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    let s = crate::application::sync_service::get_status(db.inner(), &url, &token, &user_id);
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 立即同步 (某 user): 先推后拉
/// K2 (2026-08-11): 改 async —— reqwest::blocking 网络调用 (15s 超时 ×3 重试) 会阻塞主线程
/// 至多几十秒。async 命令跑在 tokio 线程池, 不在主线程, 窗口全程 Responding。
/// (sync_service 内部穿插 DB 读写, 无法整体挪进 spawn_blocking; async 已满足"不卡主线程"。)
#[tauri::command]
pub async fn sync_now(
    db: State<'_, store::Db>,
    services: State<'_, crate::AppServices>,
    user_id: String,
) -> Result<serde_json::Value, String> {
    let t0 = crate::store::now_ms_for_store();
    crate::infrastructure::log::info("cmd", &format!("enter: sync_now user={user_id}"));
    let svc = services.inner();
    let url = svc.cf_worker_url.lock().unwrap().clone();
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    // UX A1: token 属于服务端哪个 user (换 token 时从 auth_device 返回值保存) ——
    // endpoint_key 用它判定"换服务端后是否要全量重推"。
    let server_user =
        crate::services::credentials::get_server_user_for(&user_id).unwrap_or_default();
    let s = crate::application::sync_service::sync_now(
        db.inner(),
        &url,
        &token,
        &server_user,
        &user_id,
    )?;
    crate::infrastructure::log::info(
        "cmd",
        &format!("exit: sync_now {}ms", crate::store::now_ms_for_store() - t0),
    );
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 拉取合并 (某 user)
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
    let token = crate::services::credentials::get_cf_token_for(&user_id).unwrap_or_default();
    let server_user =
        crate::services::credentials::get_server_user_for(&user_id).unwrap_or_default();
    let s = crate::application::sync_service::sync_pull(
        db.inner(),
        &url,
        &token,
        &server_user,
        &user_id,
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
    // 持久化 worker_url 到 config.toml (J0: 配置文件随数据根走)
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = config::Config::load(&cfg_dir);
    cfg.cf_worker_url = worker_url.clone();
    let _ = std::fs::write(
        cfg_dir.join("config.toml"),
        toml::to_string_pretty(&cfg).unwrap_or_default(),
    );
    let svc = services.inner();
    *svc.cf_worker_url.lock().unwrap() = worker_url;
    *svc.cf_token.lock().unwrap() = auth.token.clone();
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
/// K2: 本地操作 (Credential Manager + 读内存态), 无网络, 无需 async。
#[tauri::command]
pub fn sync_disconnect(user_id: String) -> Result<(), String> {
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
    let _ = std::fs::write(
        cfg_dir.join("config.toml"),
        toml::to_string_pretty(&cfg).unwrap_or_default(),
    );
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
    *svc.cf_token.lock().unwrap() =
        crate::services::credentials::get_cf_token().unwrap_or_default();
    Ok(())
}

// ---- 书签 (I-D) ----

/// 书签列表 (本书所有书签句子)
#[tauri::command]
pub fn bookmarks_list(
    db: State<store::Db>,
    book_key: String,
    user_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::reading_repo::ReadingRepo::new(db.inner());
    let state = repo.get(&user_id, &book_key);
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

#[cfg(test)]
mod k1_tests {
    //! K1 (2026-08-11): 查词失败的真实原因必须上屏 —— 四种失败给四种不同文案,
    //! 没有一种说成"未返回结果"。daemon_outcome_to_tuple 是纯函数, 逐类锁住。
    use super::{daemon_outcome_to_tuple, daemon_result_to_tuple};
    use serde_json::json;

    #[test]
    fn ok_result_passes_through() {
        // daemon_outcome_to_tuple 收到的是 lookup() 的返回值 = result 字段本身 (已剥掉 ok 包装)
        let v = json!({
            "pos": "NOUN", "phonetic": "/dɔː/", "meanings": ["门"],
            "examples": ["knock the door"], "example_zh": ["敲门"],
            "usage": "可数名词", "phrases": ["next door"]
        });
        let t = daemon_outcome_to_tuple(Ok(v), "door");
        assert_eq!(t.0, "NOUN");
        assert_eq!(t.2, vec!["门"]);
    }

    #[test]
    fn four_failure_types_give_four_distinct_messages() {
        let failures = [
            // 守护起不动 (spawn 失败)
            "启动词典守护失败: 系统找不到指定的程序",
            // 中途 kill (进程退出)
            "词典守护进程已退出",
            // 返回非 JSON
            "词典守护响应非法: expected value at line 1 column 1",
            // 返回 ok:false (侧车自报)
            "模型加载失败: 显存不足",
        ];
        let msgs: Vec<String> = failures
            .iter()
            .map(|e| {
                let t = daemon_outcome_to_tuple(Err(e.to_string()), "doorway");
                t.2.join(" ")
            })
            .collect();
        // 四条文案互不相同
        let mut uniq = std::collections::HashSet::new();
        for m in &msgs {
            assert!(!m.contains("未返回结果"), "不应再出现笼统文案: {m}");
            assert!(m.contains("doorway"), "应含词: {m}");
            uniq.insert(m.clone());
        }
        assert_eq!(uniq.len(), 4, "四种失败应给四种不同文案: {msgs:?}");
        // 各自带上原始原因
        assert!(msgs[0].contains("系统找不到指定的程序"));
        assert!(msgs[1].contains("进程已退出"));
        assert!(msgs[2].contains("响应非法"));
        assert!(msgs[3].contains("显存不足"));
    }

    #[test]
    fn unparseable_result_is_not_called_not_returned() {
        // 侧车回了, 但内容缺 meanings → 解析失败, 不是"未返回结果"
        let v = json!({"ok": true, "result": {"pos": "NOUN"}});
        assert!(
            daemon_result_to_tuple(&v).is_err(),
            "缺 meanings 应解析失败"
        );
        let t = daemon_outcome_to_tuple(Ok(v), "door");
        let msg = t.2.join(" ");
        assert!(!msg.contains("未返回结果"), "解析失败 ≠ 未返回: {msg}");
        assert!(msg.contains("无法解析"), "应说明是解析问题: {msg}");
    }
}
