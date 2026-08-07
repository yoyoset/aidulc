//! commands/jobs.rs —— 备料任务命令 (G4: 从 main.rs 拆分)
//! 依赖 app 状态 (PrepState/PrepConfig), 通过 State 注入。

use crate::{jobs, store, PrepConfig, PrepState};
use tauri::Manager;
use tauri::State;

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

/// 启动单本任务 (G2: 支持 batch_id/多语言)
#[tauri::command]
pub fn start_prep_job(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
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

    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let job = store::jobs_repo::Job {
        id: job_id.clone(),
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

    let mut job_req =
        jobs::spawn::build_job_request(&book_path, &job_dir.to_string_lossy(), &profile, &models);
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
    let _ = app.emit("job-progress", serde_json::json!({
        "jobId": job_id, "batchId": batch_id, "type": "stage_start", "stage": "queued", "ts": now_ms()
    }));
    app.emit("job-list-changed", serde_json::json!({})).ok();

    let _ = pump_queue(app.clone(), cfg.inner(), state.inner(), db.inner());
    Ok(job_id)
}

/// 导入批次 (R1: 只登记书+批次, 不开始处理)
/// 返回 batch_id。用户稍后在书库点"开始阅读准备" → batch_start_prep。
#[tauri::command]
pub fn batch_import(
    app: tauri::AppHandle,
    db: State<store::Db>,
    book_paths: Vec<String>,
    profile: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<String, String> {
    use tauri::Emitter;
    if book_paths.is_empty() {
        return Err("至少需要一本书".into());
    }
    let batch_id = format!("batch-{}", uuid_short());
    let profile_id = profile
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();
    let lang = source_language.clone().unwrap_or_else(|| "en".into());
    let tgt = target_language.clone().unwrap_or_else(|| "zh-CN".into());
    let repo = store::batches_repo::BatchesRepo::new(db.inner());
    let batch = store::batches_repo::Batch {
        id: batch_id.clone(),
        profile_id: profile_id.clone(),
        source_language: lang.clone(),
        target_language: tgt.clone(),
        status: "created".into(),
        total_books: book_paths.len() as i64,
        done_books: 0,
        failed_books: 0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    repo.upsert(&batch)
        .map_err(|e| format!("写批次失败: {e}"))?;

    // 登记每本书 (pending): 书库立刻可见, 可配语言/模型
    let books_repo = store::books_repo::BooksRepo::new(db.inner());
    for path in &book_paths {
        let book_id = crate::commands::library::book_id_from_path(path, &profile_id);
        if books_repo.get(&book_id).is_none() {
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
                created_at: now_ms(),
                updated_at: now_ms(),
            };
            let _ = books_repo.upsert(&book);
        }
    }
    let _ = app.emit("library-changed", serde_json::json!({}));
    Ok(batch_id)
}

/// 开始阅读准备 (R1/R2: 前置检查 → 通过的书入队; 未通过的书标原因)
/// book_ids: 前端从书库选中的待处理书 (属于该批次)。
/// 返回: { batch_id, enqueued: [book_id], skipped: [{book_id, reasons}] }
#[tauri::command]
pub fn batch_start_prep(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    batch_id: String,
    book_ids: Vec<String>,
    profile: serde_json::Value,
    models: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let batch_repo = store::batches_repo::BatchesRepo::new(db.inner());
    let batch = batch_repo.get(&batch_id).ok_or("批次不存在")?;
    let books_repo = store::books_repo::BooksRepo::new(db.inner());
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
    let (ok_ids, skipped) = crate::application::model_service::preflight_batch(
        db.inner(),
        &books,
        &cfg.inner().prep_path,
        &cfg.inner().ffmpeg,
    );
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
        let (b_llm, b_tts, b_nlp) = crate::application::model_service::resolve_for_book(
            db.inner(),
            book_id,
            &book.source_language,
        );
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
            book_path: book.source_path.clone(),
            profile_id: book.profile_id.clone(),
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
        let jobs = store::jobs_repo::JobsRepo::new(db.inner());
        jobs.upsert(&job)
            .map_err(|e| format!("写任务表失败: {e}"))?;
        let mut job_req = jobs::spawn::build_job_request(
            &book.source_path,
            &job_dir.to_string_lossy(),
            &profile_obj,
            &book_models,
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
    // 批次状态: 有入队 → running
    if !enqueued.is_empty() {
        let mut b = batch.clone();
        b.status = "running".into();
        b.updated_at = now_ms();
        let _ = batch_repo.upsert(&b);
    }
    let _ = app.emit("library-changed", serde_json::json!({}));
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    let _ = pump_queue(app.clone(), cfg.inner(), state.inner(), db.inner());
    Ok(serde_json::json!({ "batch_id": batch_id, "enqueued": enqueued, "skipped": skipped }))
}

/// 批量任务 (兼容旧前端; 语义改为: 导入 + 立即开始 — 但新前端走 batch_import + batch_start_prep)
#[tauri::command]
pub fn batch_start(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
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
    let (reg_llm, reg_tts, reg_nlp) =
        crate::application::model_service::resolve_paths(db.inner(), &lang);
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
        .map(|k| *k)
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
        .map(|k| *k)
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
    let repo = store::batches_repo::BatchesRepo::new(db.inner());
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
        let books_repo = store::books_repo::BooksRepo::new(db.inner());
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
                created_at: now_ms(),
                updated_at: now_ms(),
            };
            let _ = books_repo.upsert(&book);
        }
        // 书级模型: 书有绑定用书级, 否则按书语言全局推荐
        let (b_llm, b_tts, b_nlp) = crate::application::model_service::resolve_for_book(
            db.inner(),
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
        let jobs = store::jobs_repo::JobsRepo::new(db.inner());
        jobs.upsert(&job)
            .map_err(|e| format!("写任务表失败: {e}"))?;
        let mut job_req = jobs::spawn::build_job_request(
            path,
            &job_dir.to_string_lossy(),
            &profile,
            &book_models,
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
    let _ = pump_queue(app.clone(), cfg.inner(), state.inner(), db.inner());
    Ok(batch_id)
}

#[tauri::command]
pub fn batch_list(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let repo = store::batches_repo::BatchesRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list()).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn batch_detail(db: State<store::Db>, id: String) -> Result<serde_json::Value, String> {
    let repo = store::batches_repo::BatchesRepo::new(db.inner());
    let batch = repo.get(&id).ok_or("批次不存在")?;
    let jobs = store::jobs_repo::JobsRepo::new(db.inner()).list_by_batch(&id);
    Ok(serde_json::json!({"batch": batch, "jobs": jobs}))
}

#[tauri::command]
pub fn job_list(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    Ok(serde_json::to_value(repo.list()).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn job_remove(db: State<store::Db>, id: String) -> Result<(), String> {
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    repo.remove(&id)
}

#[tauri::command]
pub fn job_retry_failed(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let job = repo.get(&id).ok_or("任务不存在")?;
    if job.status != "done" && job.status != "failed" && job.status != "partial" {
        return Err("只有已完成的任务能重试失败句".into());
    }
    // 修复: 重试重建 job_request (用当前模型推荐, 旧快照可能指向已失效的模型路径)
    // 否则侧车继续用旧 tts/llm 路径 → 失败永远复现
    let orig_book_id = crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id);
    let (b_llm, b_tts, b_nlp) = crate::application::model_service::resolve_for_book(
        db.inner(),
        &orig_book_id,
        &job.source_language,
    );
    let mut book_models = serde_json::json!({});
    if !b_llm.is_empty() {
        book_models["llm"] = serde_json::json!(b_llm);
    }
    if !b_tts.is_empty() {
        book_models["tts"] = serde_json::json!(b_tts);
    }
    if !b_nlp.is_empty() {
        book_models["spacy"] = serde_json::json!(b_nlp);
    }
    let profile_obj = serde_json::json!({
        "id": job.profile_id,
        "explain_strategy": "brief",
        "voice": "af_heart",
        "speed": 1.0,
        "highlight_granularity": "sentence",
    });
    let job_dir = std::path::PathBuf::from(&job.output_dir);
    let mut job_req = jobs::spawn::build_job_request(
        &job.book_path,
        &job_dir.to_string_lossy(),
        &profile_obj,
        &book_models,
    );
    if let Some(bid) = &job.batch_id {
        job_req["batch_id"] = serde_json::json!(bid);
    }
    job_req["source_language"] = serde_json::json!(job.source_language);
    job_req["target_language"] = serde_json::json!(job.target_language);
    let req_path = job_dir.join("job_request.json");
    let _ = std::fs::write(&req_path, serde_json::to_string_pretty(&job_req).unwrap());
    {
        let mut q = state.queue.lock().unwrap();
        q.push(id.clone());
    }
    {
        let mut j = job.clone();
        j.status = "queued".into();
        j.stage = "retry_failed".into();
        j.error = None; // 重试清除旧错误 (否则 UI 残留历史 os error 3)
        j.progress = 0.0;
        j.updated_at = now_ms();
        repo.upsert(&j)?;
    }
    let _ = pump_queue(app.clone(), cfg.inner(), state.inner(), db.inner());
    Ok(())
}

#[tauri::command]
pub fn cancel_prep_job(state: State<PrepState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *guard = None;
    *state.running_job.lock().unwrap() = None;
    Ok(())
}

/// R3: 暂停任务 (运行中 → kill 子进程, checkpoint 保留; 排队 → 移出队列)
#[tauri::command]
pub fn job_pause(
    app: tauri::AppHandle,
    state: State<PrepState>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
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

/// R3: 继续任务 (paused → queued, 重新入队; checkpoint 续跑)
#[tauri::command]
pub fn job_resume(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
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
    let _ = pump_queue(app.clone(), cfg.inner(), state.inner(), db.inner());
    Ok(())
}

/// R3: 全部暂停 (运行中 + 排队中)
#[tauri::command]
pub fn pause_all(
    app: tauri::AppHandle,
    state: State<PrepState>,
    db: State<store::Db>,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let ids: Vec<String> = repo
        .list()
        .into_iter()
        .filter(|j| j.status == "running" || j.status == "queued")
        .map(|j| j.id)
        .collect();
    for id in ids {
        let _ = job_pause(app.clone(), state.clone(), db.clone(), id);
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    Ok(())
}

/// R3: 全部继续
#[tauri::command]
pub fn resume_all(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
) -> Result<(), String> {
    use tauri::Emitter;
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let ids: Vec<String> = repo
        .list()
        .into_iter()
        .filter(|j| j.status == "paused")
        .map(|j| j.id)
        .collect();
    for id in ids {
        let _ = job_resume(app.clone(), state.clone(), cfg.clone(), db.clone(), id);
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
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
    let job = repo.get(&job_id).ok_or("任务不存在")?;
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
        let book_id = crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id);
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
    let (child, mut lines) = match jobs::spawn::spawn_prep(&cfg.prep_path, &req_path, &job_dir) {
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
    let orig_book_id2 =
        crate::commands::library::book_id_from_path(&job.book_path, &job.profile_id);
    let job_llm_id2 = String::new(); // 模型 id 快照后续从 job_request 读 (保持简单: 存路径为空则 None)
    let job_tts_id2 = String::new();
    let app_state = app2.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let mut failed_count: i64 = 0;
        while let Some(line) = lines.next() {
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
                        j.error = quality_summary(&j.output_dir)
                            .or_else(|| Some("任务失败 (无详情报告)".into()));
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
                        // v7 架构分离: 原版书标 done (产物独立为 product)
                        let orig_id =
                            crate::commands::library::book_id_from_path(&book_path2, &profile_id);
                        crate::application::library_service::mark_original_done(
                            db.inner(),
                            &orig_id,
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
            serde_json::json!({"jobId": job_id, "type": "stage_progress", "stage": stage, "current": current, "total": total, "ts": ts})
        }
        E::StageDone {
            stage,
            current,
            total,
            ts,
        } => {
            serde_json::json!({"jobId": job_id, "type": "stage_done", "stage": stage, "current": current, "total": total, "ts": ts})
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

/// I-C: 从 quality_report.json 生成失败摘要 (失败句数 + 涉及阶段 + 前 3 条原因)
fn quality_summary(out_dir: &str) -> Option<String> {
    let path = std::path::Path::new(out_dir).join("quality_report.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    // I-C: 阶段级错误优先 (pack 超时/完整性校验等, 不是句级失败)
    if let Some(err) = v
        .get("error")
        .and_then(|e| e.as_str())
        .filter(|e| !e.is_empty())
    {
        return Some(err.to_string());
    }
    let failed_sents = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let stages = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|arr| {
            let mut set: Vec<String> = Vec::new();
            for f in arr {
                if let Some(ss) = f.get("stages").and_then(|s| s.as_array()) {
                    for s in ss {
                        if let Some(name) = s.as_str() {
                            if !set.contains(&name.to_string()) {
                                set.push(name.to_string());
                            }
                        }
                    }
                }
            }
            set
        })
        .unwrap_or_default();
    let reasons: Vec<String> = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| f.get("reason").and_then(|r| r.as_str()).map(String::from))
                .filter(|r| !r.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let reason_sample = reasons
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    if failed_sents == 0 && stages.is_empty() {
        return Some("任务失败 (bookpack 未生成)".into());
    }
    Some(format!(
        "{} 句有失败阶段 ({}){}",
        failed_sents,
        stages.join(", "),
        if reason_sample.is_empty() {
            String::new()
        } else {
            format!(": {reason_sample}")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::{overall_progress, quality_summary};

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
        let s = quality_summary(dir.to_str().unwrap()).unwrap();
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
        assert!(quality_summary(dir.to_str().unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
