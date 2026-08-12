//! services/components.rs —— 组件/模型状态检查 (G5: 轻量外壳 + 按需组件)
//!
//! 职责:
//! - 检查 prep/ffmpeg/模型是否存在、是否可用
//! - 扫描已有模型池 (AIDU/comic-gen/subgen 缓存复用)
//! - 首次运行健康检查报告
//!
//! 下载/校验/回滚是 M5 后续 (需要 manifest 端点), 这里先建立检查与报告基础。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComponentStatus {
    pub id: String, // prep | ffmpeg | llm | tts | spacy
    pub name: String,
    pub present: bool, // 文件/目录存在
    pub healthy: bool, // 通过基本校验
    pub detail: String,
    pub size_bytes: i64,
    /// J3 (2026-08-11): 当前版本 (探测得出, 探测不到给空串)
    pub version: String,
    /// J3: 更新渠道 —— "内置" / "重新构建侧车" / "无更新渠道"。没有渠道的项要老实说,
    /// 不放一个点了没反应的按钮 (假反馈)。
    pub update_channel: String,
}

/// 检查单文件组件
pub fn check_file(path: &str, id: &str, name: &str, min_bytes: u64) -> ComponentStatus {
    let md = std::fs::metadata(path);
    match md {
        Ok(m) if m.is_file() => {
            let size = m.len();
            ComponentStatus {
                id: id.into(),
                name: name.into(),
                present: true,
                healthy: size >= min_bytes,
                detail: if size >= min_bytes {
                    format!("OK ({:.1} MB)", size as f64 / 1e6)
                } else {
                    format!("文件过小: {size} bytes (期望 >= {min_bytes})")
                },
                size_bytes: size as i64,
                version: String::new(),
                update_channel: no_channel_for(id),
            }
        }
        Ok(_) => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: true,
            healthy: false,
            detail: "存在但不是文件".into(),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for(id),
        },
        Err(_) => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: false,
            healthy: false,
            detail: format!("缺失 (预期位置: {path})"),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for(id),
        },
    }
}

/// J3: 每个依赖的更新渠道 —— 没有的项老实写"无更新渠道" (不给点了没反应的假按钮)。
fn no_channel_for(id: &str) -> String {
    match id {
        "prep" => "重新构建侧车".to_string(),
        "ffmpeg" => "无更新渠道".to_string(),
        "pymupdf" => "一键安装".to_string(),
        _ => "无更新渠道".to_string(),
    }
}

/// 检查目录组件 (UX5 修正 2026-08-13: 原 TTS 用 check_dir 只查文件, 不查 config/voices,
/// 已被 check_tts 取代; 保留作通用单文件存在检查)
#[allow(dead_code)]
pub fn check_dir(path: &str, id: &str, name: &str, required_file: &str) -> ComponentStatus {
    let full = std::path::Path::new(path).join(required_file);
    let md = std::fs::metadata(&full);
    match md {
        Ok(m) if m.is_file() => {
            let size = m.len();
            ComponentStatus {
                id: id.into(),
                name: name.into(),
                present: true,
                healthy: true,
                detail: format!("OK ({required_file}, {:.1} MB)", size as f64 / 1e6),
                size_bytes: size as i64,
                version: String::new(),
                update_channel: no_channel_for(id),
            }
        }
        _ => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: false,
            healthy: false,
            detail: format!("缺少 {required_file}"),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for(id),
        },
    }
}

/// PyMuPDF 探测的读超时 (S0, 2026-08-10): 侧车冷启动慢/管道未关时 5 秒即判超时,
/// 否则 `read_to_string` 无超时读到 EOF 会把主线程永久阻塞 (设置页点开即假死的根因)。
/// 参照 models_download 的动态超时思路 (F4): 探测是低价值调用, 超时返回"探测超时"远好于卡死。
pub const PYMUPDF_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 带超时读子进程 stdout 到 EOF (S0 通用探测壳)。
/// 超时 → kill 子进程 → Err("探测超时"), 保证调用方在 timeout 内必返回。
/// 测试可注入"永不输出也不退出的假进程"来验证超时路径 (不依赖真实侧车)。
pub fn read_stdout_with_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take();
    std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(mut s) = stdout {
            let _ = s.read_to_string(&mut out);
        }
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(out) => {
            let _ = child.wait();
            Ok(out)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("探测超时".into())
        }
    }
}

