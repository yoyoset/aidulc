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

    #[test]
    fn l8_online_permission_flags_default_off() {
        // L8 (2026-08-11): 在线引擎两档授权开关默认全关 —— 查词/整本都默认不允许外发。
        let c = Config::default();
        assert!(!c.online_lookup_enabled, "查词在线默认必须关");
        assert!(!c.online_whole_book_enabled, "整本在线默认必须关");
        // 序列化往返不丢字段 (serde(default) 保护旧 config.toml 读入)
        let json = serde_json::to_string(&c).unwrap();
        let c2: Config = serde_json::from_str(&json).unwrap();
        assert!(!c2.online_lookup_enabled);
        assert!(!c2.online_whole_book_enabled);
        // 旧 config.toml 没有这两个字段 (default) → 读入后仍为 false
        let old_toml = "out_dir = 'jobs_out'\n";
        let c3: Config = toml::from_str(old_toml).unwrap();
        assert!(!c3.online_lookup_enabled);
        assert!(!c3.online_whole_book_enabled);
    }

    #[test]
    fn l11_backends_include_active_once() {
        // L11 (2026-08-11): 当前生效 URL 保证在后端列表里 (老用户只有 cf_worker_url)。
        let mut c = Config {
            cf_worker_url: "https://a.workers.dev".into(),
            sync_backends: Vec::new(),
            ..Default::default()
        };
        let (list, changed) = c.backends_including_active();
        assert!(changed, "首次读列表应补默认项");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "默认后端");
        assert_eq!(list[0].url, "https://a.workers.dev");
        // 幂等: 第二次不再补
        let (list2, changed2) = c.backends_including_active();
        assert!(!changed2);
        assert_eq!(list2.len(), 1);
        // 已有同 URL 后端时不重复补 (即便名字不同)
        c.sync_backends.push(SyncBackend::new(
            "家里".into(),
            "https://a.workers.dev".into(),
        ));
        let (list3, changed3) = c.backends_including_active();
        assert!(!changed3);
        assert_eq!(list3.len(), 2, "不重复补, 列表仍是原有 2 项");
        // URL 为空 → 不动 (不补默认项)
        c.cf_worker_url = String::new();
        let (list4, changed4) = c.backends_including_active();
        assert!(!changed4);
        assert_eq!(list4.len(), 2, "URL 为空不新增, 原列表保留");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBackend {
    pub name: String,
    pub url: String,
}

impl SyncBackend {
    pub fn new(name: String, url: String) -> Self {
        Self { name, url }
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
    /// L11 (2026-08-11): 多后端列表 —— 每个 = 名称 + Worker URL。`cf_worker_url` 是当前
    /// 生效的那个 (列表里高亮)。切换 = 改 cf_worker_url; sync_state.endpoint_key 已按
    /// worker_url + 服务端 user 分账, 切过去不匹配就全量重推 (天然支持, 不新造机制)。
    #[serde(default)]
    pub sync_backends: Vec<SyncBackend>,
    /// K3 (2026-08-11): 在线 AI 引擎 (OpenAI 兼容 endpoint + 模型名; API key 存
    /// Credential Manager 不落明文)。作为离线查词的兜底, 不是替代。
    pub online_endpoint: String,
    pub online_model: String,
    /// L8 (2026-08-11): 三档授权的两档开关, **默认全关**。① 查词失败时可用在线 AI
    /// (发 1 词 + 1 句, ~200 字符); ② 整本翻译/讲解可用在线引擎 (发全书正文,
    /// **默认关**, 开启时 UI 必须明确告知外发量)。K3 的"绝不自动回退/绝不代理转发/
    /// 每次外发可见发什么"三条不随开关改变。
    #[serde(default)]
    pub online_lookup_enabled: bool,
    #[serde(default)]
    pub online_whole_book_enabled: bool,
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
            sync_backends: Vec::new(),
            online_endpoint: String::new(),
            online_model: String::new(),
            online_lookup_enabled: false,
            online_whole_book_enabled: false,
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

    /// L11 (2026-08-11): 保证当前生效的 worker_url 在后端列表里 —— 老用户只有
    /// cf_worker_url 没有列表, 首次读列表时把它登记为「默认后端」, 列表才不为空。
    /// 返回 (列表, 是否补了默认项)。
    pub fn backends_including_active(&mut self) -> (Vec<SyncBackend>, bool) {
        if !self.cf_worker_url.is_empty()
            && !self
                .sync_backends
                .iter()
                .any(|b| b.url == self.cf_worker_url)
        {
            self.sync_backends.push(SyncBackend::new(
                "默认后端".into(),
                self.cf_worker_url.clone(),
            ));
            return (self.sync_backends.clone(), true);
        }
        (self.sync_backends.clone(), false)
    }
}
