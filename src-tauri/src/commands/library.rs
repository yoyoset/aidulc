//! commands/library.rs —— 书库/书包/音频命令 (G4: 从 main.rs 拆分)
//! 只做参数转换和调用 store/service, 不承载业务决策。

use crate::store;
use tauri::State;

// M 系列: now_ms 统一走 store::now_ms_for_store (删除重复实现)
pub fn now_ms() -> i64 {
    store::now_ms_for_store()
}

pub fn book_id_from_path(path: &str, profile: &str) -> String {
    let name = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "book".into());
    format!(
        "{}_{}",
        name.to_lowercase()
            .replace(|c: char| !c.is_alphanumeric(), "_"),
        profile
    )
}

/// 书库列表 (kind: original=原版管理 | product=AI 成品 | 空=全部)
#[tauri::command]
pub fn library_list(
    db: State<store::Db>,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let books = match kind.as_deref() {
        Some(k) if k == "original" || k == "product" => repo.list_by_kind(k),
        _ => repo.list(),
    };
    serde_json::to_value(books).map_err(|e| e.to_string())
}

/// 登记一本书
#[tauri::command]
pub fn library_register(
    db: State<store::Db>,
    id: String,
    title: String,
    source_path: String,
    pack_dir: String,
    profile_id: String,
    chapter_count: i64,
    failed_count: i64,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<(), String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let book = store::books_repo::Book {
        id,
        title,
        source_path,
        pack_dir,
        profile_id,
        status: if failed_count > 0 {
            "partial".into()
        } else {
            "ready".into()
        },
        kind: "product".into(), // v7: 登记的是成品
        source_book_id: None,
        chapter_count,
        failed_count,
        last_opened_at: None,
        source_language: source_language.unwrap_or_else(|| "en".into()),
        target_language: target_language.unwrap_or_else(|| "zh-CN".into()),
        llm_id: None,
        tts_id: None,
        nlp_id: None,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    repo.upsert(&book)
}

/// 删除一本书
#[tauri::command]
pub fn library_remove(db: State<store::Db>, id: String, delete_files: bool) -> Result<(), String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    if let Some(book) = repo.get(&id) {
        if delete_files {
            let _ = std::fs::remove_dir_all(&book.pack_dir);
        }
        repo.remove(&id)?;
    }
    Ok(())
}

/// 打开一本书 (登记打开时间)
#[tauri::command]
pub fn library_open(db: State<store::Db>, id: String) -> Result<serde_json::Value, String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let book = repo.get(&id).ok_or("书不存在")?;
    repo.touch_opened(&id, now_ms())?;
    serde_json::to_value(book).map_err(|e| e.to_string())
}

/// 加载书包 (book_id)
#[tauri::command]
pub fn load_bookpack(
    app: tauri::AppHandle,
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let repo = store::books_repo::BooksRepo::new(db.inner());
    let target = if let Some(book) = repo.get(&book_id) {
        std::path::PathBuf::from(&book.pack_dir)
    } else {
        let p = std::path::PathBuf::from(&book_id);
        if p.is_dir() && p.join("bookpack.json").exists() {
            p
        } else {
            // 兜底: book_id 当作书库根目录下的直接子目录名(未登记进 DB 的场景)。
            // 沿用此前 library_dir 分支的相对语义, 只是指向的根换成了合并后的 out_dir。
            cfg.out_dir.join(&book_id)
        }
    };

    let bp_path = target.join("bookpack.json");
    let data = std::fs::read_to_string(&bp_path).map_err(|e| {
        format!(
            "读书包失败: {e} (book_id={book_id}, target={})",
            target.display()
        )
    })?;
    let bookpack: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("书包 JSON 解析失败: {e}"))?;
    crate::domain::bookpack::check_version(&bookpack)?;

    let profile_id = bookpack
        .get("profile")
        .and_then(|p| p.get("id"))
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();
    let auto_id = if repo.get(&book_id).is_some() {
        book_id.clone()
    } else {
        book_id_from_path(&target.to_string_lossy(), &profile_id)
    };
    if repo.get(&auto_id).is_none() {
        // M 系列: 复用共享登记 (读 bookpack.json → 构造 Book → upsert)
        let _ = crate::application::library_service::register_book(
            db.inner(),
            auto_id.clone(),
            &target.to_string_lossy(),
            String::new(),
            auto_id.clone(), // v8: 原书 id (打开已有书包的场景, 原书=自己)
            profile_id,
            "en".into(),
            "zh-CN".into(),
            None,
            None,
            None,
        );
    }
    let _ = app.emit("library-changed", serde_json::json!({}));

    Ok(serde_json::json!({
        "bookpack": bookpack,
        "basePath": target.to_string_lossy(),
        "bookId": auto_id,
    }))
}

