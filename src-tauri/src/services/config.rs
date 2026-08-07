//! services/config.rs —— config.toml 便携配置 (exe 同目录)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 书包/任务输出根目录("书库位置")。曾经这里叫 library_dir 但和真正存书的
    /// PrepConfig.out_dir 是两个不同步的概念(2026-08-07 审计发现的架构债: 全项目
    /// 没有一本书真正存在旧 library_dir 下面, 它只是两处遗留兜底逻辑的路径来源)。
    /// 现在统一成一个: 这里的值就是 out_dir 的配置来源, main.rs 用同一套
    /// resolve_out_dir 解析成绝对路径。
    pub out_dir: PathBuf,
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
            out_dir: PathBuf::from("jobs_out"),
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

    /// 写回 exe 同目录 config.toml(书库位置设置页"更改..."用)。
    pub fn save(&self, exe_dir: &std::path::Path) -> Result<(), String> {
        let path = exe_dir.join("config.toml");
        let text = toml::to_string_pretty(self).map_err(|e| format!("序列化配置失败: {e}"))?;
        std::fs::write(&path, text).map_err(|e| format!("写 config.toml 失败: {e}"))
    }
}
