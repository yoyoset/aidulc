#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod application {
    pub mod book_transfer_service;
    pub mod dictionary_service;
    pub mod job_orchestrator;
    pub mod library_asset_service;
    pub mod library_service;
    pub mod model_service;
    pub mod sync_service;
    pub mod transfer_service;
    pub mod wizard_service;
}
mod commands {
    pub mod jobs;
    pub mod library;
    pub mod misc;
    pub mod models;
    pub mod reader;
}
mod domain {
    pub mod bookpack;
    pub mod srs;
    pub mod sync;
    pub mod vocab;
}
mod services {
    pub mod components;
    pub mod config;
    pub mod credentials;
}
mod store {
    pub mod batches_repo;
    pub mod books_repo;
    pub mod dict_repo;
    pub mod editions_repo;
    pub mod highlights_repo;
    pub mod jobs_repo;
    pub mod model_repo;
    pub mod profile_repo;
    pub mod reading_repo;
    pub mod settings_repo;
    pub mod store_mod;
    pub mod sync_state_repo;
    pub mod users_repo;
    pub mod vocab_repo;
    pub use store_mod::{now_ms_for_store, Db};
}
mod jobs {
    pub mod job_guard;
    pub mod progress;
    pub mod spawn;
}
mod infrastructure {
    pub mod bookpack_cache;
    pub mod dict_daemon;
    pub mod dir_migration;
    pub mod downloader;
    pub mod log;
    pub mod model_store {
        pub mod scan;
    }
    pub mod sync_v1_client;
}
mod ipc {
    pub mod commands;
    pub mod registry;
}

use std::sync::Mutex;
use tauri::Manager;

/// 应用级服务 (跨命令共享; I-C: 配置可运行时更新)
pub struct AppServices {
    pub cf_worker_url: Mutex<String>,
    pub cf_token: Mutex<String>,
}

/// 备料台任务状态: 串行队列
pub struct PrepState {
    pub child: Mutex<Option<std::process::Child>>,
    pub running_job: Mutex<Option<String>>,
    pub queue: Mutex<Vec<String>>,
}

/// prep 侧车路径 + 任务输出目录 + 工具路径
/// M 系列: 模型路径不再存这里 (单一真相源 = model_registry, 运行时 resolve_paths)
pub struct PrepConfig {
    pub prep_path: std::path::PathBuf,
    pub out_dir: std::path::PathBuf,
    pub ffmpeg: std::path::PathBuf,
}

/// 解析 prep 侧车路径 (多级探测, 修复 os error 3: 开发/发布环境路径不健壮):
/// 1. 环境变量 AIDULC_PREP (显式)
/// 2. exe 同级 prep/ (便携版: dist/aidulc-portable/prep/aidulc-prep.exe)
/// 3. 开发目录: 仓库 prep/dist/aidulc-prep/ (开发期跑 target/release 或 target/debug)
/// 4. 上级目录 prep 构建 (../prep/... 兜底)
fn resolve_prep_path(exe_dir: &std::path::Path) -> std::path::PathBuf {
    // 1. 环境变量
    if let Ok(p) = std::env::var("AIDULC_PREP") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    // 2. exe 同级 prep (便携发布)
    let sibling = exe_dir.join("prep").join("aidulc-prep.exe");
    if sibling.exists() {
        return sibling;
    }
    // 3. 开发目录: exe 的上级 ../../prep/dist/aidulc-prep/
    //    (target/release/ → 仓库根 → prep/dist/aidulc-prep/aidulc-prep.exe)
    let mut cur = exe_dir.to_path_buf();
    for _ in 0..4 {
        cur.pop();
        let dev = cur
            .join("prep")
            .join("dist")
            .join("aidulc-prep")
            .join("aidulc-prep.exe");
        if dev.exists() {
            return dev;
        }
    }
    // 4. 兜底: 返回 exe 同级 (组件健康检查会明确显示"找不到", 不静默)
    sibling
}