/// 检查 Python 侧车里的 PyMuPDF (文档解析器) 是否可用。
/// 通过调侧车 CLI 探测: `aidulc-prep.exe --pymupdf-version` 输出版本号 → 可用。
/// 缺失时返回 present=false + 安装指引 (prep/pyproject.toml 的 doc extra)。
/// S0 (2026-08-10): 读 stdout 带 5 秒超时 (PYMUPDF_PROBE_TIMEOUT), 不再无界阻塞。
pub fn check_pymupdf(prep_path: &std::path::Path) -> ComponentStatus {
    let detail_base = "文档解析器 (PyMuPDF, 用于 pdf/mobi/azw3/fb2 兜底解析)".to_string();
    if !prep_path.exists() {
        return ComponentStatus {
            id: "pymupdf".into(),
            name: "文档解析器 (PyMuPDF)".into(),
            present: false,
            healthy: false,
            detail: format!("{detail_base} — prep 侧车不存在, 无法探测"),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for("pymupdf"),
        };
    }
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(prep_path);
    cmd.arg("--pymupdf-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let Ok(child) = cmd.spawn() else {
        return ComponentStatus {
            id: "pymupdf".into(),
            name: "文档解析器 (PyMuPDF)".into(),
            present: false,
            healthy: false,
            detail: format!("{detail_base} — 探测命令无法启动"),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for("pymupdf"),
        };
    };
    let out = match read_stdout_with_timeout(child, PYMUPDF_PROBE_TIMEOUT) {
        Ok(out) => out,
        Err(e) => {
            return ComponentStatus {
                id: "pymupdf".into(),
                name: "文档解析器 (PyMuPDF)".into(),
                present: false,
                healthy: false,
                detail: format!("{detail_base} — {e} (侧车无响应, 已终止探测)"),
                size_bytes: 0,
                version: String::new(),
                update_channel: no_channel_for("pymupdf"),
            };
        }
    };
    let version = out.trim();
    let ok = !version.is_empty() && version != "none";
    ComponentStatus {
        id: "pymupdf".into(),
        name: "文档解析器 (PyMuPDF)".into(),
        present: ok,
        healthy: ok,
        detail: if ok {
            format!("OK (PyMuPDF {version})")
        } else {
            format!("{detail_base} — 未安装, 一键安装或 pip install 'pymupdf' (prep 的 doc extra)")
        },
        size_bytes: 0,
        version: version.to_string(),
        update_channel: no_channel_for("pymupdf"),
    }
}

/// 全组件健康检查 (首次运行向导用)
/// M 系列: llm/tts 路径由调用方从 model_registry 解析后传入 (不再读 PrepConfig)
pub fn health_check(
    cfg: &crate::PrepConfig,
    lib_dir: &str,
    hf_home: &str,
    llm_path: &str,
    tts_path: &str,
) -> Vec<ComponentStatus> {
    let mut out = Vec::new();
    out.push(check_file(
        &cfg.prep_path.to_string_lossy(),
        "prep",
        "prep 侧车",
        1_000_000,
    ));
    if !cfg.ffmpeg.as_os_str().is_empty() {
        out.push(check_file(
            &cfg.ffmpeg.to_string_lossy(),
            "ffmpeg",
            "ffmpeg",
            1_000_000,
        ));
    }
    out.push(check_file(llm_path, "llm", "LLM 模型", 500_000_000));
    out.push(check_tts(tts_path));
    out.push(check_pymupdf(&cfg.prep_path));
    let _ = lib_dir;
    let _ = hf_home;
    out
}