/// 读音频文件 (兼容单次整读)
#[tauri::command]
pub fn read_audio(base_path: String, file: String) -> Result<Vec<u8>, String> {
    let path = std::path::Path::new(&base_path).join(file);
    let canonical_base =
        std::fs::canonicalize(&base_path).map_err(|e| format!("书包根无效: {e}"))?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| format!("文件不存在: {e}"))?;
    if !canonical_path.starts_with(&canonical_base) {
        return Err("路径越界".into());
    }
    std::fs::read(&canonical_path).map_err(|e| format!("读文件失败: {e}"))
}

/// 分块读音频 (G3: 长章避免整文件跨 IPC)
#[tauri::command]
pub fn read_audio_range(
    base_path: String,
    file: String,
    offset: u64,
    length: usize,
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&base_path).join(file);
    let canonical_base =
        std::fs::canonicalize(&base_path).map_err(|e| format!("书包根无效: {e}"))?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| format!("文件不存在: {e}"))?;
    if !canonical_path.starts_with(&canonical_base) {
        return Err("路径越界".into());
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&canonical_path).map_err(|e| format!("打开失败: {e}"))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek 失败: {e}"))?;
    let mut buf = vec![0u8; length.min(4 * 1024 * 1024)];
    let n = f.read(&mut buf).map_err(|e| format!("读失败: {e}"))?;
    buf.truncate(n);
    let end = (offset as usize + n) >= total as usize;
    // 修复: 二进制用 base64 (JSON 数字数组 2MB → 序列化开销巨大且可能截断导致 blob 空)
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(serde_json::json!({
        "data_b64": b64,
        "offset": offset,
        "read": n,
        "total": total,
        "end": end,
    }))
}

/// 原生文件选择 (Tauri 2 WebView2 File 无 .path, 审查确认 — 用 rfd 对话框拿真实路径)
#[tauri::command]
pub fn pick_files(extensions: Vec<String>) -> Result<Vec<String>, String> {
    let mut dlg = rfd::FileDialog::new().set_title("选择要导入的书籍");
    if !extensions.is_empty() {
        dlg = dlg.add_filter("Books", &extensions);
    }
    let paths: Vec<String> = dlg
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(paths)
}

/// S4: 原版书预览 (书库"查看原文") — spawn 侧车 preview 模式读原书纯文本
/// 返回 { title, chapters: [{index, title, sentences: [原文]}], format }
#[tauri::command]
pub fn library_preview(
    cfg: State<crate::PrepConfig>,
    db: State<store::Db>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let repo = store::books_repo::BooksRepo::new(db.inner());
    let book = repo.get(&book_id).ok_or("书不存在")?;
    if !std::path::Path::new(&book.source_path).exists() {
        return Err("原书文件不存在, 请重新导入".into());
    }
    // 调侧车 preview (复用 loader: 已修复 z-lib EPUB manifest 顺序 + 垃圾句过滤)
    let mut cmd = Command::new(&cfg.prep_path);
    cmd.arg("--preview-book")
        .arg(&book.source_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(|e| format!("启动预览失败: {e}"))?;
    let mut out = String::new();
    child
        .stdout
        .take()
        .ok_or("无法读取预览输出")?
        .read_to_string(&mut out)
        .map_err(|e| format!("读预览输出失败: {e}"))?;
    let _ = child.wait();
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("预览无输出")?;
    let mut v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("预览输出非法: {e}"))?;
    v["format"] = serde_json::json!(std::path::Path::new(&book.source_path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default());
    Ok(v)
}