/// 书库/输出目录路径解析("书库位置")。
///
/// Bug fix (2026-08-07 审计确认): 此前直接用 config.toml 里的裸相对路径, 没有像
/// db_path 那样 exe_dir.join(), 实际落地位置取决于进程启动时的当前工作目录(双击 exe /
/// 快捷方式 / 不同终端启动 CWD 可能不同), 不是文档声称的"exe 同目录"。
///
/// 架构合并(同日审计发现): 此前有两个不同步的"书目录"概念——`library_dir`(仅两处
/// 遗留兜底逻辑引用, 没有一本书真正存在这里)和 `PrepConfig.out_dir`(真正的书包存放
/// 位置, `cfg.out_dir.join("jobs").join(job_id)`)。用户反馈"不知道书包在哪"的真正根因
/// 是 out_dir 此前没有配置文件持久化入口(只能靠 AIDULC_OUT 环境变量), 不是 library_dir
/// 本身。现在统一成一个: Config.out_dir 是配置来源, 这个函数是唯一的解析逻辑。
///
/// env_override 存在且非空时不做任何加工(尊重用户经 AIDULC_OUT 显式指定的路径,
/// 哪怕是相对路径也不强行转换, 语义上环境变量就是"你说了算")。
fn resolve_out_dir(
    exe_dir: &std::path::Path,
    cfg_out_dir: &std::path::Path,
    env_override: Option<String>,
) -> std::path::PathBuf {
    if let Some(v) = env_override {
        if !v.is_empty() {
            return std::path::PathBuf::from(v);
        }
    }
    if cfg_out_dir.is_absolute() {
        cfg_out_dir.to_path_buf()
    } else {
        exe_dir.join(cfg_out_dir)
    }
}

#[cfg(test)]
mod out_dir_tests {
    use super::resolve_out_dir;
    use std::path::PathBuf;

    #[test]
    fn relative_config_path_anchored_to_exe_dir() {
        // 核心回归: 这是 2026-08-07 修的那个 bug——裸相对路径必须锚定 exe_dir,
        // 不能指望"当前工作目录恰好等于 exe_dir"这种运气。
        let got = resolve_out_dir(
            std::path::Path::new("C:/app"),
            std::path::Path::new("jobs_out"),
            None,
        );
        assert_eq!(got, PathBuf::from("C:/app").join("jobs_out"));
    }

    #[test]
    fn absolute_config_path_used_as_is() {
        let got = resolve_out_dir(
            std::path::Path::new("C:/app"),
            std::path::Path::new("D:/my_books"),
            None,
        );
        assert_eq!(got, PathBuf::from("D:/my_books"));
    }

    #[test]
    fn env_override_wins_and_is_not_anchored() {
        // 环境变量是用户显式指定, 哪怕给的是相对路径也原样尊重, 不强行拼 exe_dir。
        let got = resolve_out_dir(
            std::path::Path::new("C:/app"),
            std::path::Path::new("jobs_out"),
            Some("some/relative/override".to_string()),
        );
        assert_eq!(got, PathBuf::from("some/relative/override"));
    }

    #[test]
    fn empty_env_override_falls_through_to_config() {
        let got = resolve_out_dir(
            std::path::Path::new("C:/app"),
            std::path::Path::new("jobs_out"),
            Some(String::new()),
        );
        assert_eq!(got, PathBuf::from("C:/app").join("jobs_out"));
    }
}

#[cfg(test)]
mod prep_path_tests {
    use super::resolve_prep_path;

    #[test]
    fn env_var_wins() {
        std::env::set_var("AIDULC_PREP", "C:/custom/prep.exe");
        let p = resolve_prep_path(std::path::Path::new("C:/app"));
        std::env::remove_var("AIDULC_PREP");
        assert_eq!(p, std::path::PathBuf::from("C:/custom/prep.exe"));
    }

