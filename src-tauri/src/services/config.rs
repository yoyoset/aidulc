//! services/config.rs —— config.toml 便携配置 (exe 同目录)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub library_dir: PathBuf,
    pub model_dir: PathBuf,
    pub log_level: String,
    /// CF 同步 (可为空 = 离线模式)
    pub cf_worker_url: String,
    pub cf_namespace: String,
    /// 工具路径 (M 系列: 模型路径已归 model_registry, 此处只留 ffmpeg)
    pub ffmpeg_path: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            library_dir: PathBuf::from("library"),
            model_dir: PathBuf::from("models"),
            log_level: "info".into(),
            cf_worker_url: String::new(),
            cf_namespace: String::new(),
            ffmpeg_path: PathBuf::new(),
        }
    }
}

impl Config {
    /// 读 exe 同目录 config.toml; 不存在则写默认。
    pub fn load(exe_dir: &std::path::Path) -> Self {
        let path = exe_dir.join("config.toml");
        if path.exists() {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(cfg) = toml::from_str(&text) {
                    return cfg;
                }
            }
        }
        let cfg = Config::default();
        let _ = std::fs::write(&path, toml::to_string_pretty(&cfg).unwrap_or_default());
        cfg
    }
}
