//! commands/misc.rs —— 杂项命令 (M 系列: 从 main.rs 移出, main 只做组装)
//! runtime_config / components_health / boot_ping / log_* / library_dir_*

use crate::{PrepConfig, PrepState};
use tauri::State;

/// 运行时配置 (模型/工具路径) — 前端 ImportService 组装 job 参数用
/// M 系列: 模型路径从 model_registry 推荐解析 (单一真相源)
#[tauri::command]
pub fn runtime_config(
    cfg: State<PrepConfig>,
    db: State<crate::store::Db>,
    paths: State<crate::DataPaths>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    // M4-3① (2026-08-12): HF 缓存目录 —— 扫描路径的默认项之一。优先 HF_HOME 环境变量,
    // 否则 ~/.cache/huggingface (Windows 同用 USERPROFILE/HOME)。
    let hf_cache = std::env::var("HF_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            std::path::Path::new(&home)
                .join(".cache")
                .join("huggingface")
                .to_string_lossy()
                .to_string()
        });
    Ok(serde_json::json!({
        "llm_model": llm,
        "tts_model": tts,
        "ffmpeg": cfg.ffmpeg.to_string_lossy(),
        // M7 R8 (2026-08-08): 首次下载模型的目标目录 —— 尚未有任何模型时用数据根 models/
        // J0 (2026-08-11): 数据根随用户数据目录走, 不再锚定 exe_dir (target 会被 cargo clean 删)
        "default_model_dir": paths.inner().data_dir.join("models").to_string_lossy(),
        "hf_cache_dir": hf_cache,
    }))
}

/// G5: 组件健康检查 (首次运行向导/组件中心)
/// M 系列: 模型从 model_registry 解析 (单一真相源), 不再读 PrepConfig 第二份状态
/// 2026-08-07: 磁盘空间检查此前查的是 library_dir 所在盘, 但书实际写入 out_dir——
/// 如果两者不在同一块盘, 健康检查结果是误导性的。合并成一个概念后这个问题自动消失。
/// S0 (2026-08-10): 改 async + spawn_blocking —— 探测 prep 侧车(spawn 子进程读 stdout)
/// 是阻塞 I/O, 同步命令跑在主线程会把整个窗口卡死 (点设置必假死的根因)。探测本身
/// 还有 5 秒超时兜底 (components::PYMUPDF_PROBE_TIMEOUT), 双重保障主线程永不阻塞。
#[tauri::command]
pub async fn components_health(
    cfg: State<'_, PrepConfig>,
    db: State<'_, crate::store::Db>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let hf = std::env::var("HF_HOME").unwrap_or_default();
    // en 是当前唯一支持语言 (H4); 多语言后按书语言查询
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    let out_dir = cfg.out_dir.to_string_lossy().to_string();
    let cfg = cfg.inner().clone();
    crate::infrastructure::log::info("cmd", "enter: components_health (async)");
    let checks = tauri::async_runtime::spawn_blocking(move || {
        crate::services::components::health_check(&cfg, &out_dir, &hf, &llm, &tts)
    })
    .await
    .map_err(|e| format!("健康检查执行失败: {e}"))?;
    crate::infrastructure::log::info("cmd", "exit: components_health");
    serde_json::to_value(checks).map_err(|e| e.to_string())
}

/// 书库位置(当前生效的绝对路径, 供设置页展示)
#[tauri::command]
pub fn library_dir_get(cfg: State<PrepConfig>) -> String {
    crate::infrastructure::log::info("cmd", "enter: library_dir_get");
    cfg.out_dir.to_string_lossy().to_string()
}

/// J0 (2026-08-11): 数据目录现状 —— 前端据此展示完整路径 + 迁移提示。
#[tauri::command]
pub fn data_migration_status(
    paths: State<crate::DataPaths>,
    cfg: State<PrepConfig>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: data_migration_status");
    let p = paths.inner();
    Ok(serde_json::json!({
        "portable": p.portable,
        "data_dir": p.data_dir.to_string_lossy(),
        "db_path": p.db_path.to_string_lossy(),
        "out_dir": cfg.out_dir.to_string_lossy(),
        "pending": p.migration.is_some(),
    }))
}

/// J0: dry-run —— 迁移将影响多少项 (复制前先给数字, 用户确认后才执行)。
#[tauri::command]
pub fn data_migration_dry_run(paths: State<crate::DataPaths>) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: data_migration_dry_run");
    let p = paths.inner();
    let Some(plan) = p.migration.as_ref() else {
        return Ok(serde_json::json!({ "pending": false }));
    };
    let d = crate::infrastructure::data_migration::dry_run(plan);
    Ok(serde_json::json!({
        "pending": true,
        "legacy_out": plan.legacy_out.to_string_lossy(),
        "target_out": plan.target_out.to_string_lossy(),
        "legacy_db": plan.legacy_db.to_string_lossy(),
        "target_db": plan.target_db.to_string_lossy(),
        "dry": d,
    }))
}

