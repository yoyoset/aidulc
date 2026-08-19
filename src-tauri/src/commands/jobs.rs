//! commands/jobs.rs —— 备料任务命令 (G4: 从 main.rs 拆分; S2.1: 业务编排进一步拆到
//! application/job_orchestrator.rs, 这里只做 State<T> → &T 转发, 不含业务决策)
//! 依赖 app 状态 (PrepState/PrepConfig), 通过 State 注入。

use crate::application::job_orchestrator as orch;
use crate::{store, PrepConfig, PrepState};
use tauri::State;

/// 启动单本任务 (G2: 支持 batch_id/多语言)
// 参数个数镜像 application::job_orchestrator::start_prep_job(那边的警告不压, 是真实债务),
// 这里纯转发, 参数结构必须和它一致才对——只在薄壳这一层压掉重复噪音, 不代表问题解决了。
#[allow(clippy::too_many_arguments)]
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
    orch::start_prep_job(
        app,
        state.inner(),
        cfg.inner(),
        db.inner(),
        book_path,
        profile,
        models,
        batch_id,
        source_language,
        target_language,
    )
}

/// 导入批次 (R1: 只登记书+批次, 不开始处理)
/// 返回 { batch_id, registered[], skipped[] }。用户稍后在书库点"创建译本" → batch_start_prep。
/// needs_standardize (Option): 体检 block 的路径子集, 登记成 pending 后台兑底转换;
/// 用 Option 是为了兼容旧前端 (job_service.js 不传该键), 不传 = 没有需要转换的书。
// 参数个数镜像 application::job_orchestrator::batch_import (那边的警告不压, 是真实债务),
// 这里纯转发, 参数结构必须和它一致才对 —— 只在薄壳这一层压掉重复噪音。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn batch_import(
    app: tauri::AppHandle,
    cfg: State<crate::PrepConfig>,
    state: State<crate::application::standardize_task::StandardizeState>,
    db: State<store::Db>,
    book_paths: Vec<String>,
    needs_standardize: Option<Vec<String>>,
    profile: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<serde_json::Value, String> {
    orch::batch_import(
        app,
        cfg.inner(),
        state.inner(),
        db.inner(),
        book_paths,
        needs_standardize.unwrap_or_default(),
        profile,
        source_language,
        target_language,
    )
}

/// 开始阅读准备 (R1/R2: 前置检查 → 通过的书入队; 未通过的书标原因)
/// book_ids: 前端从书库选中的待处理书 (属于该批次)。
/// 返回: { batch_id, enqueued: [book_id], skipped: [{book_id, reasons}] }
// 同上: 镜像 orchestrator 的参数, 只在这层压噪音, 那边的警告仍计入 clippy 基线。
#[allow(clippy::too_many_arguments)]
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
    orch::batch_start_prep(
        app,
        state.inner(),
        cfg.inner(),
        db.inner(),
        batch_id,
        book_ids,
        profile,
        models,
    )
}

/// 批量任务 (兼容旧前端; 语义改为: 导入 + 立即开始 — 但新前端走 batch_import + batch_start_prep)
// 同上: 镜像 orchestrator 的参数, 只在这层压噪音, 那边的警告仍计入 clippy 基线。
#[allow(clippy::too_many_arguments)]
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
    orch::batch_start(
        app,
        state.inner(),
        cfg.inner(),
        db.inner(),
        book_paths,
        profile,
        models,
        source_language,
        target_language,
    )
}

#[tauri::command]
pub fn batch_list(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let repo = store::batches_repo::BatchesRepo::new(db.inner());
    serde_json::to_value(repo.list()).map_err(|e| e.to_string())
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
    serde_json::to_value(repo.list()).map_err(|e| e.to_string())
}

