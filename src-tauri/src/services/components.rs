//! services/components.rs —— 组件/模型状态检查 (G5: 轻量外壳 + 按需组件)
//!
//! 职责:
//! - 检查 prep/ffmpeg/模型是否存在、是否可用
//! - 扫描已有模型池 (AIDU/comic-gen/subgen 缓存复用)
//! - 首次运行健康检查报告
//! 下载/校验/回滚是 M5 后续 (需要 manifest 端点), 这里先建立检查与报告基础。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComponentStatus {
    pub id: String,          // prep | ffmpeg | llm | tts | spacy
    pub name: String,
    pub present: bool,       // 文件/目录存在
    pub healthy: bool,       // 通过基本校验
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

/// 全组件健康检查 (首次运行向导用)
/// M 系列: llm/tts 路径由调用方从 model_registry 解析后传入 (不再读 PrepConfig)
pub fn health_check(cfg: &crate::PrepConfig, lib_dir: &str, hf_home: &str, llm_path: &str, tts_path: &str) -> Vec<ComponentStatus> {
    let mut out = Vec::new();
    out.push(check_file(
        &cfg.prep_path.to_string_lossy(),
        "prep", "prep 侧车", 1_000_000,
    ));
    if !cfg.ffmpeg.as_os_str().is_empty() {
        out.push(check_file(&cfg.ffmpeg.to_string_lossy(), "ffmpeg", "ffmpeg", 1_000_000));
    }
    out.push(check_file(llm_path, "llm", "LLM 模型", 500_000_000));
    out.push(check_dir(
        std::path::Path::new(tts_path).parent().unwrap_or(std::path::Path::new("")).to_string_lossy().as_ref(),
        "tts", "TTS 模型", "kokoro-v1_0.pth",
    ));
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