/// J0: 执行迁移 —— 备份 → 复制 → 校验 → 写标记; 返回后前端提示重启。
/// 数据安全: 执行前自动备份 (export_aidu_data), 复制后校验, 旧文件留给下次启动清理。
#[tauri::command]
pub fn data_migration_run(
    db: State<'_, crate::store::Db>,
    paths: State<'_, crate::DataPaths>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: data_migration_run");
    let p = paths.inner();
    let Some(plan) = p.migration.clone() else {
        return Err("没有待迁移的数据".into());
    };
    let report = crate::infrastructure::data_migration::run_migration(db.inner(), &plan)?;
    crate::infrastructure::log::info("cmd", "exit: data_migration_run (需重启)");
    Ok(serde_json::json!({
        "ok": true,
        "restart_required": true,
        "backup_path": report.backup_path,
        "out_moved": report.out_moved,
        "target_out": report.target_out,
        "target_db": report.target_db,
    }))
}

// ---- K3 (2026-08-11): 在线 AI 引擎配置 (OpenAI 兼容; key 存 Credential Manager) ----

/// 读在线引擎配置 (endpoint + model; key 只报是否已配置, 不回明文)
#[tauri::command]
pub fn online_config_get(paths: State<crate::DataPaths>) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_get");
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    let key_configured = crate::services::credentials::get_online_key()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "endpoint": cfg.online_endpoint,
        "model": cfg.online_model,
        "key_configured": key_configured,
        "lookup_enabled": cfg.online_lookup_enabled,
        "whole_book_enabled": cfg.online_whole_book_enabled,
    }))
}

/// 写在线引擎配置 (endpoint + model; key 可选, 传入则存 Credential Manager)
/// L8: 两档授权开关独立保存, 默认关; 只有端点+key 齐了才允许开。
#[tauri::command]
pub fn online_config_set(
    paths: State<crate::DataPaths>,
    endpoint: String,
    model: String,
    api_key: Option<String>,
    lookup_enabled: Option<bool>,
    whole_book_enabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_set");
    let cfg_dir = paths.inner().data_dir.clone();
    let mut cfg = crate::services::config::Config::load(&cfg_dir);
    cfg.online_endpoint = endpoint;
    cfg.online_model = model;
    if let Some(b) = lookup_enabled {
        cfg.online_lookup_enabled = b;
    }
    if let Some(b) = whole_book_enabled {
        cfg.online_whole_book_enabled = b;
    }
    cfg.save(&cfg_dir)?;
    if let Some(k) = api_key {
        if !k.is_empty() {
            crate::services::credentials::save_online_key(&k)?;
        }
    }
    let key_configured = crate::services::credentials::get_online_key()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "saved": true,
        "key_configured": key_configured,
        "lookup_enabled": cfg.online_lookup_enabled,
        "whole_book_enabled": cfg.online_whole_book_enabled,
    }))
}

/// 在线引擎连通性测试 (最小请求, 确认 endpoint+key+model 可用)
#[tauri::command]
pub fn online_config_test(
    paths: State<crate::DataPaths>,
    endpoint: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", "enter: online_config_test");
    let cfg_dir = paths.inner().data_dir.clone();
    let cfg = crate::services::config::Config::load(&cfg_dir);
    let ep = endpoint.unwrap_or(cfg.online_endpoint.clone());
    let md = model.unwrap_or(cfg.online_model.clone());
    let key = match api_key {
        Some(k) if !k.is_empty() => k,
        _ => crate::services::credentials::get_online_key().unwrap_or_default(),
    };
    crate::infrastructure::online_client::test_connection(&ep, &key, &md)
}

