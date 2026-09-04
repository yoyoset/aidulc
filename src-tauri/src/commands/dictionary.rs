//! commands/dictionary.rs —— 查词/词典命令 (I-A)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 commands/vocab.rs 再拆——
//! 词典(dictionary 表, dict_repo.rs 唯一写者)和生词本(vocab 表, vocab_repo.rs 唯一写者)
//! 是项目自己在存储所有权表里就分开的两张表/两个真实域, 这里只留"查词 + 个人词典资产"。

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
    force_llm: bool,
) -> Result<serde_json::Value, String> {
    use crate::application::dictionary_service;
    crate::infrastructure::log::info("cmd", "enter: word_lookup (async)");
    let key = word.trim().to_lowercase();
    if key.is_empty() {
        return Err("空词".into());
    }

    // 1. 本地命中(个人缓存, 含语境例句) → 直接返回 (纯 DB 读, 快)
    if let Some(local) = dictionary_service::lookup_local(db.inner(), &user_id, &profile_id, &key)?
    {
        crate::infrastructure::log::info("cmd", "exit: word_lookup (local hit)");
        return serde_json::to_value(local).map_err(|e| e.to_string());
    }

    // 2. 全局词典基底命中(种子+积累, 无语境例句) → 除非用户主动要"结合这句话
    // 再讲一下"(force_llm), 否则直接返回, 瞬时且完全不碰 GPU。
    if !force_llm {
        if let Some(base) = dictionary_service::lookup_base(db.inner(), &user_id, &key) {
            crate::infrastructure::log::info("cmd", "exit: word_lookup (base hit)");
            return serde_json::to_value(base).map_err(|e| e.to_string());
        }
    }

    // 3. 基底没有 / 用户要语境例句 → 侧车查词放 spawn_blocking (子进程 + 阻塞读 +
    // 30s 超时都在后台)。2026-08-21: 模型路径改用查词专用槽位(没配置就退回
    // 共享的翻译/讲解模型), 不再强制跟大模型抢显存。
    let prep_path = cfg.inner().prep_path.clone();
    let llm_model = crate::application::model_service::resolve_lookup_llm_path(db.inner(), "en");
    let w = key.clone();
    let ctx = context;
    let configured = !llm_model.is_empty() && std::path::Path::new(&llm_model).exists();
    let daemon_result = tauri::async_runtime::spawn_blocking(move || {
        if configured {
            let call = crate::infrastructure::dict_daemon::lookup(&prep_path, &llm_model, &w, &ctx);
            daemon_outcome_to_tuple(call, &w)
        } else {
            // 兜底: 未配置 → 占位 (不阻断查词), 措辞保持原样"待补充"。false = 不
            // 落库, 否则配置好模型之后这条占位还赖在缓存里, 永远查不到真答案。
            (
                false,
                (
                    "NOUN".into(),
                    String::new(),
                    vec![format!("{w} 的词义待补充(未配置 LLM 模型)")],
                    vec![],
                    vec![],
                    String::new(),
                    vec![],
                ),
            )
        }
    })
    .await
    .map_err(|e| format!("查词任务执行失败: {e}"))?;

    // 3. 回主线程组装响应。2026-09-05 实测复现修复("suggested" 点重置也秒失败,
    // 根因见 dictionary_service::unsaved_llm_lookup 头注释): 只有 succeeded=true
    // (真的拿到生成结果)才落库——失败/占位结果只组装出来给面板识别渲染, 绝不
    // 写进个人缓存或共享基底, 否则第一次失败就会把失败原因永久缓存成"词义"。
    let (succeeded, tuple) = daemon_result;
    let result = if succeeded {
        dictionary_service::persist_llm(db.inner(), &user_id, &profile_id, &key, tuple)?
    } else {
        dictionary_service::unsaved_llm_lookup(&key, tuple)
    };
    crate::infrastructure::log::info("cmd", "exit: word_lookup (llm)");
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// K1 (2026-08-11): 词典守护调用结果 → (是否真生成成功, 面板元组)。真实失败原因
/// 上屏 + 记日志, 不再统一说成"未返回结果"。纯函数, 便于对四种失败逐类单测。
/// 2026-09-05: 加返回值里的 bool ——调用方据此决定要不要落库(见 word_lookup)。
fn daemon_outcome_to_tuple(
    call: Result<serde_json::Value, String>,
    w: &str,
) -> (bool, LookupTuple) {
    match call {
        Ok(v) => match daemon_result_to_tuple(&v) {
            Ok(parsed) => (true, parsed),
            Err(parse_err) => {
                // 侧车回了, 但内容看不懂 —— 一句话说清"不是没回, 是回了看不懂"
                crate::infrastructure::log::error(
                    "dict",
                    &format!("{w} 词典守护响应解析失败: {parse_err}"),
                );
                (
                    false,
                    fallback_tuple(w, "侧车已返回但结果无法解析, 详见 aidulc.log"),
                )
            }
        },
        Err(call_err) => {
            // 侧车没回 —— 把调用层的真实原因直接上屏
            crate::infrastructure::log::error("dict", &format!("{w} 词典守护调用失败: {call_err}"));
            (false, fallback_tuple(w, &call_err))
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

/// 2026-09-04 (用户: "没有拉起来给我检查或者重置的按钮"): 强制重置词典守护进程——
/// 杀掉当前 dict_daemon(如果还活着)并清出注册表, 下次查词会重新 spawn。
/// `dict_daemon::stop()` 本身已幂等(见其头注释), 这里只是给它一个 command 出口,
/// 让查词失败面板能点击立即重置, 不用等 30 秒 LOOKUP_TIMEOUT 被动检测。
#[tauri::command]
pub fn dict_daemon_reset() {
    crate::infrastructure::dict_daemon::stop();
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

/// 2026-09-04 (用户: "查完的...确认，然后返回给词典里"): 在线查词结果不会自动落库
/// (word_lookup_online 只展示, 见其头注释), 用户看完确认要留下这个答案才调这个
/// 命令——只写个人词典缓存, 不碰共享的 dict_base(见 dictionary_service::persist_online
/// 头注释)。嵌套请求体字段需要显式 camelCase(Tauri 只转顶层参数名, 见 vocab.rs
/// AddVocabRequest 的坑注)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineConfirmRequest {
    pub user_id: String,
    pub profile_id: String,
    pub word: String,
    pub pos: String,
    pub phonetic: String,
    pub meanings: Vec<String>,
    pub examples: Vec<String>,
    pub example_zh: Vec<String>,
    pub usage: String,
    pub phrases: Vec<String>,
}

#[tauri::command]
pub fn word_lookup_online_confirm(
    db: State<store::Db>,
    req: OnlineConfirmRequest,
) -> Result<(), String> {
    let key = req.word.trim().to_lowercase();
    crate::application::dictionary_service::persist_online(
        db.inner(),
        &req.user_id,
        &req.profile_id,
        &key,
        (
            req.pos,
            req.phonetic,
            req.meanings,
            req.examples,
            req.example_zh,
            req.usage,
            req.phrases,
        ),
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

// ---- K29 (2026-08-14): 生词本发音 —— 跟正文朗读同一套本地 TTS 引擎, 不再走浏览器
// SpeechSynthesisUtterance(系统机械音)。异步 + spawn_blocking, 跟 word_lookup 同一
// 理由: tts_daemon 是 spawn 子进程 + 阻塞读, 同步命令跑主线程会让整窗假死。

/// 生词发音: 合成一个词, 返回 base64 WAV(前端拼 data: URL 直接播放)。
#[tauri::command]
pub async fn tts_synth_word(
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
    word: String,
) -> Result<String, String> {
    let key = word.trim().to_string();
    if key.is_empty() {
        return Err("空词".into());
    }
    let prep_path = cfg.inner().prep_path.clone();
    let (_llm, tts_model, _spacy) =
        crate::application::model_service::resolve_paths(db.inner(), "en");
    if tts_model.is_empty() || !std::path::Path::new(&tts_model).exists() {
        return Err("未配置语音模型, 去模型中心下载/选择后再试".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::infrastructure::tts_daemon::synth(
            &prep_path, &tts_model, "en", &key, "af_heart", 1.0,
        )
    })
    .await
    .map_err(|e| format!("语音合成任务失败: {e}"))?
}

/// K29: 进入阅读器时预热——提前把 Kokoro 模型加载进常驻守护, 后续生词本点发音不用
/// 再等冷启动。用一个短中性词触发真实合成(懒加载在 Python 侧的第一次请求才发生,
/// 光启动进程不够), 结果直接丢弃, 前端不用等这个返回、也不播放这次合成的音频。
#[tauri::command]
pub async fn tts_prewarm(
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
) -> Result<(), String> {
    let prep_path = cfg.inner().prep_path.clone();
    let (_llm, tts_model, _spacy) =
        crate::application::model_service::resolve_paths(db.inner(), "en");
    if tts_model.is_empty() || !std::path::Path::new(&tts_model).exists() {
        return Ok(()); // 没配置语音模型 → 静默跳过, 不是错误(阅读本身不需要它)
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::infrastructure::tts_daemon::synth(
            &prep_path, &tts_model, "en", "ok", "af_heart", 1.0,
        );
    })
    .await
    .map_err(|e| format!("语音预热任务失败: {e}"))?;
    Ok(())
}

// ---- K32 (2026-08-15): 生词发音缓存 —— 加词时后台预生成音频落盘, 播放优先读缓存,
// 现场合成降级为兜底。用"文件是否存在"标记"是否已生成": 不新增数据库列/不改 vocab
// 表结构/不跑迁移(缓存天然幂等, 文件在就是已生成, 不存在就是没生成)。

/// 缓存文件名 slug: 只保留 ASCII 字母数字, 其余字符(路径分隔符/控制字符/非 ASCII)
/// 一律替换成下划线, 禁止越界路径混入文件名。纯函数便于单测。
fn tts_cache_slug(word: &str) -> String {
    word.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// 缓存文件绝对路径: {data_dir}/tts_cache/{slug}.wav
pub(crate) fn tts_cache_path(data_dir: &std::path::Path, word: &str) -> std::path::PathBuf {
    data_dir
        .join("tts_cache")
        .join(format!("{}.wav", tts_cache_slug(word)))
}

/// K32: 预生成某词的发音缓存(幂等)。生词加入生词本时后台异步调; 文件已存在就直接
/// 返回(不重复合成、不 spawn_blocking); 未配置语音模型时静默跳过(同 tts_prewarm 的
/// 降级——缓存是锦上添花, 不该因为没配语音就打断加词流程)。
#[tauri::command]
pub async fn tts_cache_word(
    paths: State<'_, crate::DataPaths>,
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
    word: String,
) -> Result<(), String> {
    let key = word.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }
    let target = tts_cache_path(&paths.inner().data_dir, &key);
    if target.is_file() {
        return Ok(()); // 已缓存, 幂等跳过
    }
    let prep_path = cfg.inner().prep_path.clone();
    let (_llm, tts_model, _spacy) =
        crate::application::model_service::resolve_paths(db.inner(), "en");
    if tts_model.is_empty() || !std::path::Path::new(&tts_model).exists() {
        return Ok(()); // 没配置语音模型 → 静默跳过(同 tts_prewarm 的降级)
    }
    let target_dir = paths.inner().data_dir.join("tts_cache");
    tauri::async_runtime::spawn_blocking(move || {
        let b64 = crate::infrastructure::tts_daemon::synth(
            &prep_path, &tts_model, "en", &key, "af_heart", 1.0,
        )?;
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map_err(|e| format!("解码语音 base64 失败: {e}"))?;
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建语音缓存目录失败: {e}"))?;
        std::fs::write(&target, bytes).map_err(|e| format!("写语音缓存失败: {e}"))
    })
    .await
    .map_err(|e| format!("语音缓存任务失败: {e}"))?
}

/// K32: 读生词发音缓存。命中返回 base64 WAV(前端拼 data: URL 播放), 未命中返回
/// None(不是错误, 是"还没预生成", 前端据此降级到现场合成)。
#[tauri::command]
pub fn vocab_read_cached_audio(
    paths: State<'_, crate::DataPaths>,
    word: String,
) -> Result<Option<String>, String> {
    let key = word.trim().to_string();
    if key.is_empty() {
        return Ok(None);
    }
    let target = tts_cache_path(&paths.inner().data_dir, &key);
    if !target.is_file() {
        return Ok(None);
    }
    let data = std::fs::read(&target).map_err(|e| format!("读语音缓存失败: {e}"))?;
    use base64::Engine;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(&data),
    ))
}

#[cfg(test)]
mod k1_tests {
    //! K1 (2026-08-11): 查词失败的真实原因必须上屏 —— 四种失败给四种不同文案,
    //! 没有一种说成"未返回结果"。daemon_outcome_to_tuple 是纯函数, 逐类锁住。
    use super::{daemon_outcome_to_tuple, daemon_result_to_tuple, tts_cache_slug};
    use serde_json::json;

    #[test]
    fn cache_slug_strips_path_and_control_chars() {
        // K32: slug 只允许 ASCII 字母数字, 路径分隔符/控制字符/非 ASCII 一律变下划线,
        // 防止越界路径混入缓存文件名。
        assert_eq!(tts_cache_slug("Hello World"), "hello_world");
        assert_eq!(tts_cache_slug("..\\..\\secret"), "______secret");
        assert_eq!(tts_cache_slug("bank/tmp\x00x"), "bank_tmp_x");
        assert_eq!(tts_cache_slug("naïve"), "na_ve");
        assert_eq!(tts_cache_slug("  padded  "), "padded");
    }

    #[test]
    fn ok_result_passes_through() {
        // daemon_outcome_to_tuple 收到的是 lookup() 的返回值 = result 字段本身 (已剥掉 ok 包装)
        let v = json!({
            "pos": "NOUN", "phonetic": "/dɔː/", "meanings": ["门"],
            "examples": ["knock the door"], "example_zh": ["敲门"],
            "usage": "可数名词", "phrases": ["next door"]
        });
        let (ok, t) = daemon_outcome_to_tuple(Ok(v), "door");
        assert!(ok, "真解析成功应标记可落库");
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
        let results: Vec<(bool, String)> = failures
            .iter()
            .map(|e| {
                let (ok, t) = daemon_outcome_to_tuple(Err(e.to_string()), "doorway");
                (ok, t.2.join(" "))
            })
            .collect();
        // 2026-09-05: 四种失败都不该标记可落库——否则失败原因会被当成词义存进
        // 词典(实测复现的"suggested 点重置也秒失败"根因, 见 word_lookup 调用点注释)。
        assert!(
            results.iter().all(|(ok, _)| !*ok),
            "四种失败都不该标记可落库: {results:?}"
        );
        let msgs: Vec<&String> = results.iter().map(|(_, m)| m).collect();
        // 四条文案互不相同
        let mut uniq = std::collections::HashSet::new();
        for m in &msgs {
            assert!(!m.contains("未返回结果"), "不应再出现笼统文案: {m}");
            assert!(m.contains("doorway"), "应含词: {m}");
            uniq.insert((*m).clone());
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
        let (ok, t) = daemon_outcome_to_tuple(Ok(v), "door");
        assert!(!ok, "解析失败不该标记可落库");
        let msg = t.2.join(" ");
        assert!(!msg.contains("未返回结果"), "解析失败 ≠ 未返回: {msg}");
        assert!(msg.contains("无法解析"), "应说明是解析问题: {msg}");
    }
}
