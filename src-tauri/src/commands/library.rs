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

/// book_id → 书包所在目录(登记过的书查 DB; 否则按路径/兜底目录猜)。
/// 从 load_bookpack 提取, load_bookpack_chapter 复用同一套解析规则(两个命令必须
/// 找到同一个目录, 不能一个走 DB、一个走猜测导致"元信息"和"章节内容"不是同一本书)。
fn resolve_book_pack_dir(
    db: &store::Db,
    cfg: &crate::PrepConfig,
    book_id: &str,
) -> std::path::PathBuf {
    let repo = store::books_repo::BooksRepo::new(db);
    if let Some(book) = repo.get(book_id) {
        std::path::PathBuf::from(&book.pack_dir)
    } else {
        let p = std::path::PathBuf::from(book_id);
        if p.is_dir() && p.join("bookpack.json").exists() {
            p
        } else {
            // 兜底: book_id 当作书库根目录下的直接子目录名(未登记进 DB 的场景)。
            // 沿用此前 library_dir 分支的相对语义, 只是指向的根换成了合并后的 out_dir。
            cfg.out_dir.join(book_id)
        }
    }
}

/// 把书包里每章的 sentences 换成只含 original_text 的轻量占位(供全文搜索/章节列表用)。
///
/// 修复(2026-08-07 用真实书撞见): `load_bookpack` 曾经把整本书(含每句的译文/讲解/
/// 逐词时间轴)一次性通过 IPC 传给前端。真实的《The Ultimate Hitchhiker's Guide》
/// bookpack.json 有 92MB, 92MB 字符串在前端 JS 侧 `JSON.parse` 是同步的, 会把界面主
/// 线程整个卡死好几秒甚至更久, 表现就是"点开始阅读没反应/渲染不出来"。现在只回元信息,
/// 具体某一章的完整内容(译文/讲解/时间轴)按需另调 `load_bookpack_chapter`。
fn strip_chapters_to_meta(bookpack: &mut serde_json::Value) {
    let Some(chapters) = bookpack.get_mut("chapters").and_then(|c| c.as_array_mut()) else {
        return;
    };
    for chapter in chapters.iter_mut() {
        let Some(sentences) = chapter.get_mut("sentences").and_then(|s| s.as_array_mut()) else {
            continue;
        };
        for sentence in sentences.iter_mut() {
            let text = sentence
                .get("original_text")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            *sentence = serde_json::json!({ "original_text": text });
        }
    }
}

/// 加载书包元信息 (book_id) —— 每章只带 original_text(供全文搜索), 不含译文/讲解/
/// 时间轴; 具体章节内容按需调 load_bookpack_chapter。
#[tauri::command]
pub fn load_bookpack(
    app: tauri::AppHandle,
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let repo = store::books_repo::BooksRepo::new(db.inner());
    let target = resolve_book_pack_dir(db.inner(), &cfg, &book_id);

    let bp_path = target.join("bookpack.json");
    let data = std::fs::read_to_string(&bp_path).map_err(|e| {
        format!(
            "读书包失败: {e} (book_id={book_id}, target={})",
            target.display()
        )
    })?;
    let mut bookpack: serde_json::Value =
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

    strip_chapters_to_meta(&mut bookpack);

    Ok(serde_json::json!({
        "bookpack": bookpack,
        "basePath": target.to_string_lossy(),
        "bookId": auto_id,
    }))
}

/// 按需加载单章完整内容(译文/讲解/segments/时间轴), 配合 load_bookpack 的元信息用。
#[tauri::command]
pub fn load_bookpack_chapter(
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    book_id: String,
    chapter_index: usize,
) -> Result<serde_json::Value, String> {
    let target = resolve_book_pack_dir(db.inner(), &cfg, &book_id);
    let bp_path = target.join("bookpack.json");
    let data = std::fs::read_to_string(&bp_path)
        .map_err(|e| format!("读书包失败: {e} (book_id={book_id})"))?;
    let bookpack: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("书包 JSON 解析失败: {e}"))?;
    bookpack
        .get("chapters")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.get(chapter_index))
        .cloned()
        .ok_or_else(|| format!("章节下标越界: {chapter_index}"))
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    #[test]
    fn strips_heavy_fields_keeps_original_text() {
        let mut bp = serde_json::json!({
            "chapters": [{
                "title": "Ch1",
                "sentences": [
                    { "original_text": "Hello.", "translation": "你好。", "segments": [["Hello","INTJ","hello"]], "audio": {"start_ms": 0, "end_ms": 500} },
                    { "original_text": "Bye.", "translation": "再见。" }
                ]
            }]
        });
        strip_chapters_to_meta(&mut bp);
        let s0 = &bp["chapters"][0]["sentences"][0];
        assert_eq!(s0["original_text"], "Hello.");
        assert!(s0.get("translation").is_none(), "译文应被剥离");
        assert!(s0.get("segments").is_none(), "segments 应被剥离");
        assert!(s0.get("audio").is_none(), "audio 应被剥离");
        assert_eq!(bp["chapters"][0]["sentences"][1]["original_text"], "Bye.");
        assert_eq!(
            bp["chapters"][0]["title"], "Ch1",
            "非 sentences 字段不受影响"
        );
    }

    #[test]
    fn missing_chapters_or_sentences_is_noop() {
        let mut bp = serde_json::json!({ "title": "empty" });
        strip_chapters_to_meta(&mut bp); // 不 panic
        assert_eq!(bp["title"], "empty");

        let mut bp2 = serde_json::json!({ "chapters": [{ "title": "no sentences field" }] });
        strip_chapters_to_meta(&mut bp2); // 不 panic
        assert_eq!(bp2["chapters"][0]["title"], "no sentences field");
    }
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

