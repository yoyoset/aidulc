#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod application {
    pub mod dictionary_service;
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
    pub mod sync;
    pub mod vocab;
}
mod services {
    pub mod components;
    pub mod config;
    pub mod credentials;
    pub mod sync;
}
mod store {
    pub mod batches_repo;
    pub mod books_repo;
    pub mod dict_repo;
    pub mod jobs_repo;
    pub mod model_repo;
    pub mod profile_repo;
    pub mod reading_repo;
    pub mod settings_repo;
    pub mod store_mod;
    pub mod vocab_repo;
    pub use store_mod::{now_ms_for_store, Db};
}
mod jobs {
    pub mod job_guard;
    pub mod progress;
    pub mod spawn;
}
mod infrastructure {
    pub mod downloader;
    pub mod log;
    pub mod model_store {
        pub mod scan;
    }
}
mod ipc {
    pub mod commands;
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

/// 书包库目录
pub struct LibraryState {
    pub dir: Mutex<String>,
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
        let dev = cur.join("prep").join("dist").join("aidulc-prep").join("aidulc-prep.exe");
        if dev.exists() {
            return dev;
        }
    }
    // 4. 兜底: 返回 exe 同级 (组件健康检查会明确显示"找不到", 不静默)
    sibling
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

    // 3. 书库目录
    let lib_dir = std::env::var("AIDULC_LIBRARY")
        .unwrap_or_else(|_| cfg.library_dir.to_string_lossy().to_string());

    // 4. prep 侧车 (多级探测: 环境变量 → exe 同级 → 开发目录 → 上级 prep 构建)
    let prep_path = resolve_prep_path(&exe_dir);
    // 日志 (用户反馈排查: 启动时明确侧车路径, os error 3 一眼可见原因)
    let log_dir = std::env::var("AIDULC_LOG")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("logs"));
    let _ = infrastructure::log::init(&log_dir);
    infrastructure::log::info("app", "应用启动");
    infrastructure::log::info("app", &format!("exe_dir={}", exe_dir.to_string_lossy()));
    infrastructure::log::info("app", &format!(
        "prep_path={} (存在: {})", prep_path.to_string_lossy(), prep_path.exists()
    ));

    jobs::job_guard::init_child_job_object();

    // G2/G7: 启动时重置 stale 任务 (running → queued) 并收集恢复队列
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
        out_dir: std::env::var("AIDULC_OUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| exe_dir.join("jobs_out")),
        ffmpeg: std::env::var("AIDULC_FFMPEG")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| cfg.ffmpeg_path.clone()),
    };

    tauri::Builder::default()
        .manage(db)
        .manage(svc)
        .manage(LibraryState {
            dir: Mutex::new(lib_dir),
        })
        .manage(PrepState {
            child: Mutex::new(None),
            running_job: Mutex::new(None),
            queue: Mutex::new(recover_queue),
        })
        .manage(prep_cfg)
        .setup(|app| {
            // G7: 启动后自动恢复队列任务
            if let (Some(cfg), Some(db), Some(st)) = (
                app.try_state::<PrepConfig>(),
                app.try_state::<store::Db>(),
                app.try_state::<PrepState>(),
            ) {
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
                let _ = commands::jobs::pump_queue(app.handle().clone(), cfg.inner(), st.inner(), db.inner());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::library_list,
            commands::library::library_register,
            commands::library::library_remove,
            commands::library::library_open,
            commands::library::load_bookpack,
            commands::library::read_audio,
            commands::library::read_audio_range,
            commands::library::pick_files,
            commands::library::library_preview,
            commands::reader::word_lookup,
            commands::reader::add_vocab,
            commands::reader::dict_list,
            commands::reader::dict_search,
            commands::reader::dict_remove,
            commands::reader::vocab_all,
            commands::reader::vocab_search,
            commands::reader::vocab_remove,
            commands::reader::vocab_stats,
            commands::reader::sync_status,
            commands::reader::sync_now,
            commands::reader::sync_pull_now,
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
            commands::models::hardware_detect,
            commands::models::wizard_state,
            commands::models::wizard_submit,
            commands::models::wizard_finish,
            commands::misc::runtime_config,
            commands::misc::components_health,
            commands::misc::boot_ping,
            ipc::commands::profile_upsert,
            ipc::commands::profile_list,
            ipc::commands::reading_save,
            ipc::commands::reading_get,
            ipc::commands::settings_upsert,
            ipc::commands::settings_get,
            ipc::commands::transfer_export,
            ipc::commands::transfer_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

