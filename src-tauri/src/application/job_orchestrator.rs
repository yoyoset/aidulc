//! application/job_orchestrator.rs —— 备料任务业务编排 (S2.1: 从 commands/jobs.rs 拆分)
//!
//! commands/jobs.rs 947 行, pump_queue(226)/batch_start(147)/start_prep_job(63)/
//! batch_start_prep(102) 等编排逻辑挤在命令层, 违反"命令层只留薄壳"的边界——审计时
//! 标为架构债(docs/ROADMAP.md P3)。这里是编排真正住的地方; commands/jobs.rs 的
//! #[tauri::command] 只做参数转发(State<T> → 这里要的 &T), 不含业务决策。
//!
//! 参数类型延续 pump_queue 已有的约定: 这里的函数都收 &PrepConfig/&PrepState/&store::Db
//! (不是 State<T>), 命令层调用时用 `.inner()` 转换。这不是新规则, 是把已经在用的模式
//! 应用到其它函数上。

use crate::{jobs, store, PrepConfig, PrepState};
use tauri::Manager;

// M 系列: now_ms 统一走 store::now_ms_for_store (删除重复实现)
pub fn now_ms() -> i64 {
    store::now_ms_for_store()
}

fn uuid_short() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{c}", now_ms(), std::process::id())
}

/// v32 (2026-08-19): 兜底解析达标的书, 把缓存 JSON 路径注入 job_request。
/// 只有 standardize_status == "done" 才有 cache_path, 其它状态一律 None (重新原生解析)。
fn standardize_cache_for(db: &store::Db, book_id: &str) -> Option<String> {
    store::books_repo::BooksRepo::new(db)
        .get(book_id)
        .filter(|b| b.standardize_status == "done")
        .and_then(|b| b.standardize_cache_path.clone())
}

