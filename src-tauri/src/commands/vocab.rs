//! commands/vocab.rs —— 查词/生词/词典/背单词命令 (I-A/I-B/V2)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 commands/reader.rs 拆出——
//! 原文件把词典/生词本/背单词/同步后端管理/日志五个不相关域全挤在一起, 这里只留
//! "查词 + 生词本 + 背单词调度"这一个真实域。Tauri 命令名不变, 只是物理文件挪动。

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

/// K3 (2026-08-11): 用在线 AI 查一次 —— 本地失败后由用户显式点击触发, 绝不自动回退。
/// 外发内容: 1 个词 + 所在那 1 句 (~200 字符)。发前 UI 已显示"将发送: word + 该句"。
/// 读 endpoint/model 从 config, key 从 Credential Manager, 从本机直连服务商。
#[tauri::command]
pub async fn word_lookup_online(
    paths: State<'_, crate::DataPaths>,
    word: String,
    context: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: word_lookup_online");
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    // L8 (2026-08-11): 查词失败时可用在线 AI —— 必须用户显式开启才放行, 默认关。
    if !cfg.online_lookup_enabled {
        return Err("在线查词未开启 (设置页·在线引擎: 「查词失败时可用在线 AI」)".into());
    }
    let key = crate::services::credentials::get_online_key().unwrap_or_default();
    let w = word.trim().to_lowercase();
    let ctx = context;
    // 网络调用放 spawn_blocking (K2 纪律: 网络不阻塞主线程)
    let r = tauri::async_runtime::spawn_blocking(move || {
        crate::infrastructure::online_client::lookup_word(
            &cfg.online_endpoint,
            &key,
            &cfg.online_model,
            &w,
            &ctx,
        )
    })
    .await
    .map_err(|e| format!("在线查词任务执行失败: {e}"))??;
    crate::infrastructure::log::info("cmd", "exit: word_lookup_online");
    serde_json::to_value(r).map_err(|e| e.to_string())
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
/// UX7 #1 (2026-08-13, 真机实测确认): 前端 dictionary_service.js 的 addToVocab() 打的是
/// camelCase 键(userId/profileId/editionId/chapterIndex/sentenceIndex) —— Tauri 只自动把
/// *顶层* invoke 参数名 camelCase→snake_case, `req` 这种打包进请求体的嵌套字段不在这个转换
/// 范围内, serde 按字面量找不到 user_id 直接报 "missing field `user_id`"。全仓库唯一一个
/// "打包成请求结构体"的命令, 之前没人踩过这个坑。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[cfg(test)]
mod add_vocab_request_tests {
    //! UX7 #1 (2026-08-13, 真机实测确认): 前端 addToVocab() 发的是 camelCase
    //! (userId/profileId/editionId/...), AddVocabRequest 没标 rename_all 时 serde
    //! 按字面量找 user_id 找不到, 报 "missing field `user_id`"——用户真机点"加入生词本"
    //! 复现的原始报错。锁定这条 JSON 契约, 防止 rename_all 被误删回归。
    use super::AddVocabRequest;

    #[test]
    fn accepts_camel_case_json_from_frontend() {
        let json = r#"{
            "word": "either", "userId": "me", "profileId": "default",
            "context": "He likes either one.", "editionId": null,
            "chapterIndex": 2, "sentenceIndex": 5
        }"#;
        let req: AddVocabRequest =
            serde_json::from_str(json).expect("camelCase JSON 应能反序列化为 AddVocabRequest");
        assert_eq!(req.user_id, "me");
        assert_eq!(req.profile_id, "default");
        assert_eq!(req.chapter_index, Some(2));
        assert_eq!(req.sentence_index, Some(5));
    }
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

/// H5 (2026-08-11): 词频批量剔除 —— dry-run 预览: 词表里落在最常见 top_n 词的条目
/// 有多少条、分别是谁 (不实际删除)。用户确认后才调 vocab_remove_common 执行。
#[tauri::command]
pub fn vocab_common_preview(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    top_n: i64,
) -> Result<serde_json::Value, String> {
    let n = (top_n.clamp(100, 10000)) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entries = repo.list(&user_id, &profile_id);
    let common = crate::infrastructure::frequency::top_n(n);
    let hit: Vec<String> = entries
        .iter()
        .filter(|e| common.contains(&e.lemma.to_lowercase()))
        .map(|e| e.lemma.clone())
        .collect();
    Ok(serde_json::json!({
        "count": hit.len(),
        "lemmas": hit,
        "top_n": n,
        "total": entries.len(),
    }))
}

/// H5 (2026-08-11): 词频批量剔除 —— 执行删除最常见 top_n 词。
///
/// 数据安全 (GOAL_2026-08-11_UX2): 改/删用户数据前自动备份 (export_aidu_data →
/// 时间戳备份文件, 路径返回给用户), 批量写必须在**单个事务**里, 中途失败整体回滚;
/// dry-run (vocab_common_preview) 已先给"将影响 N 条", 本命令是确认后的执行。
#[tauri::command]
pub fn vocab_remove_common(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    top_n: i64,
) -> Result<serde_json::Value, String> {
    let n = (top_n.clamp(100, 10000)) as usize;
    let common = crate::infrastructure::frequency::top_n(n);

    // 1. 执行前自动备份 (数据安全第 1 条) —— 时间戳文件, 路径告诉用户
    let backup_dir = std::env::var("AIDULC_BACKUP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!("aidulc-backups-{}", std::process::id()))
        });
    let _ = std::fs::create_dir_all(&backup_dir);
    let backup_path = backup_dir.join(format!(
        "aidulc-vocab-remove-{}.aidu-data",
        crate::store::now_ms_for_store()
    ));
    let backup_json = crate::application::transfer_service::export_aidu_data(db.inner())
        .map_err(|e| format!("备份失败: {e}"))?;
    std::fs::write(
        &backup_path,
        serde_json::to_string_pretty(&backup_json).unwrap_or_default(),
    )
    .map_err(|e| format!("写备份文件失败: {e}"))?;

    // 2. 收集待删 lemma
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let entries = repo.list(&user_id, &profile_id);
    let hit: Vec<String> = entries
        .iter()
        .filter(|e| common.contains(&e.lemma.to_lowercase()))
        .map(|e| e.lemma.to_lowercase())
        .collect();

    // 3. 单事务删除 (唯一写者 = vocab_repo), 中途失败整体回滚
    repo.remove_many(&user_id, &profile_id, &hit)
        .map_err(|e| format!("批量剔词失败, 已整体回滚: {e}"))?;

    Ok(serde_json::json!({
        "removed": hit.len(),
        "backup_path": backup_path.to_string_lossy(),
    }))
}