/// 书库位置"更改..."(L7, 2026-08-11 重定义)
///
/// **切换书库位置不移动、不删除任何文件** —— 只改配置 + 重启后按新位置读取。
/// 旧的"选新目录后自动搬迁文件"行为已按 L7 安全边界移除: 用户要的绿色版场景是
/// "整个库目录拷到另一台机器, 选中即用", 自动搬迁反而危险 (中途断掉会两边各缺一半)。
/// 真要搬文件, 走 L1 那套带校验和清单的迁移流程 (data_migration), 不是这里。
///
/// **重启后生效, 不是热切换**: PrepConfig 是 Tauri 启动时一次性 `.manage()` 的不可变
/// 状态, 让 out_dir 运行时可变需要把它包进 Mutex 并改遍所有读取点(job_orchestrator/
/// library/misc 等几十处直接字段访问), 风险和收益不成比例——"改完需要重启"是常见软件
/// 的标准做法, 不是偷懒抄近路, 这里显式在返回值里带 restart_required 让前端明确提示用户。
///
/// 任务处理中不允许改(参照 subgen"处理任务进行中不能改模型目录"的既有纪律,
/// 避免正在写入的文件路径突然变化)。
#[tauri::command]
pub fn library_dir_pick_and_set(
    cfg: State<PrepConfig>,
    prep_state: State<PrepState>,
    paths: State<crate::DataPaths>,
) -> Result<serde_json::Value, String> {
    if prep_state.running_job.lock().unwrap().is_some() {
        return Err("有任务正在处理中, 请先等待完成或暂停后再更改书库位置".into());
    }

    let picked = rfd::FileDialog::new()
        .set_title("选择书库位置")
        .pick_folder();
    let new_dir = match picked {
        Some(p) => p,
        None => return Ok(serde_json::json!({ "cancelled": true })),
    };

    let old_dir = cfg.out_dir.clone();
    if new_dir == old_dir {
        return Ok(serde_json::json!({ "cancelled": true, "same": true }));
    }

    // L7: 只改配置, 不移动任何文件 (安全边界: 切换书库位置不移动、不删除)。
    // J0: 配置文件随数据根走 (便携=exe_dir, 否则用户数据目录), 不再固定 exe 同目录
    let cfg_dir = paths.inner().data_dir.clone();
    let mut file_cfg = crate::services::config::Config::load(&cfg_dir);
    file_cfg.out_dir = new_dir.clone();
    file_cfg.save(&cfg_dir)?;

    Ok(serde_json::json!({
        "cancelled": false,
        "old_dir": old_dir.to_string_lossy(),
        "new_dir": new_dir.to_string_lossy(),
        "moved": Vec::<String>::new(),
        "failed": Vec::<String>::new(),
        "all_ok": true,
        "restart_required": true,
    }))
}

/// L7 (2026-08-11): 仅打开文件夹选择对话框返回路径 (加载已有书库用) —— 不改配置。
#[tauri::command]
pub fn library_dir_pick() -> Result<serde_json::Value, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择书库目录")
        .pick_folder();
    match picked {
        Some(p) => Ok(serde_json::json!({ "cancelled": false, "path": p.to_string_lossy() })),
        None => Ok(serde_json::json!({ "cancelled": true })),
    }
}

/// L7 (2026-08-11): 扫描一个目录, 找出可导入的成品书包 (含 bookpack.json 的子目录),
/// 与 DB 比对后返回「可导入 N 本 / 已存在 M 本」。**不复制不移动文件, 只登记路径**。
#[tauri::command]
pub fn library_dir_scan(
    db: State<crate::store::Db>,
    dir: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: library_dir_scan {dir}"));
    let root = std::path::Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let (importable, existing) = scan_packs_for_import(db.inner(), root);
    crate::infrastructure::log::info(
        "cmd",
        &format!(
            "library_dir_scan 结果: 可导入 {} 本, 已存在 {} 本",
            importable.len(),
            existing.len()
        ),
    );
    Ok(serde_json::json!({
        "dir": dir,
        "importable": importable,
        "existing": existing,
    }))
}

/// L7: 扫描逻辑抽成纯函数 (可单测): 找含 bookpack.json 的目录, 从 bookpack 读 title/
/// profile 推导 id, 与 DB 的 editions 比对。返回 (可导入, 已存在)。
fn scan_packs_for_import(
    db: &crate::store::Db,
    root: &std::path::Path,
) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let editions = crate::store::editions_repo::EditionsRepo::new(db);
    let mut importable = Vec::new();
    let mut existing = Vec::new();
    // 扫描一层子目录 (每本书成品一个目录); 再深一层 (jobs/job-xxx) 也找
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                dirs.push(p.clone());
                // jobs/job-* 两层
                if let Ok(sub) = std::fs::read_dir(&p) {
                    for se in sub.flatten() {
                        let sp = se.path();
                        if sp.is_dir() {
                            dirs.push(sp);
                        }
                    }
                }
            }
        }
    }
    for p in dirs {
        let bp = p.join("bookpack.json");
        if !bp.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&bp) else {
            continue;
        };
        let Ok(v): Result<serde_json::Value, _> = serde_json::from_str(&text) else {
            continue;
        };
        let title = v
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let profile_id = v
            .get("profile")
            .and_then(|pr| pr.get("id"))
            .and_then(|i| i.as_str())
            .unwrap_or("default")
            .to_string();
        let id = crate::commands::library::book_id_from_path(&p.to_string_lossy(), &profile_id);
        let entry = serde_json::json!({
            "id": id,
            "title": title,
            "profile_id": profile_id,
            "pack_dir": p.to_string_lossy(),
        });
        if editions.get(&id).is_some() {
            existing.push(entry);
        } else {
            importable.push(entry);
        }
    }
    (importable, existing)
}