/// 启动单本任务 (G2: 支持 batch_id/多语言)
pub fn start_prep_job(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    book_path: String,
    profile: serde_json::Value,
    models: serde_json::Value,
    batch_id: Option<String>,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<String, String> {
    use tauri::Emitter;

    let job_id = format!("job-{}", uuid_short());
    let job_dir = cfg.out_dir.join("jobs").join(&job_id);
    std::fs::create_dir_all(&job_dir).map_err(|e| format!("建任务目录失败: {e}"))?;
    let profile_id = profile
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();

    let source_book_id = crate::commands::library::book_id_from_path(&book_path, &profile_id);
    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = store::jobs_repo::Job {
        id: job_id.clone(),
        edition_id: None,
        // BOOK_WORKFLOW §2.3: job 显式关联 source (start_prep_job 单书路径, 由路径+档案推导)
        source_id: Some(source_book_id.clone()),
        book_path: book_path.clone(),
        profile_id: profile_id.clone(),
        output_dir: job_dir.to_string_lossy().to_string(),
        status: "queued".into(),
        stage: String::new(),
        current: 0,
        total: 0,
        failed_count: 0,
        batch_id: batch_id.clone(),
        source_language: source_language.unwrap_or_else(|| "en".into()),
        target_language: target_language.unwrap_or_else(|| "zh-CN".into()),
        error: None,
        progress: 0.0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    repo.upsert(&job)
        .map_err(|e| format!("写任务表失败: {e}"))?;

    let std_cache = standardize_cache_for(db, &source_book_id);
    let mut job_req = jobs::spawn::build_job_request(
        &book_path,
        &job_dir.to_string_lossy(),
        &profile,
        &models,
        std_cache.as_deref(),
    );
    if let Some(bid) = &batch_id {
        job_req["batch_id"] = serde_json::json!(bid);
    }
    job_req["source_language"] = serde_json::json!(job.source_language);
    job_req["target_language"] = serde_json::json!(job.target_language);
    let req_path = job_dir.join("job_request.json");
    std::fs::write(&req_path, serde_json::to_string_pretty(&job_req).unwrap())
        .map_err(|e| format!("写 job_request 失败: {e}"))?;

    {
        let mut q = state.queue.lock().unwrap();
        q.push(job_id.clone());
    }
    let _ = app.emit(
        "job-progress",
        serde_json::json!({
            "jobId": job_id, "batchId": batch_id, "type": "stage_start", "stage": "queued", "ts": now_ms()
        }),
    );
    app.emit("job-list-changed", serde_json::json!({})).ok();

    let _ = pump_queue(app.clone(), cfg, state, db);
    Ok(job_id)
}

/// 导入批次 (R1: 只登记书+批次, 不开始处理)
/// 返回 batch_id。用户稍后在书库点"创建译本/开始阅读准备" → batch_start_prep。
/// 阶段 2(F45): 把登记逻辑抽成可测试的纯函数 `register_import_batch`(不需要 AppHandle),
/// 命令层只负责 emit 事件 + 序列化返回。同一路径 + 同一 profile 重复导入:
///   - source 层面幂等(book_id 去重, 不再登记第二条 source);
///   - 返回 skipped 列表, 前端据此提示"该原书已导入, 直接创建译本", 而不是用户以为导入两次。
// 参数个数延续本文件约定 (收 &PrepConfig/&StandardizeState/&Db, 不是 State<T>), 与其它
// 编排函数一样是真实债务 (真正清零需改成请求结构体, 见 docs/ROADMAP.md P3)。
#[allow(clippy::too_many_arguments)]
pub fn batch_import(
    app: tauri::AppHandle,
    cfg: &PrepConfig,
    state: &crate::application::standardize_task::StandardizeState,
    db: &store::Db,
    book_paths: Vec<String>,
    needs_standardize: Vec<String>,
    profile: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let out = register_import_batch(
        db,
        book_paths,
        needs_standardize.clone(),
        profile,
        source_language,
        target_language,
    )?;
    let _ = app.emit("library-changed", serde_json::json!({}));
    // v32: 有新登记的 pending 行 → 踢一下后台标准化队列 (fire-and-forget, 不阻塞返回)
    if out.registered.iter().any(|p| needs_standardize.contains(p)) {
        let _ = crate::application::standardize_task::pump_standardize_queue(
            app.clone(),
            cfg,
            state,
            db,
        );
    }
    Ok(serde_json::json!({
        "batch_id": out.batch_id,
        "registered": out.registered,
        "skipped": out.skipped,
    }))
}

/// 导入批次结果: batch_id + 本次新登记的原书路径 + 因已存在而跳过的路径。
pub struct ImportOutcome {
    pub batch_id: String,
    pub registered: Vec<String>,
    pub skipped: Vec<String>,
}

/// 纯登记逻辑(不依赖 Tauri): 建 batch + 幂等登记 source。
/// 只创建 source(kind=original, status=pending); 不创建 pack_dir/edition/reading_state。
pub fn register_import_batch(
    db: &store::Db,
    book_paths: Vec<String>,
    needs_standardize: Vec<String>,
    profile: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<ImportOutcome, String> {
    if book_paths.is_empty() {
        return Err("至少需要一本书".into());
    }
    let profile_id = profile
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();
    let lang = source_language.clone().unwrap_or_else(|| "en".into());
    let tgt = target_language.clone().unwrap_or_else(|| "zh-CN".into());

    // 登记每本书 (pending): 书库立刻可见, 可配语言/模型
    let books_repo = store::books_repo::BooksRepo::new(db);
    let mut registered = Vec::new();
    let mut skipped = Vec::new();
    for path in &book_paths {
        let book_id = crate::commands::library::book_id_from_path(path, &profile_id);
        if books_repo.get(&book_id).is_some() {
            skipped.push(path.clone());
            continue;
        }
        let book = store::books_repo::Book {
            id: book_id.clone(),
            title: std::path::Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Untitled".into()),
            source_path: path.clone(),
            pack_dir: String::new(), // 处理开始后才建任务目录
            profile_id: profile_id.clone(),
            status: "pending".into(),
            kind: "original".into(),
            source_book_id: None,
            chapter_count: 0,
            failed_count: 0,
            last_opened_at: None,
            source_language: lang.clone(),
            target_language: tgt.clone(),
            llm_id: None,
            tts_id: None,
            nlp_id: None,
            // v32: 体检 block 的书登记成 pending, 排队等后台兜底转换; 其余 none
            standardize_status: if needs_standardize.contains(path) {
                "pending".into()
            } else {
                "none".into()
            },
            standardize_note: None,
            standardize_cache_path: None,
            created_at: now_ms(),
            updated_at: now_ms(),
        };
        books_repo
            .upsert(&book)
            .map_err(|e| format!("写原书失败: {e}"))?;
        registered.push(path.clone());
    }
    // 只有真的登记了新书才建 batch (全跳过 = 重复导入, 不制造无意义批次; 前端据此提示)
    if registered.is_empty() {
        return Ok(ImportOutcome {
            batch_id: String::new(),
            registered,
            skipped,
        });
    }
    let batch_id = format!("batch-{}", uuid_short());
    let repo = store::batches_repo::BatchesRepo::new(db);
    let batch = store::batches_repo::Batch {
        id: batch_id.clone(),
        profile_id: profile_id.clone(),
        source_language: lang.clone(),
        target_language: tgt.clone(),
        status: "created".into(),
        total_books: registered.len() as i64,
        done_books: 0,
        failed_books: 0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    repo.upsert(&batch)
        .map_err(|e| format!("写批次失败: {e}"))?;
    Ok(ImportOutcome {
        batch_id,
        registered,
        skipped,
    })
}

/// 开始阅读准备 (R1/R2: 前置检查 → 通过的书入队; 未通过的书标原因)
/// book_ids: 前端从书库选中的待处理书 (属于该批次)。
/// 返回: { batch_id, enqueued: [book_id], skipped: [{book_id, reasons}] }
pub fn batch_start_prep(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    batch_id: String,
    book_ids: Vec<String>,
    profile: serde_json::Value,
    models: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let batch_repo = store::batches_repo::BatchesRepo::new(db);
    // R6-1 (2026-08-08): 前端"开始阅读准备"的 batch_id 依赖会话内存, 重启后伪造的 id
    // 在表里不存在 → 原来直接"批次不存在"报错, "导入→稍后处理"主流程断掉。
    // 修法: 不存在时按单书自动建批次(保留批次语义, 不阻塞入队)。
    let mut batch = match batch_repo.get(&batch_id) {
        Some(b) => b,
        None => {
            let now = now_ms();
            let b = store::batches_repo::Batch {
                id: batch_id.clone(),
                profile_id: "default".into(),
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                status: "created".into(),
                total_books: 0,
                done_books: 0,
                failed_books: 0,
                created_at: now,
                updated_at: now,
            };
            batch_repo
                .upsert(&b)
                .map_err(|e| format!("自动建批次失败: {e}"))?;
            b
        }
    };
    let books_repo = store::books_repo::BooksRepo::new(db);
    // 收集要处理的书的元数据
    let mut books = Vec::new();
    for id in &book_ids {
        if let Some(b) = books_repo.get(id) {
            books.push(serde_json::json!({
                "id": b.id,
                "source_path": b.source_path,
                "source_language": b.source_language,
            }));
        }
    }
    if books.is_empty() {
        return Err("没有可处理的书".into());
    }
    // R2/S3: 前置检查 (含 ffmpeg)
    let (ok_ids, skipped) =
        crate::application::model_service::preflight_batch(db, &books, &cfg.prep_path, &cfg.ffmpeg);
    // 通过的书 → 建 job + job_request → 入队
    let profile_obj = match &profile {
        serde_json::Value::String(s) => serde_json::json!({"id": s}),
        v => v.clone(),
    };
    let mut enqueued = Vec::new();
    for book_id in &ok_ids {
        let book = books_repo.get(book_id).ok_or("书不存在")?;
        let job_id = format!("job-{}", uuid_short());
        let job_dir = cfg.out_dir.join("jobs").join(&job_id);
        std::fs::create_dir_all(&job_dir).map_err(|e| format!("建任务目录失败: {e}"))?;
        // 书级模型
        let (b_llm, b_tts, b_nlp) =
            crate::application::model_service::resolve_for_book(db, book_id, &book.source_language);
        let mut book_models = match &models {
            serde_json::Value::Array(_) | serde_json::Value::Null => serde_json::json!({}),
            v => v.clone(),
        };
        if !b_llm.is_empty() {
            book_models["llm"] = serde_json::json!(b_llm);
        }
        if !b_tts.is_empty() {
            book_models["tts"] = serde_json::json!(b_tts);
        }
        if !b_nlp.is_empty() {
            book_models["spacy"] = serde_json::json!(b_nlp);
        }
        let job = store::jobs_repo::Job {
            id: job_id.clone(),
            edition_id: None,
            // BOOK_WORKFLOW §2.3: job 显式关联 source (用 source 行 id, 不是路径字符串)
            source_id: Some(book_id.clone()),
            book_path: book.source_path.clone(),
            profile_id: profile_obj
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(&book.profile_id)
                .to_string(),
            output_dir: job_dir.to_string_lossy().to_string(),
            status: "queued".into(),
            stage: String::new(),
            current: 0,
            total: 0,
            failed_count: 0,
            batch_id: Some(batch_id.clone()),
            source_language: book.source_language.clone(),
            target_language: book.target_language.clone(),
            error: None,
            progress: 0.0,
            created_at: now_ms(),
            updated_at: now_ms(),
        };
        let jobs = store::jobs_repo::JobsRepo::new(db);
        jobs.upsert(&job)
            .map_err(|e| format!("写任务表失败: {e}"))?;
        let std_cache = standardize_cache_for(db, book_id);
        let mut job_req = jobs::spawn::build_job_request(
            &book.source_path,
            &job_dir.to_string_lossy(),
            &profile_obj,
            &book_models,
            std_cache.as_deref(),
        );
        job_req["batch_id"] = serde_json::json!(batch_id);
        job_req["source_language"] = serde_json::json!(book.source_language);
        job_req["target_language"] = serde_json::json!(book.target_language);
        let req_path = job_dir.join("job_request.json");
        std::fs::write(&req_path, serde_json::to_string_pretty(&job_req).unwrap())
            .map_err(|e| format!("写 job_request 失败: {e}"))?;
        {
            let mut q = state.queue.lock().unwrap();
            q.push(job_id);
        }
        enqueued.push(book_id.clone());
    }
    // B1 (2026-08-18): 回填 total_books —— 自动建批次时硬编码 0, 入队数量此时才真正
    // 知道。此前从不回填, 实测 DB 里 10 个批次 total_books 全是 0, 前端组头一直显示
    // 「0 本书」。以实际入队数为准 (前置检查会跳过部分书)。
    // 和"有入队 → running"合成同一次 upsert: 这两件事都发生在入队循环之后、对同一行,
    // 分两次写没有额外语义, 只多一次锁 db.conn。
    let needs_write = batch.total_books != enqueued.len() as i64 || !enqueued.is_empty();
    if needs_write {
        batch.total_books = enqueued.len() as i64;
        if !enqueued.is_empty() {
            batch.status = "running".into();
        }
        batch.updated_at = now_ms();
        let _ = batch_repo.upsert(&batch);
    }
    let _ = app.emit("library-changed", serde_json::json!({}));
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    let _ = pump_queue(app.clone(), cfg, state, db);
    Ok(serde_json::json!({ "batch_id": batch_id, "enqueued": enqueued, "skipped": skipped }))
}

/// 批量任务 (兼容旧前端; 语义改为: 导入 + 立即开始 — 但新前端走 batch_import + batch_start_prep)
pub fn batch_start(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    book_paths: Vec<String>,
    profile: serde_json::Value,
    models: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<String, String> {
    use tauri::Emitter;
    if book_paths.is_empty() {
        return Err("批量任务至少需要一本书".into());
    }
    // M 系列 (单一真相源): 前端传来的 models 可能为空 (runtime_config 现在从注册表解析,
    // 但旧前端/异常路径可能缺) → 用 model_registry 推荐补全; 仍缺则可读失败。
    let lang = source_language.clone().unwrap_or_else(|| "en".into());
    let mut models_obj = match &models {
        serde_json::Value::Array(_) | serde_json::Value::Null => serde_json::json!({}),
        v => v.clone(),
    };
    let (reg_llm, reg_tts, reg_nlp) = crate::application::model_service::resolve_paths(db, &lang);
    if models_obj
        .get("llm")
        .and_then(|v| v.as_str())
        .map(|s| s.is_empty())
        .unwrap_or(true)
    {
        models_obj["llm"] = serde_json::json!(reg_llm);
    }
    if models_obj
        .get("tts")
        .and_then(|v| v.as_str())
        .map(|s| s.is_empty())
        .unwrap_or(true)
    {
        models_obj["tts"] = serde_json::json!(reg_tts);
    }
    if models_obj.get("spacy").is_none() && !reg_nlp.is_empty() {
        models_obj["spacy"] = serde_json::json!(reg_nlp);
    }
    let missing: Vec<&str> = ["llm", "tts"]
        .iter()
        .filter(|k| {
            !models_obj
                .get(**k)
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        })
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "缺少模型: {}。请先在模型中心配置并设为推荐。",
            missing.join(", ")
        ));
    }
    // profile 契约校验 (schema 要求 5 字段)
    let profile_obj = match &profile {
        serde_json::Value::String(s) => serde_json::json!({"id": s}),
        v => v.clone(),
    };
    let required_profile = [
        "id",
        "explain_strategy",
        "voice",
        "speed",
        "highlight_granularity",
    ];
    let missing_p: Vec<&str> = required_profile
        .iter()
        .filter(|k| profile_obj.get(**k).is_none())
        .copied()
        .collect();
    if !missing_p.is_empty() {
        return Err(format!(
            "profile 缺字段: {} (前端 ImportService 应组装完整)",
            missing_p.join(", ")
        ));
    }
    let batch_id = format!("batch-{}", uuid_short());
    let profile_id = profile
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();
    let repo = store::batches_repo::BatchesRepo::new(db);
    let batch = store::batches_repo::Batch {
        id: batch_id.clone(),
        profile_id: profile_id.clone(),
        source_language: source_language.clone().unwrap_or_else(|| "en".into()),
        target_language: target_language.clone().unwrap_or_else(|| "zh-CN".into()),
        status: "created".into(),
        total_books: book_paths.len() as i64,
        done_books: 0,
        failed_books: 0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    repo.upsert(&batch)
        .map_err(|e| format!("写批次失败: {e}"))?;

    for path in &book_paths {
        let job_id = format!("job-{}", uuid_short());
        let job_dir = cfg.out_dir.join("jobs").join(&job_id);
        std::fs::create_dir_all(&job_dir).map_err(|e| format!("建任务目录失败: {e}"))?;
        // P1 (苹果级闭环): 导入即登记书 (pending 状态) — 书设置弹窗在书库就能配,
        // 处理时 resolve_for_book 按书级绑定/语言解析模型。
        let book_id = crate::commands::library::book_id_from_path(path, &profile_id);
        let books_repo = store::books_repo::BooksRepo::new(db);
        if books_repo.get(&book_id).is_none() {
            let book = store::books_repo::Book {
                id: book_id.clone(),
                title: std::path::Path::new(path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Untitled".into()),
                source_path: path.clone(),
                pack_dir: job_dir.to_string_lossy().to_string(),
                profile_id: profile_id.clone(),
                status: "pending".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: batch.source_language.clone(),
                target_language: batch.target_language.clone(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                // 旧前端兼容路径 (batch_start) 没有体检步骤, 一律 none
                standardize_status: "none".into(),
                standardize_note: None,
                standardize_cache_path: None,
                created_at: now_ms(),
                updated_at: now_ms(),
            };
            let _ = books_repo.upsert(&book);
        }
        // 书级模型: 书有绑定用书级, 否则按书语言全局推荐
        let (b_llm, b_tts, b_nlp) = crate::application::model_service::resolve_for_book(
            db,
            &book_id,
            &batch.source_language,
        );
        let mut book_models = models_obj.clone();
        if !b_llm.is_empty() {
            book_models["llm"] = serde_json::json!(b_llm);
        }
        if !b_tts.is_empty() {
            book_models["tts"] = serde_json::json!(b_tts);
        }
        if !b_nlp.is_empty() {
            book_models["spacy"] = serde_json::json!(b_nlp);
        }
        let job = store::jobs_repo::Job {
            id: job_id.clone(),
            edition_id: None,
            // BOOK_WORKFLOW §2.3: job 显式关联 source (batch_start 旧兼容路径)
            source_id: Some(book_id.clone()),
            book_path: path.clone(),
            profile_id: profile_id.clone(),
            output_dir: job_dir.to_string_lossy().to_string(),
            status: "queued".into(),
            stage: String::new(),
            current: 0,
            total: 0,
            failed_count: 0,
            batch_id: Some(batch_id.clone()),
            source_language: batch.source_language.clone(),
            target_language: batch.target_language.clone(),
            error: None,
            progress: 0.0,
            created_at: now_ms(),
            updated_at: now_ms(),
        };
        let jobs = store::jobs_repo::JobsRepo::new(db);
        jobs.upsert(&job)
            .map_err(|e| format!("写任务表失败: {e}"))?;
        let std_cache = standardize_cache_for(db, &book_id);
        let mut job_req = jobs::spawn::build_job_request(
            path,
            &job_dir.to_string_lossy(),
            &profile,
            &book_models,
            std_cache.as_deref(),
        );
        job_req["batch_id"] = serde_json::json!(batch_id);
        job_req["source_language"] = serde_json::json!(batch.source_language);
        job_req["target_language"] = serde_json::json!(batch.target_language);
        let req_path = job_dir.join("job_request.json");
        std::fs::write(&req_path, serde_json::to_string_pretty(&job_req).unwrap())
            .map_err(|e| format!("写 job_request 失败: {e}"))?;
        {
            let mut q = state.queue.lock().unwrap();
            q.push(job_id);
        }
    }
    let _ = app.emit("library-changed", serde_json::json!({}));
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    let _ = pump_queue(app.clone(), cfg, state, db);
    Ok(batch_id)
}

pub fn job_retry_failed(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    id: String,
) -> Result<(), String> {
    // 旧入口 = 无任何 override 的自定义重跑 (模型按当前解析, 阶段自动)
    job_retry_custom(app, state, cfg, db, id, None, None, None, None, None)
}

/// 自定义重跑 (2026-08-13): 用户选错模型 / 想重做某阶段时, 可手动重选模型 (llm_id/tts_id/
/// nlp_id) + 指定重跑范围 (force_stages, 含下游级联)。缺省 = 模型按当前解析、阶段自动
/// (只跑失败/未完成) —— 与 job_retry_failed 等价。前端"重跑…"对话框调用。
#[allow(clippy::too_many_arguments)]
pub fn job_retry_custom(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    id: String,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
    force_stages: Option<Vec<String>>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = repo.get(&id).ok_or("任务不存在")?;
    // 2026-08-17: 放开 paused —— 用户反馈"暂停的时候也应该有重新备料的按钮"。暂停恰恰
    // 是最需要改设置的时刻(多半就是发现模型/档案不对才按的暂停), 而暂停态的任务子进程
    // 已被杀、checkpoint 完整保留, 重新排队和从 done/failed 重跑没有区别。
    // 仍然拦住 running/queued: 那两种状态下改 job_request 会和正在跑的进程打架。
    if !matches!(
        job.status.as_str(),
        "done" | "failed" | "partial" | "paused"
    ) {
        return Err("只有已完成或已暂停的任务能重跑".into());
    }
    // 原书 id 用 job.source_id (真实原书 id, 不重算 path+profile, 见 job_retry_failed 历史注释)
    let orig_book_id = job.source_id.clone().unwrap_or_else(|| {
        crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id)
    });
    let (b_llm, b_tts, b_nlp) = crate::application::model_service::resolve_for_book(
        db,
        &orig_book_id,
        &job.source_language,
    );
    // 显式 override 优先, 否则沿用书级绑定/全局推荐解析到的路径
    let model_repo = store::model_repo::ModelRepo::new(db);
    let llm = llm_id
        .and_then(|mid| model_repo.get(&mid).map(|m| m.path))
        .filter(|p| !p.is_empty())
        .unwrap_or(b_llm);
    let tts = tts_id
        .and_then(|mid| model_repo.get(&mid).map(|m| m.path))
        .filter(|p| !p.is_empty())
        .unwrap_or(b_tts);
    let nlp = nlp_id
        .and_then(|mid| model_repo.get(&mid).map(|m| m.path))
        .filter(|p| !p.is_empty())
        .unwrap_or(b_nlp);
    let mut book_models = serde_json::json!({});
    if !llm.is_empty() {
        book_models["llm"] = serde_json::json!(llm);
    }
    if !tts.is_empty() {
        book_models["tts"] = serde_json::json!(tts);
    }
    if !nlp.is_empty() {
        book_models["spacy"] = serde_json::json!(nlp);
    }
    // F13 (2026-08-08): 重跑必须保留原始 profile (音色/策略/速度/粒度快照)
    let job_dir = std::path::PathBuf::from(&job.output_dir);
    // STDIMPORT (2026-08-17, docs/GOAL_2026-08-16_STDIMPORT.md 方案 A): 重跑时可以重选
    // 学习档案。**不改 book_id**(book_id 里烧进去的档案段退化成"创建时的档案"这个历史
    // 标签), 只把新档案写进本次 job_request 和任务行——用户的诉求是"就地改设置再重跑,
    // 只重跑讲解", 不是"生成另一本书"(那条路径由书库里换档案重新创建译本覆盖)。
    // 查不到这个档案 id 时保守回退到原快照, 不让重跑因为档案没了而失败。
    let picked_profile = profile_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|pid| store::profile_repo::ProfileRepo::new(db).get(pid));
    let effective_profile_id = picked_profile
        .as_ref()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| job.profile_id.clone());
    let profile_obj = match &picked_profile {
        Some(p) => serde_json::json!({
            "id": p.id,
            "explain_strategy": p.explain_strategy,
            "voice": p.voice,
            "speed": p.speed,
            "highlight_granularity": p.highlight_granularity,
            "explain_max_chars": p.explain_max_chars,
            "explain_min_sentence_chars": p.explain_min_sentence_chars,
        }),
        None => profile_from_snapshot(&job_dir, &job.profile_id),
    };
    let std_cache = standardize_cache_for(db, &orig_book_id);
    let mut job_req = jobs::spawn::build_job_request(
        &job.book_path,
        &job_dir.to_string_lossy(),
        &profile_obj,
        &book_models,
        std_cache.as_deref(),
    );
    if let Some(bid) = &job.batch_id {
        job_req["batch_id"] = serde_json::json!(bid);
    }
    job_req["source_language"] = serde_json::json!(job.source_language);
    job_req["target_language"] = serde_json::json!(job.target_language);
    if let Some(fs) = &force_stages {
        if !fs.is_empty() {
            job_req["force_stages"] = serde_json::json!(fs);
        }
    }
    let req_path = job_dir.join("job_request.json");
    let _ = std::fs::write(&req_path, serde_json::to_string_pretty(&job_req).unwrap());
    {
        let mut q = state.queue.lock().unwrap();
        q.push(id.clone());
    }
    {
        let mut j = job.clone();
        j.profile_id = effective_profile_id.clone();
        j.status = "queued".into();
        j.stage = "retry_failed".into();
        j.error = None; // 重跑清除旧错误 (否则 UI 残留历史 os error 3)
        j.progress = 0.0;
        j.updated_at = now_ms();
        repo.upsert(&j)?;
    }
    let _ = pump_queue(app.clone(), cfg, state, db);
    Ok(())
}

/// R3: 暂停任务 (运行中 → kill 子进程, checkpoint 保留; 排队 → 移出队列)
pub fn job_pause(
    app: tauri::AppHandle,
    state: &PrepState,
    db: &store::Db,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = repo.get(&id).ok_or("任务不存在")?;
    match job.status.as_str() {
        "queued" => {
            // 排队中 → 从队列移除 + 状态 paused
            let mut q = state.queue.lock().unwrap();
            q.retain(|x| x != &id);
            drop(q);
            let mut j = job.clone();
            j.status = "paused".into();
            j.updated_at = now_ms();
            repo.upsert(&j)?;
        }
        "running" => {
            // 运行中 → kill 子进程; 子进程退出后 pump_queue 的收尾会把状态写成 done/failed,
            // 这里直接标记 paused, 收尾循环检测到 paused 就不覆盖
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
            drop(guard); // Bug fix (2026-08-13): 释放 child 锁再锁 running_job, 避免 ABBA 死锁
            *state.running_job.lock().unwrap() = None;
            let mut j = job.clone();
            j.status = "paused".into();
            j.updated_at = now_ms();
            repo.upsert(&j)?;
        }
        _ => {
            return Err(format!(
                "只有排队中或处理中的任务能暂停 (当前 {})",
                job.status
            ))
        }
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    Ok(())
}

/// K14 (2026-08-14): 取消任务(排队中/运行中 → 落 failed, error="用户取消")。
/// 之前 `commands::jobs::cancel_prep_job` 只杀进程清内存态, 从不写 DB——任务行
/// 永远卡在"running", pump_queue 收尾也不会碰它(它只在子进程真正退出时触发),
/// 造成一个既不在跑也标不出来的幽灵任务。跟"暂停"(落 paused, 可继续)是不同的
/// 终态: 取消落 failed(复用现有的"今天完成"历史 + 重跑/移除 UI, 不新造一套
/// 状态展示), 明确不可续跑。
pub fn job_cancel(
    app: tauri::AppHandle,
    cfg: &PrepConfig,
    state: &PrepState,
    db: &store::Db,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = repo.get(&id).ok_or("任务不存在")?;
    match job.status.as_str() {
        "queued" => {
            let mut q = state.queue.lock().unwrap();
            q.retain(|x| x != &id);
            drop(q);
            let mut j = job.clone();
            j.status = "failed".into();
            j.error = Some("用户取消".into());
            j.updated_at = now_ms();
            repo.upsert(&j)?;
        }
        "running" => {
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
            drop(guard);
            *state.running_job.lock().unwrap() = None;
            let mut j = job.clone();
            j.status = "failed".into();
            j.error = Some("用户取消".into());
            j.updated_at = now_ms();
            repo.upsert(&j)?;
            // 队列里还有别的任务时接着跑, 不是取消一个就把整条队列停了
            let _ = pump_queue(app.clone(), cfg, state, db);
        }
        _ => {
            return Err(format!(
                "只有排队中或处理中的任务能取消 (当前 {})",
                job.status
            ))
        }
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    Ok(())
}

/// R3: 继续任务 (paused → queued, 重新入队; checkpoint 续跑)
pub fn job_resume(
    app: tauri::AppHandle,
    state: &PrepState,
    cfg: &PrepConfig,
    db: &store::Db,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = repo.get(&id).ok_or("任务不存在")?;
    if job.status != "paused" {
        return Err(format!("只有已暂停的任务能继续 (当前 {})", job.status));
    }
    let mut j = job.clone();
    j.status = "queued".into();
    j.updated_at = now_ms();
    repo.upsert(&j)?;
    {
        let mut q = state.queue.lock().unwrap();
        q.push(id.clone());
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    let _ = pump_queue(app.clone(), cfg, state, db);
    Ok(())
}

pub fn pump_queue(
    app: tauri::AppHandle,
    cfg: &PrepConfig,
    state: &PrepState,
    db: &store::Db,
) -> Result<(), String> {
    use tauri::Emitter;

    if state.running_job.lock().unwrap().is_some() {
        return Ok(());
    }
    let next = {
        let mut q = state.queue.lock().unwrap();
        if q.is_empty() {
            return Ok(());
        }
        Some(q.remove(0))
    };
    let job_id = next.unwrap();

    let repo = store::jobs_repo::JobsRepo::new(db);
    let job = match repo.get(&job_id) {
        Some(j) => j,
        None => {
            // UX 审计 (2026-08-09): 任务已被移除但 id 仍留在内存队列 (job_remove 的
            // 防御兜底) —— 跳过并继续下一个, 而不是返回 Err 让整条队列停摆且无反馈。
            return pump_queue(app, cfg, state, db);
        }
    };
    // R3: 队列里出现 paused (异常路径) → 跳过不处理
    if job.status == "paused" {
        return pump_queue(app, cfg, state, db);
    }

    {
        let mut j = job.clone();
        j.status = "running".into();
        j.updated_at = now_ms();
        repo.upsert(&j)?;
    }
    // R6: 任务 running → 关联书 status = processing (书库徽章"处理中")
    {
        // Bug fix (2026-08-13): 关联书用 job.source_id (真实原书 id), 不重算 path+profile
        // (profile 是处理参数, 与 source 书登记时 profile 可能不一致 → 重算得到不存在的 id)。
        let book_id = job.source_id.clone().unwrap_or_else(|| {
            crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id)
        });
        let books_repo = store::books_repo::BooksRepo::new(db);
        if let Some(mut b) = books_repo.get(&book_id) {
            if b.status == "pending" || b.status == "failed" {
                b.status = "processing".into();
                b.pack_dir = job.output_dir.clone();
                b.updated_at = now_ms();
                let _ = books_repo.upsert(&b);
                let _ = app.emit("library-changed", serde_json::json!({}));
            }
        }
    }
    *state.running_job.lock().unwrap() = Some(job_id.clone());

    let req_path = std::path::Path::new(&job.output_dir).join("job_request.json");
    let job_dir = std::path::PathBuf::from(&job.output_dir);
    let (child, lines) = match jobs::spawn::spawn_prep(&cfg.prep_path, &req_path, &job_dir) {
        Ok(v) => v,
        Err(e) => {
            // Bug fix (审查确认): spawn 失败时清理 running_job + 标记任务 failed,
            // 否则队列永久卡死且无任何反馈
            *state.running_job.lock().unwrap() = None;
            *state.child.lock().unwrap() = None;
            let mut j = job.clone();
            j.status = "failed".into();
            j.stage = "spawn_error".into();
            j.error = Some(format!("启动处理引擎失败: {e}"));
            j.updated_at = now_ms();
            let _ = repo.upsert(&j);
            let _ = app.emit(
                "job-progress",
                serde_json::json!({
                    "jobId": job_id, "batchId": job.batch_id, "type": "error",
                    "message": format!("启动处理引擎失败: {e}"), "ts": now_ms()
                }),
            );
            // 继续处理队列里的下一个任务
            let _ = pump_queue(app, cfg, state, db);
            return Err(format!("启动侧车失败: {e}"));
        }
    };
    *state.child.lock().unwrap() = Some(child);

    let app2 = app.clone();
    let job_id2 = job_id.clone();
    let profile_id = job.profile_id.clone();
    let book_path2 = job.book_path.clone();
    let job_dir2 = job_dir.clone();
    let job_batch_id2 = job.batch_id.clone();
    let job_src_lang = job.source_language.clone(); // Bug fix: 用真实语言登记书库 (审查确认)
    let job_tgt_lang = job.target_language.clone();
    // v8 资产模型: 本次处理用的模型 (job_request 里已解析) + 原书 id
    // Bug fix (2026-08-13): 原书 id 用 job.source_id, 不重算 path+profile (同上)。
    let orig_book_id2 = job.source_id.clone().unwrap_or_else(|| {
        crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id)
    });
    // 阶段4 (2026-08-09): 模型快照从 job_request.json 读 —— 不同模型组合要能生成不同 edition
    // (editions 表 asset key 含 llm_id/tts_id, 空串会让所有组合塌缩成一个键)。此前这里写死空串,
    // 注释自证"后续从 job_request 读"但没实现。
    let job_request_path = job_dir.join("job_request.json");
    let req_models = std::fs::read_to_string(&job_request_path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("models").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    let req_llm = req_models
        .get("llm")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let req_tts = req_models
        .get("tts")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let job_llm_id2 = req_llm;
    let job_tts_id2 = req_tts;
    let app_state = app2.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let mut failed_count: i64 = 0;
        for line in lines {
            match jobs::progress::parse_progress_line(&line) {
                Ok(ev) => {
                    match &ev {
                        jobs::progress::ProgressEvent::StageProgress {
                            stage,
                            current,
                            total,
                            ..
                        } => {
                            if let Some(db) = app_state.try_state::<store::Db>() {
                                let repo = store::jobs_repo::JobsRepo::new(db.inner());
                                if let Some(mut j) = repo.get(&job_id2) {
                                    j.stage = stage.clone();
                                    j.current = *current;
                                    j.total = *total;
                                    // v9: 全书完成度 (阶段权重均分, 后端算)
                                    j.progress = overall_progress(&j.stage, *current, *total);
                                    j.updated_at = now_ms();
                                    let _ = repo.upsert(&j);
                                }
                            }
                        }
                        jobs::progress::ProgressEvent::SentenceDone { sentence_index, .. } => {
                            // 进度优化: sentence_done (TTS 等逐句阶段) 驱动 UI 进度
                            // 注意: sentence_index 是章内句号, 跨章会回退 → 只前进不后退
                            if let Some(db) = app_state.try_state::<store::Db>() {
                                let repo = store::jobs_repo::JobsRepo::new(db.inner());
                                if let Some(mut j) = repo.get(&job_id2) {
                                    let done = (*sentence_index + 1).max(j.current);
                                    j.current = done;
                                    j.progress = overall_progress(&j.stage, done, j.total);
                                    j.updated_at = now_ms();
                                    let _ = repo.upsert(&j);
                                }
                            }
                        }
                        jobs::progress::ProgressEvent::Error { .. } => {
                            failed_count += 1;
                            if let Some(db) = app_state.try_state::<store::Db>() {
                                let repo = store::jobs_repo::JobsRepo::new(db.inner());
                                if let Some(mut j) = repo.get(&job_id2) {
                                    j.failed_count = failed_count;
                                    j.updated_at = now_ms();
                                    let _ = repo.upsert(&j);
                                }
                            }
                        }
                        _ => {}
                    }
                    let mut payload = enrich_progress(ev, &job_id2);
                    if let Some(bid) = &job_batch_id2 {
                        payload["batchId"] = serde_json::json!(bid);
                    }
                    let _ = app_state.emit("job-progress", payload);
                }
                Err(e) => {
                    let _ = app_state.emit("job-progress", serde_json::json!({
                        "jobId": job_id2, "batchId": job_batch_id2, "type": "error", "message": e, "ts": now_ms()
                    }));
                }
            }
        }
        if let Some(db) = app_state.try_state::<store::Db>() {
            let repo = store::jobs_repo::JobsRepo::new(db.inner());
            let mut job_batch_id: Option<String> = None;
            if let Some(mut j) = repo.get(&job_id2) {
                // R3: 被暂停的任务 (paused) 不被收尾覆盖 — checkpoint 保留, resume 续跑
                if j.status == "paused" {
                    job_batch_id = j.batch_id.clone();
                    j.updated_at = now_ms();
                    let _ = repo.upsert(&j);
                } else {
                    let bp = std::path::Path::new(&j.output_dir).join("bookpack.json");
                    j.status = if bp.exists() {
                        "done".into()
                    } else {
                        "failed".into()
                    };
                    // I-C: 失败可读 —— 从 quality_report.json 生成摘要
                    if j.status == "failed" {
                        j.error =
                            crate::application::quality_notice::quality_summary(&j.output_dir)
                                .or_else(|| Some("任务失败 (无详情报告)".into()));
                    }
                    // 2026-08-19 (用户报"打开一本书不显示插图"追出的第三个 bug):
                    // BookpackCache 是内存 LRU, 键就是 output_dir。用户在任务还没跑完时
                    // 点开过这本书(比如查看进度), load_bookpack 会把当时残缺的
                    // bookpack.json 缓存住; 任务这里跑完、磁盘上的 bookpack.json 已经
                    // 换成含插图的完整版本, 但内存缓存从来没人告诉它"该失效了"——
                    // 之前这张缓存只在删除书时失效(book_assets.rs::backfill_cover /
                    // library.rs 的级联删除), 任务正常完成这条路径上完全没有失效点。
                    // 结果用户看到的书库/阅读器一直是缓存里那份不含插图的旧内容,
                    // 直到重启 app(内存清空)才会重新读到磁盘上正确的版本。
                    if let Some(cache) = app_state
                        .try_state::<crate::infrastructure::bookpack_cache::BookpackCache>(
                    ) {
                        cache.invalidate(&j.output_dir);
                    }
                    j.updated_at = now_ms();
                    job_batch_id = j.batch_id.clone();
                    let _ = repo.upsert(&j);
                }
            }
            if let Some(bid) = job_batch_id {
                let batch_repo = store::batches_repo::BatchesRepo::new(db.inner());
                let jobs = repo.list_by_batch(&bid);
                let done = jobs.iter().filter(|j| j.status == "done").count() as i64;
                let failed = jobs.iter().filter(|j| j.status == "failed").count() as i64;
                let _ = batch_repo.update_progress(&bid, done, failed);
                let _ = app_state.emit(
                    "batch-progress",
                    serde_json::json!({"batchId": bid, "done": done, "failed": failed}),
                );
            }
            let bp = std::path::Path::new(&job_dir2).join("bookpack.json");
            if bp.exists() {
                if let Ok(text) = std::fs::read_to_string(&bp) {
                    if crate::application::library_service::parse_bookpack_meta(&text).is_some() {
                        let id = crate::commands::library::book_id_from_path(
                            &job_dir2.to_string_lossy(),
                            &profile_id,
                        );
                        let _ = crate::application::library_service::register_book(
                            db.inner(),
                            id,
                            &job_dir2.to_string_lossy(),
                            book_path2.clone(),
                            orig_book_id2.clone(), // v8: 关联原书 (资产键)
                            profile_id.clone(),
                            job_src_lang.clone(),
                            job_tgt_lang.clone(),
                            // v8: 本次处理用的模型快照
                            if job_llm_id2.is_empty() {
                                None
                            } else {
                                Some(job_llm_id2.clone())
                            },
                            if job_tts_id2.is_empty() {
                                None
                            } else {
                                Some(job_tts_id2.clone())
                            },
                            None,
                        );
                        if let Some(edition) =
                            crate::store::editions_repo::EditionsRepo::new(db.inner())
                                .find_by_pack_dir(&job_dir2.to_string_lossy())
                        {
                            let _ = crate::store::jobs_repo::JobsRepo::new(db.inner())
                                .attach_edition(&job_id2, &edition.id);
                        }
                        // v7 架构分离: 原版书标 done (产物独立为 product)
                        // Bug fix (2026-08-13): 用 orig_book_id2 (job.source_id) 而非重算
                        // path+profile —— 否则 profile 错配时标错书、原书永远不显示 done。
                        crate::application::library_service::mark_original_done(
                            db.inner(),
                            &orig_book_id2,
                        );
                        let _ = app_state.emit("library-changed", serde_json::json!({}));
                    }
                }
            }
        }
        let prep_state_opt = app_state.try_state::<PrepState>();
        if let Some(st) = &prep_state_opt {
            *st.running_job.lock().unwrap() = None;
            *st.child.lock().unwrap() = None;
        }
        if let (Some(cfg), Some(db), Some(st)) = (
            app_state.try_state::<PrepConfig>(),
            app_state.try_state::<store::Db>(),
            prep_state_opt,
        ) {
            let _ = pump_queue(app_state.clone(), cfg.inner(), st.inner(), db.inner());
        }
        let _ = app_state.emit("job-list-changed", serde_json::json!({}));
    });

    Ok(())
}

/// v9: 全书完成度 = (已完阶段数 + 当前阶段比例) / 总阶段数 × 100
/// 7 阶段均分: parse→nlp→translate→explain→tts→align→pack
fn overall_progress(stage: &str, current: i64, total: i64) -> f64 {
    const STAGES: [&str; 7] = [
        "parse",
        "nlp",
        "translate",
        "explain",
        "tts",
        "align",
        "pack",
    ];
    let idx = STAGES.iter().position(|s| *s == stage).unwrap_or(0);
    let stage_ratio = if total > 0 {
        (current as f64 / total as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let overall = (idx as f64 + stage_ratio) / STAGES.len() as f64;
    (overall * 100.0).round()
}

fn enrich_progress(ev: jobs::progress::ProgressEvent, job_id: &str) -> serde_json::Value {
    use jobs::progress::ProgressEvent as E;
    match ev {
        E::StageStart { stage, ts } => {
            serde_json::json!({"jobId": job_id, "type": "stage_start", "stage": stage, "ts": ts})
        }
        E::StageProgress {
            stage,
            current,
            total,
            ts,
        } => {
            // UX 审计 (2026-08-09): 把全书完成度一并带上 —— 前端实时刷进度条用同一
            // 个 overall 值, 否则条(阶段比例)和旁边百分比标签(全书进度)显示不一致。
            serde_json::json!({"jobId": job_id, "type": "stage_progress", "stage": stage,
                "current": current, "total": total, "progress": overall_progress(&stage, current, total), "ts": ts})
        }
        E::StageDone {
            stage,
            current,
            total,
            ts,
        } => {
            serde_json::json!({"jobId": job_id, "type": "stage_done", "stage": stage,
                "current": current, "total": total, "progress": overall_progress(&stage, current, total), "ts": ts})
        }
        E::SentenceDone {
            sentence_index,
            status,
            ts,
        } => {
            serde_json::json!({"jobId": job_id, "type": "sentence_done", "sentence_index": sentence_index, "status": status, "ts": ts})
        }
        E::JobDone {
            exit_code,
            message,
            ts,
        } => {
            serde_json::json!({"jobId": job_id, "type": "job_done", "exit_code": exit_code, "message": message, "ts": ts})
        }
        E::Error {
            message,
            detail,
            ts,
        } => {
            serde_json::json!({"jobId": job_id, "type": "error", "message": message, "detail": detail, "ts": ts})
        }
    }
}

/// F13 (2026-08-08): 从任务目录的 job_request.json 快照恢复原始 profile 参数。
/// 重试失败句时保留"这本书当年怎么配的"(音色/策略/速度/粒度), 而不是换回硬编码默认。
/// 快照缺失/解析失败 → 返回给定默认值。纯函数, 可单测。
/// 2026-08-16 补: K33 的 explain_max_chars/explain_min_sentence_chars 原本不在拷贝
/// 列表里, 重跑会静默丢掉用户设的讲解字数上限/触发门槛, 退回默认值。
fn profile_from_snapshot(job_dir: &std::path::Path, profile_id: &str) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "id": profile_id,
        "explain_strategy": "brief",
        "voice": "af_heart",
        "speed": 1.0,
        "highlight_granularity": "sentence",
        "explain_max_chars": 150,
        "explain_min_sentence_chars": 0,
    });
    if let Ok(text) = std::fs::read_to_string(job_dir.join("job_request.json")) {
        if let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(p) = req.get("profile").and_then(|x| x.as_object()) {
                for k in [
                    "explain_strategy",
                    "voice",
                    "speed",
                    "highlight_granularity",
                    "explain_max_chars",
                    "explain_min_sentence_chars",
                ] {
                    if let Some(v) = p.get(k) {
                        obj[k] = v.clone();
                    }
                }
            }
        }
    }
    obj
}