/// 读原书插图 (R4, 2026-08-08): 复用 read_audio 的 canonicalize + 路径包含校验,
/// 不另写一份防越界逻辑。返回 base64 (与 read_audio_range 的二进制编码一致)。
#[tauri::command]
pub fn read_image(base_path: String, file: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&base_path).join(file);
    let canonical_base =
        std::fs::canonicalize(&base_path).map_err(|e| format!("书包根无效: {e}"))?;
    let canonical_path = std::fs::canonicalize(&path).map_err(|e| format!("文件不存在: {e}"))?;
    if !canonical_path.starts_with(&canonical_base) {
        return Err("路径越界".into());
    }
    let data = std::fs::read(&canonical_path).map_err(|e| format!("读文件失败: {e}"))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(serde_json::json!({ "data_b64": b64 }))
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

/// P1.3: 书包导出为 zip (用户明确要求的产品能力: 成品是资产, 可跨设备迁移)
#[tauri::command]
pub fn book_export(db: State<store::Db>, id: String) -> Result<serde_json::Value, String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let book = repo.get(&id).ok_or("书不存在")?;
    let pack_dir = std::path::PathBuf::from(&book.pack_dir);
    let picked = rfd::FileDialog::new()
        .set_title("导出书包为 zip")
        .set_file_name(format!("{}.zip", book.id))
        .add_filter("Zip", &["zip"])
        .save_file();
    let dest = match picked {
        Some(p) => p,
        None => return Ok(serde_json::json!({ "cancelled": true })),
    };
    crate::application::book_transfer_service::export_book_zip(&pack_dir, &dest)?;
    Ok(serde_json::json!({ "cancelled": false, "path": dest.to_string_lossy() }))
}

/// P1.4: 导入 zip 书包 (解到 out_dir 下新 id, 登记进 books 表; id 冲突自动加序号)
#[tauri::command]
pub fn book_import(
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
) -> Result<serde_json::Value, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择要导入的书包 zip")
        .add_filter("Zip", &["zip"])
        .pick_file();
    let zip_path = match picked {
        Some(p) => p,
        None => return Ok(serde_json::json!({ "cancelled": true })),
    };

    let base_id = zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "book".into())
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric(), "_");
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let mut new_id = base_id.clone();
    let mut n = 1;
    while cfg.out_dir.join(&new_id).exists() || repo.get(&new_id).is_some() {
        n += 1;
        new_id = format!("{base_id}_{n}");
    }

    let pack_dir = crate::application::book_transfer_service::import_book_zip(
        &zip_path,
        &cfg.out_dir,
        &new_id,
    )?;

    let text = std::fs::read_to_string(pack_dir.join("bookpack.json"))
        .map_err(|e| format!("读 bookpack.json 失败: {e}"))?;
    let bookpack: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bookpack.json JSON 解析失败: {e}"))?;
    crate::domain::bookpack::check_version(&bookpack)?;
    let profile_id = bookpack
        .get("profile")
        .and_then(|p| p.get("id"))
        .and_then(|i| i.as_str())
        .unwrap_or("default")
        .to_string();

    crate::application::library_service::register_book(
        db.inner(),
        new_id.clone(),
        &pack_dir.to_string_lossy(),
        String::new(),
        new_id.clone(),
        profile_id,
        "en".into(),
        "zh-CN".into(),
        None,
        None,
        None,
    )
    .ok_or("登记书失败(bookpack.json 缺少必要字段)")?;

    Ok(serde_json::json!({
        "cancelled": false,
        "id": new_id,
        "pack_dir": pack_dir.to_string_lossy(),
    }))
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