/// UX5 修正 (2026-08-13): TTS 完整性健康检查 —— Kokoro 需要 模型文件+config.json+voices/ 同目录。
/// 此前只查 kokoro-v1_0.pth, 平铺的不完整模型 (如只拷了 .pth 没有 voices) 会误报 OK,
/// 任务跑到 TTS 阶段才炸 (用户实测: manga-ocr 被扫成 tts 当推荐, voices 不存在)。
fn check_tts(tts_path: &str) -> ComponentStatus {
    let dir = std::path::Path::new(tts_path)
        .parent()
        .unwrap_or(std::path::Path::new(""))
        .to_path_buf();
    let model_file = dir.join("kokoro-v1_0.pth");
    let config = dir.join("config.json");
    let voices = dir.join("voices");
    let missing: Vec<&str> = [
        (!model_file.is_file(), "kokoro-v1_0.pth"),
        (!config.is_file(), "config.json"),
        (!voices.is_dir(), "voices/"),
    ]
    .into_iter()
    .filter(|(miss, _)| *miss)
    .map(|(_, n)| n)
    .collect();
    if missing.is_empty() {
        ComponentStatus {
            id: "tts".into(),
            name: "TTS 模型".into(),
            present: true,
            healthy: true,
            detail: "OK (Kokoro: kokoro-v1_0.pth + config.json + voices/)".into(),
            size_bytes: std::fs::metadata(&model_file)
                .map(|m| m.len() as i64)
                .unwrap_or(0),
            version: String::new(),
            update_channel: no_channel_for("tts"),
        }
    } else {
        ComponentStatus {
            id: "tts".into(),
            name: "TTS 模型".into(),
            present: false,
            healthy: false,
            detail: format!(
                "Kokoro 不完整: 缺 {} (需要 模型+config.json+voices/ 同目录)",
                missing.join("、")
            ),
            size_bytes: 0,
            version: String::new(),
            update_channel: no_channel_for("tts"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_reported() {
        let s = check_file("C:/nonexistent/xyz.gguf", "llm", "LLM", 1);
        assert!(!s.present);
        assert!(!s.healthy);
    }

    #[test]
    fn small_file_unhealthy() {
        let p = std::env::temp_dir().join("aidulc_small_test.bin");
        std::fs::write(&p, b"tiny").unwrap();
        let s = check_file(&p.to_string_lossy(), "ffmpeg", "ffmpeg", 1000);
        assert!(s.present);
        assert!(!s.healthy, "小于 min_bytes 应不健康");
        std::fs::remove_file(&p).unwrap();
    }

    #[test]
    fn large_enough_file_healthy() {
        let p = std::env::temp_dir().join("aidulc_ok_test.bin");
        std::fs::write(&p, vec![0u8; 2000]).unwrap();
        let s = check_file(&p.to_string_lossy(), "ffmpeg", "ffmpeg", 1000);
        assert!(s.healthy);
        std::fs::remove_file(&p).unwrap();
    }

    /// S0 (2026-08-10): 探测超时路径 —— 注入"永不输出也不退出"的假进程 (cmd + ping
    /// 输出重定向到 nul, 连跑 30 秒), 断言 read_stdout_with_timeout 在超时内返回 Err
    /// 而非无限阻塞。不依赖真实侧车。
    #[test]
    fn probe_times_out_on_silent_process() {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let child = cmd.spawn().expect("spawn 假进程");
        let timeout = std::time::Duration::from_secs(1);
        let started = std::time::Instant::now();
        let r = read_stdout_with_timeout(child, timeout);
        let elapsed = started.elapsed();
        assert!(
            r.is_err(),
            "永不输出的假进程应判超时, 却返回 Ok: {r:?} (elapsed={elapsed:?})"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "应在超时后尽快返回, 实测 elapsed={elapsed:?}"
        );
        assert!(r.unwrap_err().contains("探测超时"));
    }

    /// J3 (2026-08-11): 每个依赖的更新渠道 —— 没有渠道的老实写"无更新渠道" (不放假按钮)
    #[test]
    fn update_channel_honest_or_actionable() {
        assert_eq!(no_channel_for("prep"), "重新构建侧车");
        assert_eq!(no_channel_for("pymupdf"), "一键安装");
        assert_eq!(no_channel_for("ffmpeg"), "无更新渠道");
        assert_eq!(no_channel_for("llm"), "无更新渠道");
        // 组件状态带 version/update_channel 字段 (前端"当前版本 · 状态 · 检查更新")
        let s = check_file("C:/nonexistent/x.gguf", "llm", "LLM", 1);
        assert!(!s.healthy);
        assert_eq!(s.update_channel, "无更新渠道");
    }
}