#[cfg(test)]
mod tests {
    use super::{enrich_progress, overall_progress, profile_from_snapshot, register_import_batch};

    #[test]
    fn enrich_progress_carries_overall_progress() {
        // UX 审计 (2026-08-09): stage_progress/stage_done 事件必须带全书完成度,
        // 前端实时刷新进度条与百分比标签才用同一个值 (此前条按阶段比例、标签按全书进度打架)。
        let payload = enrich_progress(
            crate::jobs::progress::ProgressEvent::StageProgress {
                stage: "translate".into(),
                current: 50,
                total: 100,
                ts: 1,
            },
            "job-1",
        );
        let expect = overall_progress("translate", 50, 100);
        assert_eq!(payload["type"], "stage_progress");
        assert_eq!(
            payload["progress"].as_f64(),
            Some(expect),
            "progress 应为全书完成度 {expect}"
        );
        assert_eq!(payload["current"], 50);
        assert_eq!(payload["total"], 100);

        let done = enrich_progress(
            crate::jobs::progress::ProgressEvent::StageDone {
                stage: "nlp".into(),
                current: 240,
                total: 240,
                ts: 2,
            },
            "job-1",
        );
        assert_eq!(done["type"], "stage_done");
        assert_eq!(
            done["progress"].as_f64(),
            Some(overall_progress("nlp", 240, 240))
        );
    }