/// L7 (2026-08-11): 把扫描到的成品书包登记进书库 —— **只登记 DB, 不复制不移动文件**。
/// 复用 register_book 的幂等登记 (读 bookpack.json → 建 book + edition)。
#[tauri::command]
pub fn library_dir_import(
    db: State<crate::store::Db>,
    packs: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info(
        "cmd",
        &format!("enter: library_dir_import {} 本", packs.len()),
    );
    let mut imported = 0usize;
    let mut failed = Vec::new();
    for p in packs {
        let id = p
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        let pack_dir = p
            .get("pack_dir")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let profile_id = p
            .get("profile_id")
            .and_then(|i| i.as_str())
            .unwrap_or("default")
            .to_string();
        if id.is_empty() || pack_dir.is_empty() {
            failed.push(serde_json::json!({ "id": id, "reason": "缺 id 或 pack_dir" }));
            continue;
        }
        // source_path 不可知 (外部库没有原书), 登记时留空; 书卡显示来源=外部库目录
        let r = crate::application::library_service::register_book(
            db.inner(),
            id.clone(),
            &pack_dir,
            String::new(),
            format!("synthetic-source-{id}"),
            profile_id,
            "en".into(),
            "zh-CN".into(),
            None,
            None,
            None,
        );
        match r {
            Some(()) => imported += 1,
            None => failed
                .push(serde_json::json!({ "id": id, "reason": "登记失败 (无 bookpack.json?)" })),
        }
    }
    Ok(serde_json::json!({
        "imported": imported,
        "failed": failed,
    }))
}

/// boot 探针 (开发用: 验证进程活着)
#[tauri::command]
pub fn boot_ping(message: String) -> String {
    let path = std::env::temp_dir().join("aidulc_boot_ping.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(f, "boot_ping: {}", message);
    }
    format!("pong: {}", message)
}

/// R3.4 (2026-08-08): 一键安装文档解析器 (PyMuPDF)。
///
/// 往 prep 侧车所在 venv 里 pip install pymupdf (开发环境侧车从 venv 跑); 若
/// 侧车是打包产物 (便携/发布, 没有 venv), 返回明确指引"重新构建侧车", 不假装装好了。
///
/// S0 (2026-08-10): 改 async + spawn_blocking —— pip 是分钟级阻塞 I/O, 同步命令会
/// 卡死主线程; 顺带把读 stdout/stderr 加 120 秒超时兜底 (装依赖正常远超 5 秒, 不能用
/// 探测级短超时; 120 秒只挡"pip 卡死"这种极端情况)。
#[tauri::command]
pub async fn doc_parser_install(cfg: State<'_, PrepConfig>) -> Result<serde_json::Value, String> {
    let prep_path = cfg.prep_path.clone();
    let r = tauri::async_runtime::spawn_blocking(move || install_pymupdf_blocking(&prep_path))
        .await
        .map_err(|e| format!("安装任务执行失败: {e}"))?;
    r
}

fn install_pymupdf_blocking(prep_path: &std::path::Path) -> Result<serde_json::Value, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    // 从侧车路径往上找 venv: .../prep/dist/aidulc-prep/aidulc-prep.exe → .../prep/.venv
    let venv_python = find_prep_venv_python(prep_path);
    let Some(python) = venv_python else {
        return Ok(serde_json::json!({
            "ok": false,
            "detail": "当前运行的是打包版侧车, 无法热装依赖。请用 scripts/build_prep.ps1 重新构建 (已把 pymupdf 加入打包清单)。",
        }));
    };

    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("pymupdf")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(|e| format!("启动 pip 失败: {e}"))?;

    // S0: 读管道也带超时 (pip 卡死时 120 秒返回失败, 而不是让 spawn_blocking 线程永远挂着)。
    // 两条管道各起一个线程读, 主线程 recv_timeout; 超时则 kill 子进程。
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tx_out = tx.clone();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stdout {
            let _ = s.read_to_string(&mut buf);
        }
        let _ = tx_out.send(buf);
    });
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });
    let mut out = String::new();
    let mut err = String::new();
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(s) => {
                if out.is_empty() {
                    out = s;
                } else {
                    err = s;
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("pip 无响应, 已终止安装 (120 秒超时)".into());
            }
        }
    }
    let status = child.wait().map_err(|e| format!("等待 pip 失败: {e}"))?;
    let ok = status.success();
    let detail = if ok {
        "PyMuPDF 已安装".to_string()
    } else {
        format!("安装失败: {}", err.trim())
    };
    Ok(serde_json::json!({ "ok": ok, "detail": detail }))
}