    #[test]
    fn sibling_exists_when_portable() {
        // 便携布局: exe 同级 prep/ 存在 → 用它
        let dir = std::env::temp_dir().join(format!("aidulc_pp_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("prep")).unwrap();
        std::fs::write(dir.join("prep").join("aidulc-prep.exe"), b"x").unwrap();
        std::env::remove_var("AIDULC_PREP");
        let p = resolve_prep_path(&dir);
        assert_eq!(p, dir.join("prep").join("aidulc-prep.exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_sibling_never_empty() {
        // 无处可找 → 返回 exe 同级 (健康检查显示"找不到", 不静默空)
        std::env::remove_var("AIDULC_PREP");
        let dir = std::env::temp_dir().join(format!("aidulc_pn_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = resolve_prep_path(&dir);
        assert!(p.ends_with("aidulc-prep.exe"), "应返回可读路径: {p:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn main() {
    // 1. 配置
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let cfg = services::config::Config::load(&exe_dir);

    // 2. 数据库
    let db_path = std::env::var("AIDULC_DB")
        .unwrap_or_else(|_| exe_dir.join("data.db").to_string_lossy().to_string());
    let db = store::Db::open(&db_path).expect("打开 SQLite 失败");

    // 3. 书库/输出目录 (见 resolve_out_dir 文档注释: 2026-08-07 修复的路径 bug
    //    + 合并此前重复的 library_dir/out_dir 两个概念, 见 Config.out_dir 文档注释)
    let out_dir = resolve_out_dir(&exe_dir, &cfg.out_dir, std::env::var("AIDULC_OUT").ok());

    // 4. prep 侧车 (多级探测: 环境变量 → exe 同级 → 开发目录 → 上级 prep 构建)
    let prep_path = resolve_prep_path(&exe_dir);
    // 日志 (用户反馈排查: 启动时明确侧车路径, os error 3 一眼可见原因)
    let log_dir = std::env::var("AIDULC_LOG")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("logs"));
    let _ = infrastructure::log::init(&log_dir);
    infrastructure::log::info("app", "应用启动");
    infrastructure::log::info("app", &format!("exe_dir={}", exe_dir.to_string_lossy()));
    infrastructure::log::info(
        "app",
        &format!(
            "prep_path={} (存在: {})",
            prep_path.to_string_lossy(),
            prep_path.exists()
        ),
    );
    // 书库路径此前是静默的相对路径 bug 根源(见上方修复注释), 启动时明确打印解析后的
    // 绝对路径, 用户/开发者都能一眼确认书包实际存放位置, 不用再靠猜。
    infrastructure::log::info(
        "app",
        &format!(
            "out_dir={} (存在: {})",
            out_dir.to_string_lossy(),
            out_dir.exists()
        ),
    );

    jobs::job_guard::init_child_job_object();

    // G2/G7: 启动时重置 stale 任务 (P0-A, 2026-08-10: running → paused, **不是** queued)。
    // 恢复队列只收集真正 queued 的任务 —— stale running 任务已变成 paused, 不会被 pump_queue
    // 在启动时立刻拉起侧车 (66MB PyInstaller 解包 + 模型加载会拖到整窗未响应, 真机实测过)。
    // 用户在处理台点"继续"才重启, 与"暂停→继续"同一语义。
    let recover_queue: Vec<String> = {
        let jobs_repo = store::jobs_repo::JobsRepo::new(&db);
        let _ = jobs_repo.reset_stale();
        jobs_repo
            .list()
            .into_iter()
            .filter(|j| j.status == "queued")
            .map(|j| j.id)
            .collect()
    };

    // 从 Windows Credential Manager 读 CF token
    let cf_token = services::credentials::get_cf_token().unwrap_or_default();
    let svc = AppServices {
        cf_worker_url: Mutex::new(cfg.cf_worker_url.clone()),
        cf_token: Mutex::new(cf_token),
    };

    let prep_cfg = PrepConfig {
        prep_path,
        out_dir,
        ffmpeg: std::env::var("AIDULC_FFMPEG")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| cfg.ffmpeg_path.clone()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db)
        .manage(svc)
        .manage(PrepState {
            child: Mutex::new(None),
            running_job: Mutex::new(None),
            queue: Mutex::new(recover_queue),
        })
        .manage(prep_cfg)
        // 阶段3 (F46): 书包解析缓存, 消除大书每章整文件重读重解析 (实测 419ms/章)
        .manage(infrastructure::bookpack_cache::BookpackCache::new())
        .setup(|app| {
            // G7: 启动后自动恢复队列任务 —— 只有用户明确 queued 的任务才自动跑;
            // stale running 任务已被 reset_stale 标记成 paused, 不在此列 (P0-A, 2026-08-10)。
            if let (Some(cfg), Some(db), Some(st)) = (
                app.try_state::<PrepConfig>(),
                app.try_state::<store::Db>(),
                app.try_state::<PrepState>(),
            ) {
                let _ = application::library_asset_service::cleanup_orphans(db.inner());
                // 2026-08-09 无限成长修复: 清理无主任务的孤儿 job 目录 (失败/取消/移除过、
                // 从未产出书的任务目录会累积 checkpoint/TTS/日志, 是磁盘最大漏)
                let _ = application::library_asset_service::cleanup_orphan_job_dirs(
                    db.inner(),
                    &cfg.inner().out_dir,
                );
                // N6 (2026-08-10): 清终态且超保留期(30 天)的批次行, 批次表不再无界累积
                let _ = store::batches_repo::BatchesRepo::new(db.inner()).cleanup_old(30);
                // N6b (2026-08-10): 清终态且超保留期的任务行 (不删 running/queued 和
                // 仍被 edition 引用的), 任务表不再无界累积
                let _ = store::jobs_repo::JobsRepo::new(db.inner()).cleanup_old(30);
                // 修复: 任务死 (进程被强杀) 但书状态卡 processing → 恢复 pending (书库可见可重试)
                let books_repo = store::books_repo::BooksRepo::new(db.inner());
                for b in books_repo.list_by_kind("original") {
                    if b.status == "processing" {
                        let mut nb = b.clone();
                        nb.status = "pending".into();
                        nb.updated_at = store::now_ms_for_store();
                        let _ = books_repo.upsert(&nb);
                    }
                }
                let _ = application::job_orchestrator::pump_queue(
                    app.handle().clone(),
                    cfg.inner(),
                    st.inner(),
                    db.inner(),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::library_list,
            commands::library::library_register,
            commands::library::library_remove,
            commands::library::library_open,
            commands::library::edition_lookup,
            commands::library::load_bookpack,
            commands::library::load_bookpack_chapter,
            commands::library::read_audio,
            commands::library::read_audio_range,
            commands::library::read_image,
            commands::library::pick_files,
            commands::library::library_preview,
            commands::library::book_export,
            commands::library::book_import,
            commands::reader::word_lookup,
            commands::reader::add_vocab,
            commands::reader::dict_list,
            commands::reader::dict_search,
            commands::reader::dict_remove,
            commands::reader::vocab_all,
            commands::reader::vocab_search,
            commands::reader::vocab_remove,
            commands::reader::vocab_stats,
            commands::reader::srs_preview,
            commands::reader::srs_grade,
            commands::reader::vocab_restore,
            commands::reader::sync_status,
            commands::reader::sync_now,
            commands::reader::sync_pull_now,
            commands::reader::sync_auth_device,
            commands::reader::sync_make_code,
            commands::reader::sync_pair_qr,
            commands::reader::sync_revoke_token,
            commands::reader::sync_disconnect,
            commands::reader::sync_config_set,
            commands::reader::bookmarks_list,
            commands::reader::log_from_frontend,
            commands::reader::log_path,
            commands::jobs::start_prep_job,
            commands::jobs::batch_start,
            commands::jobs::batch_import,
            commands::jobs::batch_start_prep,
            commands::jobs::batch_list,
            commands::jobs::batch_detail,
            commands::jobs::job_list,
            commands::jobs::job_remove,
            commands::jobs::job_retry_failed,
            commands::jobs::job_detail,
            commands::jobs::cancel_prep_job,
            commands::jobs::job_pause,
            commands::jobs::job_resume,
            commands::jobs::pause_all,
            commands::jobs::resume_all,
            commands::models::models_list,
            commands::models::models_by,
            commands::models::models_recommend,
            commands::models::models_register,
            commands::models::models_set_recommended,
            commands::models::models_remove,
            commands::models::models_scan,
            commands::models::models_bind_book,
            commands::models::models_book_binding,
            commands::models::models_download,
            commands::models::models_download_status,
            commands::models::hardware_detect,
            commands::models::wizard_state,
            commands::models::wizard_submit,
            commands::models::wizard_finish,
            commands::misc::runtime_config,
            commands::misc::components_health,
            commands::misc::library_dir_get,
            commands::misc::library_dir_pick_and_set,
            commands::misc::boot_ping,
            commands::misc::doc_parser_install,
            ipc::commands::profile_upsert,
            ipc::commands::profile_list,
            ipc::commands::profile_delete,
            ipc::commands::users_list,
            ipc::commands::highlights_list,
            ipc::commands::highlights_save,
            ipc::commands::highlights_remove,
            ipc::commands::reading_save,
            ipc::commands::reading_get,
            ipc::commands::reading_stats,
            ipc::commands::settings_upsert,
            ipc::commands::settings_get,
            ipc::commands::transfer_export,
            ipc::commands::transfer_import,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // M7 R29: 应用退出时主动杀掉常驻词典守护, 不留 2.4GB 模型的后台进程
            if let tauri::RunEvent::Exit = event {
                crate::infrastructure::dict_daemon::stop();
            }
        });
}
