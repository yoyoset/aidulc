//! commands/misc.rs —— 运行时探针命令 (M 系列)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 原文件把"运行时/健康检查"、
//! "数据根/书库位置/整根迁移"、"在线引擎配置"三个不相关域全挤在一起(命名"misc"本身
//! 就是这个问题的证据), 已拆到 commands/data_root.rs、commands/online_config.rs。
//! 这里只留真正"运行时探针": runtime_config/components_health/boot_ping/doc_parser_install。

use crate::PrepConfig;
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

/// K11 (2026-08-14): 应用本体版本号——之前模型/依赖组件都有各自的"检查更新",
/// 唯独应用本体没有任何 UI 出口显示自己是哪个版本, 报 bug 时说不清。只加版本号
/// 展示(读 Cargo.toml 编译期常量), 不做"关于"整页/许可证/在线更新检查(那是
/// 更大的一件事, 且是否要联网检查应用本体更新本身也是产品决策)。
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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

/// 2026-08-20: 打开书时探测一次显卡占用 (见 infrastructure/gpu_check.rs 顶部注释)。
/// 只读, 不改任何状态; 非 N 卡机器/没装驱动时 `available:false`, 前端应静默跳过。
#[tauri::command]
pub fn gpu_status() -> serde_json::Value {
    let s = crate::infrastructure::gpu_check::check_gpu();
    serde_json::json!({
        "available": s.available,
        "usedMb": s.used_mb,
        "totalMb": s.total_mb,
        "freeMb": s.free_mb,
        "shouldWarn": s.should_warn(),
        "foreignProcesses": s.foreign_processes.iter().map(|p| serde_json::json!({
            "pid": p.pid, "name": p.name,
        })).collect::<Vec<_>>(),
    })
}

/// 关掉一个显卡占用进程 —— 只在用户点了提示里的"关闭"按钮才会调, 这里不做二次确认
/// (确认是前端弹窗的职责, 命令层收到调用就直接执行)。
#[tauri::command]
pub fn gpu_kill_process(pid: u32) -> Result<(), String> {
    crate::infrastructure::gpu_check::kill_process(pid)
}

/// 2026-08-21 (用户: "设置里增加字典文件的选择"): 导入用户自己的词典文件, 追加进
/// 全局词典基底(不覆盖已有词条)。支持 JSONL(同 resources/dict_seed.jsonl 形状)
/// 或 CSV(表头含 word + translation/meaning/definition/释义 任一列)。
/// 2026-09-04: 加 `label` —— 每次导入记一条可命名/可单独删除的"词典源"
/// (见 dict_base_sources_list/dict_base_source_delete), 不再是只能整体统计的
/// 一个笼统 'custom' 桶。
#[tauri::command]
pub fn dict_base_import_file(
    db: State<crate::store::Db>,
    path: String,
    label: Option<String>,
) -> Result<serde_json::Value, String> {
    let stats = crate::store::dict_base_repo::DictBaseRepo::new(db.inner())
        .import_custom_file(&path, label.as_deref())?;
    serde_json::to_value(stats).map_err(|e| e.to_string())
}

/// 词典基底统计(按来源分组), 设置页展示"当前基底多少词、种子/自己积累各多少"。
#[tauri::command]
pub fn dict_base_stats(db: State<crate::store::Db>) -> Result<serde_json::Value, String> {
    let rows = crate::store::dict_base_repo::DictBaseRepo::new(db.inner()).stats()?;
    Ok(serde_json::json!(rows
        .into_iter()
        .map(|(source, count)| serde_json::json!({ "source": source, "count": count }))
        .collect::<Vec<_>>()))
}

/// 2026-09-04 (用户: "可以加多个词典"): 列出所有自定义词典源(文件名/词数/导入时间),
/// 设置页渲染"我的词典源"列表用。
#[tauri::command]
pub fn dict_base_sources_list(db: State<crate::store::Db>) -> Result<serde_json::Value, String> {
    let sources = crate::store::dict_base_repo::DictBaseRepo::new(db.inner()).list_sources()?;
    serde_json::to_value(sources).map_err(|e| e.to_string())
}

/// 删除一个自定义词典源(连同它导入的所有词条), 返回删除的词条数。
#[tauri::command]
pub fn dict_base_source_delete(
    db: State<crate::store::Db>,
    source_id: String,
) -> Result<usize, String> {
    crate::store::dict_base_repo::DictBaseRepo::new(db.inner()).delete_source(&source_id)
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
