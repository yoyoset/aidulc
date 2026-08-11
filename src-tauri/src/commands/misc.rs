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
    Ok(serde_json::json!({
        "llm_model": llm,
        "tts_model": tts,
        "ffmpeg": cfg.ffmpeg.to_string_lossy(),
        // M7 R8 (2026-08-08): 首次下载模型的目标目录 —— 尚未有任何模型时用数据根 models/
        // J0 (2026-08-11): 数据根随用户数据目录走, 不再锚定 exe_dir (target 会被 cargo clean 删)
        "default_model_dir": paths.inner().data_dir.join("models").to_string_lossy(),
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

/// 书库位置"更改..."(P1: 用户明确要求的产品能力)
///
/// 流程: 原生文件夹选择对话框 → 自动搬迁旧目录下的全部内容(见
/// infrastructure::dir_migration, 单条失败不中断整体) → 写回 config.toml 持久化。
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

    let report =
        crate::infrastructure::dir_migration::migrate_directory_contents(&old_dir, &new_dir)?;

    // J0: 配置文件随数据根走 (便携=exe_dir, 否则用户数据目录), 不再固定 exe 同目录
    let cfg_dir = paths.inner().data_dir.clone();
    let mut file_cfg = crate::services::config::Config::load(&cfg_dir);
    file_cfg.out_dir = new_dir.clone();
    file_cfg.save(&cfg_dir)?;

    Ok(serde_json::json!({
        "cancelled": false,
        "old_dir": old_dir.to_string_lossy(),
        "new_dir": new_dir.to_string_lossy(),
        "moved": report.moved,
        "failed": report.failed.iter()
            .map(|(name, reason)| serde_json::json!({ "name": name, "reason": reason }))
            .collect::<Vec<_>>(),
        "all_ok": report.all_ok(),
        "restart_required": true,
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
    use super::find_prep_venv_python;

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
}