/// H4 (2026-08-11): 存量打散 dry-run —— 当前有多少词 next_review 在过去 (存量到期),
/// 按每日可承受量 (daily_cap) 会摊到多少天、今天还剩多少词。不实际改动。
#[tauri::command]
pub fn vocab_backlog_preview(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    daily_cap: i64,
) -> Result<serde_json::Value, String> {
    let cap = daily_cap.clamp(1, 500) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let now = crate::store::now_ms_for_store();
    let entries = repo.list(&user_id, &profile_id);
    // 存量 = next_review 在过去 (含 null), 且不是 mastered (已掌握不参与复习排程)
    let backlog: Vec<(&str, i64)> = entries
        .iter()
        .filter(|e| e.stage != "mastered")
        .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
        .map(|e| (e.lemma.as_str(), e.added_at))
        .collect();
    let days = if cap > 0 {
        backlog.len().div_ceil(cap)
    } else {
        0
    };
    let today_after = backlog.len().min(cap);
    let spread = crate::domain::srs::spread_backlog_dates(&backlog, cap, now);
    Ok(serde_json::json!({
        "backlog_count": backlog.len(),
        "daily_cap": cap,
        "days": days,
        "today_after": today_after,
        "today_before": entries.iter().filter(|e| e.stage != "mastered").filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true)).count(),
        "sample_after": spread.iter().take(5).map(|(l, t)| serde_json::json!({"lemma": l, "next_review": t})).collect::<Vec<_>>(),
    }))
}