/// 移除任务 (UX 审计 2026-08-09: 修复"移除成功但任务还在跑/队列卡死")
/// - 移除的是运行中任务 → 先杀子进程, 否则侧车继续烧 GPU、写孤儿产物, 用户以为已取消;
/// - 同时从内存队列清除该 id, 否则 pump_queue 弹出已删 id 会报错并停摆后续排队任务
///   (曾出现"移除排队任务 → 后续书全部卡住且无任何提示")。
/// - 2026-08-09 无限成长修复: 任务目录不再被任何 edition 引用时顺带删除 (checkpoint/TTS/
///   run.log 累积是磁盘最大漏)。成功产出书的任务其目录 = edition.pack_dir, 不能删 ——
///   书还在书库里。只有失败/排队/取消等无产物的任务目录在此清理。
#[tauri::command]
pub fn job_remove(state: State<PrepState>, db: State<store::Db>, id: String) -> Result<(), String> {
    // Bug fix (2026-08-13): 原来 holding running_job 再锁 child (嵌套), 与 job_pause/
    // cancel_prep_job 的 child→running_job 顺序相反 → ABBA 死锁隐患。改成两把锁绝不嵌套:
    // 先判是否在跑, 再单独锁 child 杀进程, 再单独锁 running_job 清空。
    let is_running = state.running_job.lock().unwrap().as_deref() == Some(&id);
    if is_running {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
        drop(guard);
        *state.running_job.lock().unwrap() = None;
    }
    {
        let mut q = state.queue.lock().unwrap();
        q.retain(|x| x != &id);
    }
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let job = repo.get(&id);
    repo.remove(&id)?;
    if let Some(job) = job {
        let dir = std::path::Path::new(&job.output_dir);
        if !dir.as_os_str().is_empty()
            && store::editions_repo::EditionsRepo::new(db.inner())
                .find_by_pack_dir(&job.output_dir)
                .is_none()
        {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

/// M7 R24/R26 (2026-08-08): 任务详情 —— 失败时给用户看"为什么失败"。
/// 读输出目录的 quality_report.json (侧车异常路径也写, 含 error 摘要/阶段统计/失败句);
/// run.log 尾部作为补充 (M7 R26 起侧车真正写 run.log)。
#[tauri::command]
pub fn job_detail(db: State<store::Db>, id: String) -> Result<serde_json::Value, String> {
    let repo = store::jobs_repo::JobsRepo::new(db.inner());
    let job = repo.get(&id).ok_or("任务不存在")?;
    let dir = std::path::Path::new(&job.output_dir);
    let mut out = serde_json::json!({});
    let qr_path = dir.join("quality_report.json");
    if let Ok(text) = std::fs::read_to_string(&qr_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            out["quality_report"] = v;
        }
    }
    // run.log 尾部 (最多 60 行)
    if let Ok(text) = std::fs::read_to_string(dir.join("run.log")) {
        let lines: Vec<&str> = text.lines().collect();
        let tail: Vec<&str> = if lines.len() > 60 {
            lines[lines.len() - 60..].to_vec()
        } else {
            lines.clone()
        };
        out["run_log_tail"] = serde_json::json!(tail.join("\n"));
    }
    if out.is_null() || out.get("quality_report").is_none() {
        if let Some(e) = &job.error {
            out["error"] = serde_json::json!(e);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn job_retry_failed(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    orch::job_retry_failed(app, state.inner(), cfg.inner(), db.inner(), id)
}

/// 自定义重跑 (2026-08-13): 手动重选模型 + 指定重跑范围。
// 薄壳镜像 orchestrator 的参数 (那边已 allow, 这里只压重复噪音), 计数与 orchestrator 一致。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn job_retry_custom(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    id: String,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
    force_stages: Option<Vec<String>>,
    profile_id: Option<String>,
) -> Result<(), String> {
    orch::job_retry_custom(
        app,
        state.inner(),
        cfg.inner(),
        db.inner(),
        id,
        llm_id,
        tts_id,
        nlp_id,
        force_stages,
        profile_id,
    )
}

/// K14 (2026-08-14): 之前只杀进程清内存态, 从不写 DB——任务永远卡在"running"
/// 状态、没有任何 UI 能看出它已经不在跑了。改走 orch::job_cancel: 落 failed +
/// error="用户取消"(复用现有的历史列表/重跑 UI, 跟"暂停"(落 paused, 可继续)
/// 是不同的终态)。
#[tauri::command]
pub fn cancel_prep_job(
    app: tauri::AppHandle,
    state: State<PrepState>,
    cfg: State<PrepConfig>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    orch::job_cancel(app, cfg.inner(), state.inner(), db.inner(), id)
}

/// R3: 暂停任务 (运行中 → kill 子进程, checkpoint 保留; 排队 → 移出队列)
#[tauri::command]
pub fn job_pause(
    app: tauri::AppHandle,
    state: State<PrepState>,
    db: State<store::Db>,
    id: String,
) -> Result<(), String> {
    orch::job_pause(app, state.inner(), db.inner(), id)
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
    orch::job_resume(app, state.inner(), cfg.inner(), db.inner(), id)
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
        let _ = orch::job_pause(app.clone(), state.inner(), db.inner(), id);
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
        let _ = orch::job_resume(app.clone(), state.inner(), cfg.inner(), db.inner(), id);
    }
    let _ = app.emit("job-list-changed", serde_json::json!({}));
    Ok(())
}
