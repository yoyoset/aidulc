//! commands/models.rs —— 模型管理命令 (H2/H4)
//! 薄层: 参数转换 → application::model_service

use crate::application::model_service;
use crate::store;
use tauri::State;

/// J4 (2026-08-11): 自定义模型 —— 把用户粘的 HF 链接规范成 resolve 直链 + 给出文件名。
/// blob 页面链接自动转 resolve; 转不了明确报错让用户贴直链 (不静默失败)。
/// 返回 { ok, url, file, family_hint } (family_hint 按扩展名猜, 前端可改)。
#[tauri::command]
pub fn models_hf_normalize(raw: String) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: models_hf_normalize");
    let url = crate::infrastructure::downloader::normalize_hf_url(&raw)?;
    let (repo, _rev, file) = crate::infrastructure::downloader::hf_url_parts(&url)?;
    let file_lower = file.to_lowercase();
    let family_hint = if file_lower.ends_with(".gguf") || file_lower.ends_with(".safetensors") {
        "llm"
    } else if file_lower.ends_with(".pth") || file_lower.ends_with(".onnx") {
        "tts"
    } else {
        "llm"
    };
    Ok(serde_json::json!({
        "ok": true,
        "url": url,
        "file": file,
        "repo": repo,
        "family_hint": family_hint,
    }))
}

/// 已安装模型列表
#[tauri::command]
pub fn models_list(db: State<store::Db>) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: models_list");
    let t0 = crate::store::now_ms_for_store();
    let repo = store::model_repo::ModelRepo::new(db.inner());
    // 2026-08-10 死锁修复: 曾在此手动 lock conn 后调 repo.list_all() (内部再锁同一
    // Mutex, std Mutex 不可重入 → 主线程永久卡死, 点设置"模型中心"tab 必假死)。
    // 改走 repo.list_all_with_bound() —— 锁在 repo 内部自管, 命令层不再碰 conn。
    let rows = repo.list_all_with_bound();
    let mut out = Vec::new();
    for (model, bound) in rows {
        let mut value = serde_json::to_value(&model).map_err(|e| e.to_string())?;
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "asset_status".into(),
                serde_json::json!(if bound > 0 {
                    "bound"
                } else if model.active {
                    "recommended"
                } else {
                    "registered"
                }),
            );
            object.insert("bound_count".into(), serde_json::json!(bound));
        }
        out.push(value);
    }
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "exit: models_list {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    Ok(serde_json::Value::Array(out))
}

/// 某语言某家族的模型 (供书级选择)
#[tauri::command]
pub fn models_by(
    db: State<store::Db>,
    family: String,
    language: String,
) -> Result<serde_json::Value, String> {
    let repo = store::model_repo::ModelRepo::new(db.inner());
    serde_json::to_value(repo.list_by(&family, &language)).map_err(|e| e.to_string())
}

/// 推荐组合 (导入书时自动带出)
#[tauri::command]
pub fn models_recommend(
    db: State<store::Db>,
    language: String,
) -> Result<serde_json::Value, String> {
    let (llm, tts, nlp) = model_service::recommend_bundle(db.inner(), &language);
    Ok(serde_json::json!({
        "llm": llm.map(|m| serde_json::to_value(&m).unwrap_or_default()),
        "tts": tts.map(|m| serde_json::to_value(&m).unwrap_or_default()),
        "nlp": nlp.map(|m| serde_json::to_value(&m).unwrap_or_default()),
    }))
}

/// 登记一个模型 (复用扫描后 / 下载后)
#[tauri::command]
pub fn models_register(
    db: State<store::Db>,
    family: String,
    language: String,
    model_id: String,
    version: String,
    variant: String,
    path: String,
    source_type: String,
    source_ref: String,
    sha256: String,
    size_bytes: i64,
    custom: bool,
) -> Result<String, String> {
    let id = model_service::entry_id(&family, &language, &model_id, &version);
    let mut e = store::model_repo::ModelEntry {
        id: id.clone(),
        family,
        language,
        model_id,
        version,
        variant,
        path,
        source_type,
        source_ref,
        commit_sha: String::new(),
        sha256,
        size_bytes,
        installed_at: crate::commands::library::now_ms(),
        active: false,
        custom,
    };
    model_service::register(db.inner(), &mut e)?;
    Ok(id)
}

