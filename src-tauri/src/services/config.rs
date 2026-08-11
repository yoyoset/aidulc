//! services/config.rs —— config.toml 便携配置
//!
//! J0 (2026-08-11): 默认数据根目录从 exe 同目录迁到用户数据目录 (Windows `%APPDATA%/aidulc/`),
//! 避免开发构建把书库 (jobs_out) 和数据库 (data.db) 落在 target/ 下被 `cargo clean` 全删。
//! exe 同目录只在**便携模式** (portable.txt 标记或 AIDULC_PORTABLE=1) 下作为显式选项使用。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 用户数据根目录: Windows `%APPDATA%/aidulc`, 其他平台 `$HOME/.aidulc`。
/// 探测失败时退回当前目录 (极端环境, 至少可写)。
pub fn user_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.is_empty() {
                return PathBuf::from(appdata).join("aidulc");
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".aidulc");
        }
    }
    PathBuf::from("aidulc-data")
}

/// 便携模式判定: `AIDULC_PORTABLE=1` 环境变量或 exe 同目录存在 `portable.txt` 标记。
/// 便携模式 = 数据明确要跟着 exe 走 (U 盘/绿色版), 与"开发构建把数据落在 target"区分开。
pub fn is_portable(exe_dir: &Path) -> bool {
    if let Ok(v) = std::env::var("AIDULC_PORTABLE") {
        if v == "1" {
            return true;
        }
    }
    exe_dir.join("portable.txt").exists()
}

/// J0 (2026-08-11): 迁移判定 —— 旧位置 (exe_dir 锚定) 有数据、新位置 (用户数据目录) 空,
/// 则本次会话沿用旧路径并提示迁移 (静默换目录 = 用户以为书丢了)。
/// 返回 `Some((旧 out_dir, 旧 db))` 表示需要迁移; `None` = 不用迁。
pub fn detect_migration(
    exe_dir: &Path,
    data_dir: &Path,
    old_out_dir: &Path,
    old_db: &Path,
) -> Option<(PathBuf, PathBuf)> {
    let legacy_out = exe_dir.join(old_out_dir);
    let legacy_db = exe_dir.join(old_db);
    let new_out = data_dir.join(old_out_dir);
    let new_db = data_dir.join(old_db);
    let legacy_has = legacy_db.exists()
        || (legacy_out.is_dir()
            && legacy_out
                .read_dir()
                .map(|it| it.count() > 0)
                .unwrap_or(false))
        || exe_dir.join("config.toml").exists();
    let new_has = new_db.exists()
        || (new_out.is_dir() && new_out.read_dir().map(|it| it.count() > 0).unwrap_or(false));
    if legacy_has && !new_has {
        Some((legacy_out, legacy_db))
    } else {
        None
    }
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;
    use std::fs;

    /// 所有改 env 的测试共用一个锁: 防止并行跑 (即便门禁用 --test-threads=1,
    /// 单独跑某个模块也可能被其它模块的 env 测试干扰)。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aidulc_dd_{}_{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_legacy_data_and_returns_old_paths() {
        let exe = tmp("exe");
        let data = tmp("data");
        fs::create_dir_all(exe.join("jobs_out")).unwrap();
        fs::write(exe.join("jobs_out").join("book1"), b"x").unwrap();
        let got = detect_migration(&exe, &data, Path::new("jobs_out"), Path::new("data.db"));
        assert!(got.is_some());
        let (o, d) = got.unwrap();
        assert_eq!(o, exe.join("jobs_out"));
        assert_eq!(d, exe.join("data.db"));
        let _ = fs::remove_dir_all(&exe);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn no_migration_when_new_location_has_data() {
        let exe = tmp("exe2");
        let data = tmp("data2");
        fs::create_dir_all(exe.join("jobs_out")).unwrap();
        fs::write(exe.join("jobs_out").join("b"), b"x").unwrap();
        fs::create_dir_all(data.join("jobs_out")).unwrap();
        fs::write(data.join("jobs_out").join("b"), b"x").unwrap();
        assert!(
            detect_migration(&exe, &data, Path::new("jobs_out"), Path::new("data.db")).is_none()
        );
        let _ = fs::remove_dir_all(&exe);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn no_migration_when_legacy_empty() {
        let exe = tmp("exe3");
        let data = tmp("data3");
        assert!(
            detect_migration(&exe, &data, Path::new("jobs_out"), Path::new("data.db")).is_none()
        );
        let _ = fs::remove_dir_all(&exe);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn portable_env_flag() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("AIDULC_PORTABLE", "1");
        let d = std::env::temp_dir().join(format!("aidulc_dd_portable_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        assert!(is_portable(&d));
        std::env::remove_var("AIDULC_PORTABLE");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn portable_marker_file() {
        let _g = ENV_LOCK.lock().unwrap();
        let d = std::env::temp_dir().join(format!("aidulc_dd_marker_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("portable.txt"), b"").unwrap();
        std::env::remove_var("AIDULC_PORTABLE");
        assert!(is_portable(&d));
        let _ = fs::remove_dir_all(&d);
    }
}

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
    /// K3 (2026-08-11): 在线 AI 引擎 (OpenAI 兼容 endpoint + 模型名; API key 存
    /// Credential Manager 不落明文)。作为离线查词的兜底, 不是替代。
    pub online_endpoint: String,
    pub online_model: String,
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
            online_endpoint: String::new(),
            online_model: String::new(),
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