/// H4 (2026-08-11): 存量打散 —— 按加入顺序把 next_review 摊到未来 N 天。
///
/// 数据安全 (GOAL_2026-08-11_UX2): 执行前自动备份 (export_aidu_data → 时间戳文件);
/// 批量写必须**单事务**, 中途失败整体回滚; dry-run (vocab_backlog_preview) 先给数字。
#[tauri::command]
pub fn vocab_backlog_spread(
    db: State<store::Db>,
    user_id: String,
    profile_id: String,
    daily_cap: i64,
) -> Result<serde_json::Value, String> {
    let cap = daily_cap.clamp(1, 500) as usize;
    let repo = store::vocab_repo::VocabRepo::new(db.inner());
    let now = crate::store::now_ms_for_store();
    let entries = repo.list(&user_id, &profile_id);
    let backlog: Vec<(&str, i64)> = entries
        .iter()
        .filter(|e| e.stage != "mastered")
        .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
        .map(|e| (e.lemma.as_str(), e.added_at))
        .collect();
    if backlog.is_empty() {
        return Ok(serde_json::json!({ "spread": 0, "days": 0, "backup_path": "" }));
    }

    // 1. 执行前自动备份 (数据安全第 1 条)
    let backup_dir = std::env::var("AIDULC_BACKUP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!("aidulc-backups-{}", std::process::id()))
        });
    let _ = std::fs::create_dir_all(&backup_dir);
    let backup_path = backup_dir.join(format!(
        "aidulc-vocab-spread-{}.aidu-data",
        crate::store::now_ms_for_store()
    ));
    let backup_json = crate::application::transfer_service::export_aidu_data(db.inner())
        .map_err(|e| format!("备份失败: {e}"))?;
    std::fs::write(
        &backup_path,
        serde_json::to_string_pretty(&backup_json).unwrap_or_default(),
    )
    .map_err(|e| format!("写备份文件失败: {e}"))?;

    // 2. 打散计划
    let spread = crate::domain::srs::spread_backlog_dates(&backlog, cap, now);
    let days = if cap > 0 {
        backlog.len().div_ceil(cap)
    } else {
        0
    };

    // 3. 单事务写 next_review, 中途失败整体回滚 (唯一写者 = vocab_repo)
    let spread_plan: Vec<(String, i64)> = spread.iter().map(|(l, t)| (l.to_string(), *t)).collect();
    repo.spread_next_review(&user_id, &profile_id, &spread_plan)
        .map_err(|e| format!("存量打散失败, 已整体回滚: {e}"))?;

    Ok(serde_json::json!({
        "spread": spread.len(),
        "days": days,
        "backup_path": backup_path.to_string_lossy(),
    }))
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

#[cfg(test)]
mod h5_tests {
    //! H5 (2026-08-11): 词频批量剔除 —— 只删该 user+profile 的词, 不误删别人的;
    //! 单词事务回滚: 构造"删到一半出错"的场景 → 已删的也回滚。
    use crate::store::vocab_repo::VocabRepo;

    fn temp_db() -> crate::store::Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("aidulc_h5_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        crate::store::Db::open(path.to_str().unwrap()).unwrap()
    }

    fn entry(word: &str) -> crate::domain::vocab::VocabEntry {
        crate::domain::vocab::VocabEntry {
            word: word.into(),
            lemma: word.to_lowercase(),
            pos: "NOUN".into(),
            meaning: "含义".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: serde_json::Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: crate::store::now_ms_for_store(),
            updated_at: crate::store::now_ms_for_store(),
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        }
    }

    #[test]
    fn preview_counts_only_common_words() {
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("hieroglyphics"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("ability"), "me", "default")
            .unwrap();

        // 直接复用命令内部逻辑: top_n 集合取词
        let common = crate::infrastructure::frequency::top_n(3000);
        let entries = repo.list("me", "default");
        let hit: Vec<String> = entries
            .iter()
            .filter(|e| common.contains(&e.lemma.to_lowercase()))
            .map(|e| e.lemma.clone())
            .collect();
        assert_eq!(
            hit.len(),
            2,
            "either + ability 命中, hieroglyphics 不命中: {hit:?}"
        );
        assert!(!hit.contains(&"hieroglyphics".to_string()));
        assert!(hit.contains(&"either".to_string()));
        assert!(hit.contains(&"ability".to_string()));
    }

    #[test]
    fn add_vocab_reports_common_word_flag() {
        // 入库侧门槛: 默认不拦 (加入成功) 但给 common_word 提示
        let db = temp_db();
        let r = crate::application::dictionary_service::add_to_vocab(
            &db,
            "me",
            "default",
            "either",
            Some("He likes either one.".into()),
            crate::application::dictionary_service::SourceLocation::default(),
        )
        .unwrap();
        assert_eq!(r["added"], "either");
        assert_eq!(r["common_word"], true, "either 应标 common_word");
        // 生僻词不提示
        let r2 = crate::application::dictionary_service::add_to_vocab(
            &db,
            "me",
            "default",
            "hieroglyphics",
            None,
            crate::application::dictionary_service::SourceLocation::default(),
        )
        .unwrap();
        assert_eq!(r2["common_word"], false);
    }

    #[test]
    fn remove_common_only_touches_target_profile() {
        // 同 user 不同 profile: 只删 default 的 either, 不动 kid 的 either
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();
        repo.upsert_content(entry("either"), "me", "kid").unwrap();

        // 先取待删 lemma (不持锁调 repo.list, 避免 std Mutex 自锁)
        let common = crate::infrastructure::frequency::top_n(3000);
        let to_delete: Vec<String> = repo
            .list("me", "default")
            .iter()
            .filter(|e| common.contains(&e.lemma.to_lowercase()))
            .map(|e| e.lemma.to_lowercase())
            .collect();

        // 模拟命令的删除事务 (只删 default)
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
            let mut stmt = conn
                .prepare("DELETE FROM vocab WHERE user_id = ?1 AND profile_id = ?2 AND lemma = ?3")
                .unwrap();
            for lemma in to_delete {
                stmt.execute(rusqlite::params!["me", "default", lemma])
                    .unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }
        assert!(
            repo.get("me", "default", "either").is_none(),
            "default 应删"
        );
        assert!(repo.get("me", "kid", "either").is_some(), "kid 不应被误删");
    }

