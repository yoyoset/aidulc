//! commands/misc.rs —— 杂项命令 (M 系列: 从 main.rs 移出, main 只做组装)
//! runtime_config / components_health / boot_ping / log_* / library_dir_*

use crate::{PrepConfig, PrepState};
use tauri::State;

fn current_exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default()
}

/// 运行时配置 (模型/工具路径) — 前端 ImportService 组装 job 参数用
/// M 系列: 模型路径从 model_registry 推荐解析 (单一真相源)
#[tauri::command]
pub fn runtime_config(
    cfg: State<PrepConfig>,
    db: State<crate::store::Db>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    Ok(serde_json::json!({
        "llm_model": llm,
        "tts_model": tts,
        "ffmpeg": cfg.ffmpeg.to_string_lossy(),
    }))
}

/// G5: 组件健康检查 (首次运行向导/组件中心)
/// M 系列: 模型从 model_registry 解析 (单一真相源), 不再读 PrepConfig 第二份状态
/// 2026-08-07: 磁盘空间检查此前查的是 library_dir 所在盘, 但书实际写入 out_dir——
/// 如果两者不在同一块盘, 健康检查结果是误导性的。合并成一个概念后这个问题自动消失。
#[tauri::command]
pub fn components_health(
    cfg: State<PrepConfig>,
    db: State<crate::store::Db>,
) -> Result<serde_json::Value, String> {
    use crate::application::model_service;
    let hf = std::env::var("HF_HOME").unwrap_or_default();
    // en 是当前唯一支持语言 (H4); 多语言后按书语言查询
    let (llm, tts, _spacy) = model_service::resolve_paths(db.inner(), "en");
    let out_dir = cfg.out_dir.to_string_lossy().to_string();
    let checks = crate::services::components::health_check(cfg.inner(), &out_dir, &hf, &llm, &tts);
    serde_json::to_value(checks).map_err(|e| e.to_string())
}

/// 书库位置(当前生效的绝对路径, 供设置页展示)
#[tauri::command]
pub fn library_dir_get(cfg: State<PrepConfig>) -> String {
    cfg.out_dir.to_string_lossy().to_string()
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

    let exe_dir = current_exe_dir();
    let mut file_cfg = crate::services::config::Config::load(&exe_dir);
    file_cfg.out_dir = new_dir.clone();
    file_cfg.save(&exe_dir)?;

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