/// 设置推荐
#[tauri::command]
pub fn models_set_recommended(db: State<store::Db>, id: String) -> Result<(), String> {
    model_service::set_recommended(db.inner(), &id)
}

/// M4-3③ (2026-08-12): 存量误登记改家族 (移除旧 id, 按新家族重建; active 保持)。
#[tauri::command]
pub fn models_set_family(db: State<store::Db>, id: String, family: String) -> Result<(), String> {
    model_service::set_family(db.inner(), &id, &family)
}

/// 移除
#[tauri::command]
pub fn models_remove(db: State<store::Db>, id: String) -> Result<(), String> {
    model_service::remove(db.inner(), &id)
}

/// 扫描模型目录 → 可复用候选
#[tauri::command]
pub fn models_scan(db: State<store::Db>, model_dir: String) -> Result<serde_json::Value, String> {
    let suggestions = model_service::scan_and_suggest(db.inner(), &model_dir);
    Ok(serde_json::json!(suggestions))
}

/// D (2026-08-11): 探测磁盘上是否已存在某模型文件 (大小校验复用 components::check_file
/// 的思路: present = 是文件, healthy = size >= min_bytes)。
/// 模型中心据此显示三态: 已登记 / 磁盘已有·点此登记 / 下载 —— 此前判据只看注册表,
/// 文件在磁盘但没登记照样显示「下载」, 点了重下 GB 级文件。
#[tauri::command]
pub fn model_file_check(path: String, min_bytes: i64) -> Result<serde_json::Value, String> {
    let s = crate::services::components::check_file(
        &path,
        "model-file",
        "model-file",
        min_bytes.max(0) as u64,
    );
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// 书级绑定
#[tauri::command]
pub fn models_bind_book(
    db: State<store::Db>,
    book_id: String,
    source_language: String,
    target_language: String,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
) -> Result<(), String> {
    model_service::bind_book(
        db.inner(),
        &book_id,
        &source_language,
        &target_language,
        llm_id,
        tts_id,
        nlp_id,
    )
}

/// 读书级绑定 (书设置弹窗回显用)
#[tauri::command]
pub fn models_book_binding(
    db: State<store::Db>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    Ok(model_service::book_binding(db.inner(), &book_id))
}

/// 下载模型 (阻塞式, 大文件在前端分步调用; 首次实现同步下载)
#[tauri::command]
pub fn models_download(
    url: String,
    dest: String,
    sha256: Option<String>,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    // M7 R8/R12/R20: 后台线程下载不冻结 UI; 进度经 AtomicU64 共享; 防重复 + 清理已完成任务。
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    {
        let mut reg = downloads_registry().lock().unwrap();
        // 清理完成超过 1 小时的任务 (内存不泄漏)
        let cutoff = (crate::commands::library::now_ms() - 3_600_000) as u64;
        reg.retain(|_, j| !(j.done && j.done_at.load(Ordering::Relaxed) < cutoff));
        // 防重复: 同一 dest 已在下载 → 复用 token (两个线程写同一 .part 会损坏)
        if let Some((token, _)) = reg.iter().find(|(_, j)| !j.done && j.dest == dest) {
            return Ok(
                serde_json::json!({ "token": token.clone(), "started": true, "reused": true }),
            );
        }
    }
    let token = format!("dl-{}", crate::commands::library::now_ms());
    let bytes_read = Arc::new(AtomicU64::new(0));
    let total = Arc::new(AtomicU64::new(0));
    let done_at = Arc::new(AtomicU64::new(0));
    downloads_registry().lock().unwrap().insert(
        token.clone(),
        DownloadJob {
            done: false,
            ok: false,
            path: String::new(),
            error: String::new(),
            dest: dest.clone(),
            done_at: done_at.clone(),
            bytes_read: bytes_read.clone(),
            total: total.clone(),
        },
    );
    let token2 = token.clone();
    std::thread::spawn(move || {
        let br = bytes_read.clone();
        let tl = total.clone();
        let br2 = br.clone();
        let tl2 = tl.clone();
        let r = crate::infrastructure::downloader::download_with_progress(
            &url,
            std::path::PathBuf::from(&dest),
            sha256.as_deref(),
            timeout_secs,
            move |read, tot| {
                br2.store(read, Ordering::Relaxed);
                if tot > 0 {
                    tl2.store(tot, Ordering::Relaxed);
                }
            },
        );
        let job = match r {
            Ok(p) => DownloadJob {
                done: true,
                ok: true,
                path: p.to_string_lossy().to_string(),
                error: String::new(),
                dest,
                done_at: done_at.clone(),
                bytes_read: br,
                total: tl,
            },
            Err(e) => DownloadJob {
                done: true,
                ok: false,
                path: String::new(),
                error: e,
                dest,
                done_at: done_at.clone(),
                bytes_read: br,
                total: tl,
            },
        };
        job.done_at
            .store(crate::commands::library::now_ms() as u64, Ordering::Relaxed);
        downloads_registry().lock().unwrap().insert(token2, job);
    });
    Ok(serde_json::json!({ "token": token, "started": true }))
}

#[derive(Clone)]
struct DownloadJob {
    done: bool,
    ok: bool,
    path: String,
    error: String,
    dest: String,
    done_at: std::sync::Arc<std::sync::atomic::AtomicU64>,
    bytes_read: std::sync::Arc<std::sync::atomic::AtomicU64>,
    total: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

fn downloads_registry() -> &'static std::sync::Mutex<std::collections::HashMap<String, DownloadJob>>
{
    static REG: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, DownloadJob>>,
    > = std::sync::OnceLock::new();
    REG.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 下载状态 (前端轮询): 下载中返回 bytes_read/total, 完成返回 ok/path/error
#[tauri::command]
pub fn models_download_status(token: String) -> Result<serde_json::Value, String> {
    use std::sync::atomic::Ordering;
    let map = downloads_registry();
    let m = map.lock().unwrap();
    let job = m.get(&token).ok_or("下载任务不存在")?.clone();
    Ok(serde_json::json!({
        "done": job.done, "ok": job.ok, "path": job.path, "error": job.error,
        "bytes_read": job.bytes_read.load(Ordering::Relaxed),
        "total": job.total.load(Ordering::Relaxed),
    }))
}

/// 硬件检测 (向导第 2 步)
#[tauri::command]
pub fn hardware_detect(model_dir: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "gpu": crate::infrastructure::downloader::has_nvidia_gpu(),
        "disk_free_bytes": crate::infrastructure::downloader::disk_free_bytes(&model_dir),
    }))
}

// ---- 首次运行向导 (H3) ----

/// 向导状态
#[tauri::command]
pub fn wizard_state(db: State<store::Db>) -> Result<serde_json::Value, String> {
    let (step, status) = crate::application::wizard_service::get_state(db.inner());
    Ok(
        serde_json::json!({"step": step, "status": status, "total": crate::application::wizard_service::TOTAL_STEPS}),
    )
}

/// 提交向导步骤
#[tauri::command]
pub fn wizard_submit(db: State<store::Db>, step: i64, status: String) -> Result<(), String> {
    crate::application::wizard_service::set_step(db.inner(), step, &status)
}

/// 向导完成
#[tauri::command]
pub fn wizard_finish(db: State<store::Db>) -> Result<(), String> {
    crate::application::wizard_service::set_step(
        db.inner(),
        crate::application::wizard_service::TOTAL_STEPS,
        "done",
    )
}