    #[test]
    fn remove_common_transaction_rolls_back_on_error() {
        // 单词事务: 中途出错 (用不存在的 user 列制造错误) → 整体回滚, 不留半套状态
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        repo.upsert_content(entry("either"), "me", "default")
            .unwrap();

        let common = crate::infrastructure::frequency::top_n(3000);
        let result = (|| -> Result<(), String> {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;")
                .map_err(|e| e.to_string())?;
            // 第一条成功删
            conn.execute(
                "DELETE FROM vocab WHERE user_id='me' AND profile_id='default' AND lemma='either'",
                [],
            )
            .map_err(|e| e.to_string())?;
            // 第二条故意失败 (不存在这一列) → 触发回滚
            let r = conn.execute("DELETE FROM vocab WHERE no_such_column = 1", []);
            if r.is_err() {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err("模拟失败".into());
            }
            let _ = conn.execute_batch("COMMIT;");
            Ok(())
        })();
        assert!(result.is_err(), "应失败");
        assert!(
            repo.get("me", "default", "either").is_some(),
            "失败后要么仍在 (回滚), 要么从未被删"
        );
    }

    #[test]
    fn backlog_spread_moves_due_into_future() {
        // H4: 存量打散 —— 模拟命令的"取到期 → 单事务写 next_review"链路
        use crate::domain::srs;
        let db = temp_db();
        let repo = VocabRepo::new(&db);
        let now = crate::store::now_ms_for_store();
        let mut e1 = entry("bank");
        e1.next_review = Some(now - 1000); // 已到期
        e1.added_at = now - 5000;
        let mut e2 = entry("languid");
        e2.next_review = Some(now - 2000); // 已到期
        e2.added_at = now - 1000;
        let mut e3 = entry("future");
        e3.next_review = Some(now + 86_400_000); // 未到期, 不应被打散
        e3.added_at = now;
        repo.upsert_content(e1, "me", "default").unwrap();
        repo.upsert_content(e2, "me", "default").unwrap();
        repo.upsert_content(e3, "me", "default").unwrap();

        // 取存量 (next_review <= now)
        let entries = repo.list("me", "default");
        let backlog: Vec<(&str, i64)> = entries
            .iter()
            .filter(|e| e.next_review.map(|t| t <= now).unwrap_or(true))
            .map(|e| (e.lemma.as_str(), e.added_at))
            .collect();
        assert_eq!(backlog.len(), 2, "只有 2 个到期");

        // 打散 (每日 1 词 → 摊到 2 天)
        let spread = srs::spread_backlog_dates(&backlog, 1, now);
        assert_eq!(spread.len(), 2);
        // 按 added_at 排序: bank 先 (更早加入) → 今天; languid → 明天
        assert_eq!(spread[0].0, "bank");
        assert_eq!(spread[1].0, "languid");
        let day0 = now - (now % srs::DAY_1);
        assert_eq!(spread[0].1, day0);
        assert_eq!(spread[1].1, day0 + srs::DAY_1);

        // 单事务写回 (与命令一致: json_set payload, 只改散列列会让 repo.list 读到旧值)
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
            let mut stmt = conn
                .prepare(
                    "UPDATE vocab SET next_review = ?1, updated_at = ?2,
                     payload = json_set(payload, '$.nextReview', ?1, '$.updatedAt', ?2)
                     WHERE user_id='me' AND profile_id='default' AND lemma = ?3",
                )
                .unwrap();
            for (lemma, ts) in &spread {
                stmt.execute(rusqlite::params![ts, now, lemma]).unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }
        // 今天只留 1 词 (每日上限 1), 未到期的 future 不动
        let now2 = crate::store::now_ms_for_store();
        let due_after: Vec<String> = repo
            .list("me", "default")
            .iter()
            .filter(|e| e.next_review.map(|t| t <= now2).unwrap_or(true))
            .map(|e| e.lemma.clone())
            .collect();
        assert_eq!(
            due_after,
            vec!["bank"],
            "打散后今天只留 1 词: {due_after:?}"
        );
        assert_eq!(
            repo.get("me", "default", "future").unwrap().next_review,
            Some(now + 86_400_000),
            "未到期词不受影响"
        );
    }
}