    #[test]
    fn import_same_path_twice_yields_one_source_and_skips_second() {
        // F45 (2026-08-09): 同一路径 + 同一 profile 重复导入 → 只有 1 条 source,
        // 第二次进入 skipped, 不再登记第二条 source(用户"导入两次"的根因修复)。
        let path = std::env::temp_dir().join(format!("aidulc_imp_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        let profile = serde_json::json!({"id": "default"});
        let p = "/tmp/Alice.epub".to_string();
        let first =
            register_import_batch(&db, vec![p.clone()], vec![], profile.clone(), None, None)
                .unwrap();
        assert_eq!(first.registered.len(), 1);
        assert!(first.skipped.is_empty());
        let second =
            register_import_batch(&db, vec![p.clone()], vec![], profile, None, None).unwrap();
        assert!(second.registered.is_empty());
        assert_eq!(second.skipped, vec![p.clone()]);
        let c = db.conn.lock().unwrap();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM books WHERE source_path=?1",
                [&p],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "同一路径重复导入只能有 1 条 source");
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_different_profiles_yield_two_sources() {
        // 资产模型: 不同 profile = 不同资产, 允许同路径多 source
        let path = std::env::temp_dir().join(format!("aidulc_imp2_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        let p = "/tmp/Alice.epub".to_string();
        register_import_batch(
            &db,
            vec![p.clone()],
            vec![],
            serde_json::json!({"id": "default"}),
            None,
            None,
        )
        .unwrap();
        register_import_batch(
            &db,
            vec![p.clone()],
            vec![],
            serde_json::json!({"id": "kid"}),
            None,
            None,
        )
        .unwrap();
        let c = db.conn.lock().unwrap();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM books WHERE source_path=?1",
                [&p],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_does_not_create_edition_or_reading_state() {
        // BOOK_WORKFLOW: 导入只创建 source, 不创建 pack_dir/edition/reading_state
        let path = std::env::temp_dir().join(format!("aidulc_imp3_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        register_import_batch(
            &db,
            vec!["/tmp/Alice.epub".to_string()],
            vec![],
            serde_json::json!({"id": "default"}),
            None,
            None,
        )
        .unwrap();
        let c = db.conn.lock().unwrap();
        for (t, _key) in [("editions", "source_id"), ("reading_state", "book_key")] {
            let n: i64 = c
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "导入不应创建 {t}");
        }
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn register_import_batch_marks_needs_standardize_as_pending() {
        // v32: verdict=block 的路径登记成 standardize_status='pending', 其它 'none'
        let path = std::env::temp_dir().join(format!("aidulc_stdimp_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        let ok = "/tmp/Good.epub".to_string();
        let bad = "/tmp/Bad.epub".to_string();
        register_import_batch(
            &db,
            vec![ok.clone(), bad.clone()],
            vec![bad.clone()],
            serde_json::json!({"id": "default"}),
            None,
            None,
        )
        .unwrap();
        let repo = crate::store::books_repo::BooksRepo::new(&db);
        let good = repo
            .get(&crate::commands::library::book_id_from_path(&ok, "default"))
            .unwrap();
        let badb = repo
            .get(&crate::commands::library::book_id_from_path(
                &bad, "default",
            ))
            .unwrap();
        assert_eq!(good.standardize_status, "none", "体检通过的书不需要转换");
        assert_eq!(badb.standardize_status, "pending", "block 的书应排队待转换");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retry_profile_from_snapshot_keeps_kid_params() {
        // F13: job_request.json 快照里有 kid 的 deep/0.9x/词级 → 重试必须保留
        let dir = std::env::temp_dir().join(format!("aidulc_pfs_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("job_request.json"),
            serde_json::to_string(&serde_json::json!({
                "profile": {
                    "id": "kid",
                    "explain_strategy": "deep",
                    "voice": "af_heart",
                    "speed": 0.9,
                    "highlight_granularity": "word"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let p = profile_from_snapshot(&dir, "kid");
        assert_eq!(p["explain_strategy"], "deep");
        assert_eq!(p["voice"], "af_heart");
        assert_eq!(p["speed"], 0.9);
        assert_eq!(p["highlight_granularity"], "word");
        assert_eq!(p["id"], "kid");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_profile_snapshot_missing_falls_back_to_defaults() {
        // 快照不存在/解析失败 → 默认 brief/af_heart/1.0/sentence, 不崩溃
        let dir = std::env::temp_dir().join(format!("aidulc_pfs_m_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = profile_from_snapshot(&dir, "kid");
        assert_eq!(p["explain_strategy"], "brief");
        assert_eq!(p["speed"], 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_stage_weighted() {
        // v9: 翻译进行一半 → 阶段1(parse)+阶段2(nlp)完 + 阶段3(translate)50%
        let p = overall_progress("translate", 50, 100);
        assert_eq!(p, 36.0, "2.5/7 阶段 = 36%");
        // parse 阶段完成 → 14%
        assert_eq!(overall_progress("parse", 1, 1), 14.0);
        // 最后阶段 pack 完成 → 100%
        assert_eq!(overall_progress("pack", 1, 1), 100.0);
        // 未知阶段按 0 处理
        assert_eq!(overall_progress("bogus", 0, 0), 0.0);
    }

    #[test]
    fn summary_parses_quality_report() {
        let dir = std::env::temp_dir().join(format!("aidulc_qs_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("quality_report.json"),
            r#"{
            "failedSentences": [
                {"chapter": 0, "index": 3, "stages": ["translate"], "reason": "API 超时"},
                {"chapter": 1, "index": 7, "stages": ["tts"], "reason": "模型加载失败"},
                {"chapter": 2, "index": 0, "stages": ["nlp", "translate"], "reason": ""}
            ],
            "summary": "3 句有部分阶段失败 (nlp, translate, tts)。"
        }"#,
        )
        .unwrap();
        let s = crate::application::quality_notice::quality_summary(dir.to_str().unwrap()).unwrap();
        assert!(s.contains("3 句有失败阶段"), "got: {s}");
        assert!(s.contains("translate") && s.contains("tts"), "got: {s}");
        assert!(s.contains("API 超时"), "原因应入摘要: {s}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_fallback_no_report() {
        let dir = std::env::temp_dir().join(format!("aidulc_qf_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 无 quality_report.json → None (调用处兜底 "无详情报告")
        assert!(
            crate::application::quality_notice::quality_summary(dir.to_str().unwrap()).is_none()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_snapshot_keeps_k33_fields() {
        // K33 字段 (explain_max_chars / explain_min_sentence_chars) 应从 job_request.json
        // 中保留，而不是被默认值覆盖。这条测的就是改动 1 修的 bug。
        let dir = std::env::temp_dir().join(format!("aidulc_ps_k33_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let job_request = serde_json::json!({
            "profile": {
                "explain_strategy": "deep",
                "voice": "af_x",
                "speed": 1.2,
                "highlight_granularity": "word",
                "explain_max_chars": 100,
                "explain_min_sentence_chars": 30
            }
        });
        std::fs::write(
            dir.join("job_request.json"),
            serde_json::to_string_pretty(&job_request).unwrap(),
        )
        .unwrap();
        let result = profile_from_snapshot(&dir, "p1");
        assert_eq!(result["explain_max_chars"], 100);
        assert_eq!(result["explain_min_sentence_chars"], 30);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_snapshot_defaults_when_absent() {
        // 无 job_request.json 时，应返回正确的默认值，包括 K33 字段。
        let dir = std::env::temp_dir().join(format!("aidulc_ps_def_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let result = profile_from_snapshot(&dir, "p1");
        assert_eq!(result["explain_max_chars"], 150);
        assert_eq!(result["explain_min_sentence_chars"], 0);
        assert_eq!(result["id"], "p1");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
