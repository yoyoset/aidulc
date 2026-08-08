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
            }
        }
        Ok(_) => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: true,
            healthy: false,
            detail: "存在但不是文件".into(),
            size_bytes: 0,
        },
        Err(_) => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: false,
            healthy: false,
            detail: format!("缺失 (预期位置: {path})"),
            size_bytes: 0,
        },
    }
}

/// 检查目录组件
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
            }
        }
        _ => ComponentStatus {
            id: id.into(),
            name: name.into(),
            present: false,
            healthy: false,
            detail: format!("缺少 {required_file}"),
            size_bytes: 0,
        },
    }
}

/// 检查 Python 侧车里的 PyMuPDF (文档解析器) 是否可用。
/// 通过调侧车 CLI 探测: `aidulc-prep.exe --pymupdf-version` 输出版本号 → 可用。
/// 缺失时返回 present=false + 安装指引 (prep/pyproject.toml 的 doc extra)。
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
        };
    }
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(prep_path);
    cmd.arg("--pymupdf-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let Ok(mut child) = cmd.spawn() else {
        return ComponentStatus {
            id: "pymupdf".into(),
            name: "文档解析器 (PyMuPDF)".into(),
            present: false,
            healthy: false,
            detail: format!("{detail_base} — 探测命令无法启动"),
            size_bytes: 0,
        };
    };
    let mut out = String::new();
    let _ = child.stdout.take().map(|mut s| s.read_to_string(&mut out));
    let _ = child.wait();
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
    out.push(check_dir(
        std::path::Path::new(tts_path)
            .parent()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .as_ref(),
        "tts",
        "TTS 模型",
        "kokoro-v1_0.pth",
    ));
    out.push(check_pymupdf(&cfg.prep_path));
    let _ = lib_dir;
    let _ = hf_home;
    out
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
}
