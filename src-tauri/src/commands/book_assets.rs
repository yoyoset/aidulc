//! commands/book_assets.rs —— 单本书的"资产"操作: 预览原文 / 补封面
//!
//! 治理 (2026-08-17): 从 commands/library.rs 拆出。library.rs 是书库的增删改查 +
//! 列表聚合, 而这两个命令是"spawn 侧车对单本书做一次性资产处理" —— 和
//! commands/book_audit.rs(导入前体检)是同一类, 放一起边界更清楚。
//! 拆分同时把 library.rs 拉回 file-size 基线内(拆之前 1166 行 > 上限 1123,
//! 这个超标在本次改动之前就已经存在)。
//!
//! **注意**: ipc/registry.rs 里这两个命令的 path 必须跟着改到新文件, 漏改不会报错,
//! 只会让 F29 校验静默去错的文件里找函数(CLAUDE.md 有记)。

use tauri::State;

use crate::store;

/// S4: 原版书预览 (书库"查看原文") — spawn 侧车 preview 模式读原书纯文本
/// 返回 { title, chapters: [{index, title, sentences: [原文]}], format }
/// S0 (2026-08-10): 改 async + spawn_blocking + 读超时 —— spawn 子进程读 stdout 是
/// 阻塞 I/O, 同步命令会卡死主线程 (与 components_health 同类, 一并修)。
#[tauri::command]
pub async fn library_preview(
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    let prep_path = cfg.prep_path.clone();
    let source_path = {
        let repo = store::books_repo::BooksRepo::new(db.inner());
        let book = repo.get(&book_id).ok_or("书不存在")?;
        if !std::path::Path::new(&book.source_path).exists() {
            return Err("原书文件不存在, 请重新导入".into());
        }
        book.source_path.clone()
    };
    let v = tauri::async_runtime::spawn_blocking(move || {
        preview_book_blocking(&prep_path, &source_path)
    })
    .await
    .map_err(|e| format!("预览执行失败: {e}"))??;
    Ok(v)
}

/// K12 (2026-08-14): 补封面——只重跑"从源 EPUB 抽封面拷进书包根"这一步, 不碰
/// 已生成的译文/音频/讲解。老 edition(K2-2 封面管线上线前跑完的)专用轻量入口,
/// 免去"要么重新跑一次完整备料(很贵), 要么永远没有封面"这个二选一。
#[tauri::command]
pub async fn backfill_cover(
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
    cache: State<'_, crate::infrastructure::bookpack_cache::BookpackCache>,
    edition_id: String,
) -> Result<serde_json::Value, String> {
    let prep_path = cfg.prep_path.clone();
    let (source_path, pack_dir) = {
        let editions = store::editions_repo::EditionsRepo::new(db.inner());
        let edition = editions.get(&edition_id).ok_or("译本不存在")?;
        let books = store::books_repo::BooksRepo::new(db.inner());
        let book = books.get(&edition.source_id).ok_or("原书不存在")?;
        if !std::path::Path::new(&book.source_path).exists() {
            return Err("原书文件不存在, 请重新导入".into());
        }
        (book.source_path.clone(), edition.pack_dir.clone())
    };
    let pack_dir_for_blocking = pack_dir.clone();
    let v = tauri::async_runtime::spawn_blocking(move || {
        backfill_cover_blocking(&prep_path, &source_path, &pack_dir_for_blocking)
    })
    .await
    .map_err(|e| format!("补封面执行失败: {e}"))??;
    cache.invalidate(&pack_dir);
    Ok(v)
}

fn backfill_cover_blocking(
    prep_path: &std::path::Path,
    source_path: &str,
    pack_dir: &str,
) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(prep_path);
    cmd.arg("--backfill-cover-book")
        .arg(source_path)
        .arg("--backfill-cover-pack")
        .arg(pack_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let child = cmd.spawn().map_err(|e| format!("启动补封面失败: {e}"))?;
    let out = crate::services::components::read_stdout_with_timeout(
        child,
        std::time::Duration::from_secs(60),
    )
    .map_err(|e| format!("读补封面输出失败: {e}"))?;
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("补封面无输出")?;
    serde_json::from_str(line).map_err(|e| format!("补封面输出非法: {e}"))
}

fn preview_book_blocking(
    prep_path: &std::path::Path,
    source_path: &str,
) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // 调侧车 preview (复用 loader: 已修复 z-lib EPUB manifest 顺序 + 垃圾句过滤)
    let mut cmd = Command::new(prep_path);
    cmd.arg("--preview-book")
        .arg(source_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let child = cmd.spawn().map_err(|e| format!("启动预览失败: {e}"))?;
    // S0: 读 stdout 带 60 秒超时 (大书解析可能慢, 但不应无限等)
    let out = crate::services::components::read_stdout_with_timeout(
        child,
        std::time::Duration::from_secs(60),
    )
    .map_err(|e| format!("读预览输出失败: {e}"))?;
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("预览无输出")?;
    let mut v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("预览输出非法: {e}"))?;
    v["format"] = serde_json::json!(std::path::Path::new(source_path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default());
    Ok(v)
}