/// 从 prep 侧车路径定位其 venv 的 python.exe (开发环境)。
/// 侧车 `.../prep/dist/aidulc-prep/aidulc-prep.exe` → 向上 3 级 = prep/ → prep/.venv。
fn find_prep_venv_python(prep_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut dir = prep_path.parent()?.to_path_buf();
    for _ in 0..4 {
        let venv = dir.join(".venv").join("Scripts").join("python.exe");
        if venv.is_file() {
            return Some(venv);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{find_prep_venv_python, scan_packs_for_import};

    #[test]
    fn finds_venv_up_the_tree() {
        // 构造临时目录: root/prep/dist/aidulc-prep/aidulc-prep.exe + root/prep/.venv/Scripts/python.exe
        let root = std::env::temp_dir().join(format!("aidulc_venv_{}", std::process::id()));
        let exe_dir = root.join("prep").join("dist").join("aidulc-prep");
        let venv = root.join("prep").join(".venv").join("Scripts");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(exe_dir.join("aidulc-prep.exe"), b"x").unwrap();
        std::fs::write(venv.join("python.exe"), b"x").unwrap();
        let got = find_prep_venv_python(&exe_dir.join("aidulc-prep.exe"));
        assert_eq!(got, Some(venv.join("python.exe")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_venv_returns_none() {
        let root = std::env::temp_dir().join(format!("aidulc_novenv_{}", std::process::id()));
        let exe_dir = root.join("prep").join("dist").join("aidulc-prep");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join("aidulc-prep.exe"), b"x").unwrap();
        let got = find_prep_venv_python(&exe_dir.join("aidulc-prep.exe"));
        assert_eq!(got, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn l7_scan_imports_external_library_without_moving_files() {
        // L7 (2026-08-11): 加载已有书库 —— 扫描外部目录里的成品书包 → 登记到 DB。
        // 关键断言: 登记后原目录文件原封不动 (只登记路径, 不复制不移动)。
        let root = std::env::temp_dir().join(format!("aidulc_l7_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 外部库: 一本成品 (jobs/job-xxx/bookpack.json)
        let ext = root.join("external_library");
        let pack = ext.join("jobs").join("job-12345-1");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::write(
            pack.join("bookpack.json"),
            r#"{"schemaVersion":1,"title":"Alice in Wonderland","profile":{"id":"default","name":"成人自读"},"chapters":[],"quality":{},"generatedAt":1}"#,
        )
        .unwrap();
        let marker = pack.join("marker.txt");
        std::fs::write(&marker, b"do-not-move").unwrap();

        let db_path = root.join("t.db");
        let db = crate::store::Db::open(db_path.to_str().unwrap()).unwrap();
        // 扫描: 外部目录下应发现 1 本可导入
        let (importable, existing) = scan_packs_for_import(&db, &ext);
        assert_eq!(importable.len(), 1, "应发现 1 本可导入");
        assert_eq!(existing.len(), 0);
        // 登记 (走 library_dir_import 的同一 register_book 路径)
        let imported = crate::application::library_service::register_book(
            &db,
            importable[0]["id"].as_str().unwrap().to_string(),
            importable[0]["pack_dir"].as_str().unwrap(),
            String::new(),
            format!("synthetic-source-{}", importable[0]["id"].as_str().unwrap()),
            "default".into(),
            "en".into(),
            "zh-CN".into(),
            None,
            None,
            None,
        );
        assert!(imported.is_some(), "登记应成功");
        // 关键: 原目录文件一个没动
        assert!(marker.exists(), "登记不能移动/删除原文件");
        assert!(pack.join("bookpack.json").exists());
        // 再次扫描 → 现在归入"已存在"
        let (imp2, ex2) = scan_packs_for_import(&db, &ext);
        assert_eq!(imp2.len(), 0, "登记后不再重复可导入");
        assert_eq!(ex2.len(), 1, "已登记的书归入 existing");
        let _ = std::fs::remove_dir_all(&root);
    }
}
