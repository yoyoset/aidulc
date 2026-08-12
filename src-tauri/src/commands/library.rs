//! commands/library.rs —— 书库/书包/音频命令 (G4: 从 main.rs 拆分)
//! 只做参数转换和调用 store/service, 不承载业务决策。

use crate::store;
use tauri::State;

// ---- R1 (UX5 #7, 2026-08-13): 内置样书 —— 向导完成页 ② 导入, 进书库即可阅读 ----

/// 内置样书 bookpack (schema v1, 无音频的轻量文本样书)。
/// 原创英文短句 (非受版权保护的原文), 中文译文 + 讲解, 供新用户立即体验阅读。
const SAMPLE_BOOKPACK: &str = r#"{
  "schemaVersion": 1,
  "title": "Sample: A Morning Walk (样书)",
  "profile": { "id": "default", "name": "成人自读", "explainStrategy": "brief", "voice": "af_heart", "speed": 1.0 },
  "generatedAt": 1,
  "prepVersion": "sample",
  "quality": { "stages": {}, "summary": "内置样书: 无音频的文本译本, 用于立即体验阅读。" },
  "chapters": [
    {
      "index": 0,
      "title": "The Walk Begins",
      "audioFile": "",
      "sentences": [
        {
          "original_text": "The morning was fresh and quiet.",
          "translation": "清晨新鲜而安静。",
          "explanation": "句子主干是 The morning was fresh and quiet, 系表结构。fresh 意为「新鲜的」, quiet 意为「安静的」。",
          "segments": [["The","DET","the"],["morning","NOUN","morning"],["was","AUX","be"],["fresh","ADJ","fresh"],["and","CCONJ","and"],["quiet","ADJ","quiet"],["." ,"PUNCT","."]],
          "status": "ok"
        },
        {
          "original_text": "A small bird sang on the fence.",
          "translation": "一只小鸟在篱笆上唱歌。",
          "explanation": "sang 是 sing 的过去式; on the fence 是地点状语, 意为「在篱笆上」。",
          "segments": [["A","DET","a"],["small","ADJ","small"],["bird","NOUN","bird"],["sang","VERB","sing"],["on","ADP","on"],["the","DET","the"],["fence","NOUN","fence"],["." ,"PUNCT","."]],
          "status": "ok"
        },
        {
          "original_text": "I walked slowly down the quiet street.",
          "translation": "我沿着安静的街道慢慢走。",
          "explanation": "walk down the street 意为「沿街走」; slowly 是副词修饰 walked。",
          "segments": [["I","PRON","I"],["walked","VERB","walk"],["slowly","ADV","slowly"],["down","ADP","down"],["the","DET","the"],["quiet","ADJ","quiet"],["street","NOUN","street"],["." ,"PUNCT","."]],
          "status": "ok"
        }
      ]
    },
    {
      "index": 1,
      "title": "The Market",
      "audioFile": "",
      "sentences": [
        {
          "original_text": "The market smelled of bread and flowers.",
          "translation": "市场里飘着面包和花的香气。",
          "explanation": "smell of 意为「散发出…气味」; bread and flowers 是并列宾语。",
          "segments": [["The","DET","the"],["market","NOUN","market"],["smelled","VERB","smell"],["of","ADP","of"],["bread","NOUN","bread"],["and","CCONJ","and"],["flowers","NOUN","flower"],["." ,"PUNCT","."]],
          "status": "ok"
        },
        {
          "original_text": "A kind woman offered me a cup of warm tea.",
          "translation": "一位好心的女士递给我一杯热茶。",
          "explanation": "offer sb sth 意为「给某人某物」; a cup of warm tea 是数量短语。",
          "segments": [["A","DET","a"],["kind","ADJ","kind"],["woman","NOUN","woman"],["offered","VERB","offer"],["me","PRON","I"],["a","DET","a"],["cup","NOUN","cup"],["of","ADP","of"],["warm","ADJ","warm"],["tea","NOUN","tea"],["." ,"PUNCT","."]],
          "status": "ok"
        }
      ]
    }
  ]
}"#;

/// 导入内置样书 (幂等): 把样书包写入书库输出目录并登记为译本 (original: sample-book)。
/// 向导完成页 ② 从「即将支持」变为可用: 点击 → 导入 → 进书库, 样书出现在书库并可直接打开阅读。
#[tauri::command]
pub fn sample_book_import(
    cfg: State<crate::PrepConfig>,
    db: State<store::Db>,
) -> Result<serde_json::Value, String> {
    sample_book_import_core(&cfg, db.inner())
}

/// 样书导入核心 (纯逻辑, 命令与单测共用)。
fn sample_book_import_core(
    cfg: &crate::PrepConfig,
    db: &store::Db,
) -> Result<serde_json::Value, String> {
    use crate::application::library_service::register_book;
    crate::infrastructure::log::info("cmd", "enter: sample_book_import");
    let id = "sample-book-default-1";
    let pack_dir = cfg.out_dir.join("sample-book");
    if let Some(e) = store::editions_repo::EditionsRepo::new(db).get(id) {
        // 已登记: pack 还在就直接返回; 丢了则重建
        if std::path::Path::new(&e.pack_dir)
            .join("bookpack.json")
            .is_file()
        {
            return Ok(serde_json::json!({
                "edition_id": id,
                "pack_dir": e.pack_dir,
                "already": true,
            }));
        }
    }
    std::fs::create_dir_all(&pack_dir).map_err(|e| format!("建样书目录失败: {e}"))?;
    std::fs::write(pack_dir.join("bookpack.json"), SAMPLE_BOOKPACK)
        .map_err(|e| format!("写样书包失败: {e}"))?;
    let registered = register_book(
        db,
        id.to_string(),
        &pack_dir.to_string_lossy(),
        String::new(),
        "sample-book".into(),
        "default".into(),
        "en".into(),
        "zh-CN".into(),
        None,
        None,
        None,
    );
    if registered.is_none() {
        return Err("样书登记失败 (bookpack 不完整?)".into());
    }
    crate::infrastructure::log::info("cmd", "exit: sample_book_import");
    Ok(serde_json::json!({
        "edition_id": id,
        "pack_dir": pack_dir.to_string_lossy(),
        "already": false,
    }))
}

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
    // V1 (2026-08-09): 书架阅读进度按默认 user 读 (顶栏切人后前端会在新会话按 user 拉).
    let uid = crate::store::users_repo::DEFAULT_USER_ID;
    if kind.as_deref() == Some("product") {
        let editions = store::editions_repo::EditionsRepo::new(db.inner());
        let read_repo = store::reading_repo::ReadingRepo::new(db.inner());
        let out = editions
            .list()
            .into_iter()
            .map(|e| {
                let mut v = serde_json::to_value(&e).unwrap_or_default();
                if let Some(rs) = read_repo.get(uid, &e.id) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("reading_chapter".into(), serde_json::json!(rs.chapter));
                        obj.insert("time_spent_ms".into(), serde_json::json!(rs.time_spent_ms));
                    }
                }
                attach_pack_state(&mut v);
                v
            })
            .collect::<Vec<_>>();
        return serde_json::to_value(out).map_err(|e| e.to_string());
    }
    let books = match kind.as_deref() {
        Some("original") => repo.list_by_kind("original"),
        _ => repo.list(),
    };
    // M7 R18: 附阅读进度 (跨表只读 reading_state) —— 书架显示"已读至第几章/共读多久"。
    // N+1 查询, 但书量级小 (几十本), 可接受。
    let read_repo = store::reading_repo::ReadingRepo::new(db.inner());
    let mut out: Vec<serde_json::Value> = Vec::new();
    let editions = store::editions_repo::EditionsRepo::new(db.inner());
    for b in books {
        let mut v = serde_json::to_value(&b).map_err(|e| e.to_string())?;
        let nested = editions.list_by_source(&b.id);
        let mut ev = Vec::new();
        for e in nested {
            let mut x = serde_json::to_value(&e).map_err(|e| e.to_string())?;
            if let Some(rs) = read_repo.get(uid, &e.id) {
                if let Some(o) = x.as_object_mut() {
                    o.insert("reading_chapter".into(), serde_json::json!(rs.chapter));
                    o.insert("time_spent_ms".into(), serde_json::json!(rs.time_spent_ms));
                }
            }
            // G4 (2026-08-11): 书卡信息需要 句数/音频时长 (设计「12 章 · 3 480 句 · 6h12m」)。
            // 从 edition 的 bookpack.json 轻量解析 (失败给 0, 展示性数据不阻断列表)。
            if let Some(pack_dir) = x.get("pack_dir").and_then(|p| p.as_str()) {
                let bp = std::path::Path::new(pack_dir).join("bookpack.json");
                if let Ok(text) = std::fs::read_to_string(&bp) {
                    let (sentences, audio_seconds) =
                        crate::application::library_service::parse_bookpack_counts(&text);
                    if let Some(o) = x.as_object_mut() {
                        o.insert("sentence_count".into(), serde_json::json!(sentences));
                        o.insert("audio_seconds".into(), serde_json::json!(audio_seconds));
                    }
                }
            }
            // L2 (2026-08-11): 成品文件缺失检测 —— 书卡"已就绪"必须对应磁盘上真实存在的
            // pack_dir, 否则数据没了界面还说着"已就绪"是最差情况。
            attach_pack_state(&mut x);
            ev.push(x);
        }
        if let Some(o) = v.as_object_mut() {
            o.insert("editions".into(), serde_json::Value::Array(ev));
        }
        // M1-a (2026-08-12): book 级 pack_state 由 editions 聚合得出 —— 此前只对嵌套
        // edition 调 attach_pack_state, book 对象从头到尾没有 pack_state 字段, 前端
        // 判 book.pack_state 恒 undefined, 红卡永远不渲染 (L2 修了但没作用到书卡)。
        let eds: &[serde_json::Value] = v
            .get("editions")
            .and_then(|x| x.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        if let Some(state) = aggregate_book_pack_state(eds) {
            if let Some(o) = v.as_object_mut() {
                o.insert("pack_state".into(), serde_json::json!(state));
            }
        }
        out.push(v);
    }
    serde_json::to_value(out).map_err(|e| e.to_string())
}

/// V4 (2026-08-09): 按 edition_id 查译本元信息 (背单词右栏"《书名》·第 N 章" + 跳转用)。
/// 返回 { id, title, chapter_count, source_id } 或错误 (edition 不存在)。
#[tauri::command]
pub fn edition_lookup(
    db: State<store::Db>,
    edition_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::editions_repo::EditionsRepo::new(db.inner());
    let e = repo
        .get(&edition_id)
        .ok_or_else(|| "译本不存在".to_string())?;
    Ok(serde_json::json!({
        "id": e.id,
        "title": e.title,
        "chapter_count": e.chapter_count,
        "source_id": e.source_id,
    }))
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
    let now = now_ms();
    let source_id = format!("synthetic-source-{id}");
    let books = store::books_repo::BooksRepo::new(db.inner());
    if books.get(&source_id).is_none() {
        books.upsert(&store::books_repo::Book {
            id: source_id.clone(),
            title: title.clone(),
            source_path: source_path.clone(),
            pack_dir: String::new(),
            profile_id: profile_id.clone(),
            status: "done".into(),
            kind: "original".into(),
            source_book_id: None,
            chapter_count: 0,
            failed_count: 0,
            last_opened_at: None,
            source_language: source_language.clone().unwrap_or_else(|| "en".into()),
            target_language: target_language.clone().unwrap_or_else(|| "zh-CN".into()),
            llm_id: None,
            tts_id: None,
            nlp_id: None,
            created_at: now,
            updated_at: now,
        })?;
    }
    let edition = store::editions_repo::Edition {
        id,
        source_id,
        title,
        pack_dir,
        profile_id,
        status: if failed_count > 0 {
            "partial".into()
        } else {
            "ready".into()
        },
        chapter_count,
        failed_count,
        last_opened_at: None,
        source_language: source_language.unwrap_or_else(|| "en".into()),
        target_language: target_language.unwrap_or_else(|| "zh-CN".into()),
        llm_id: None,
        tts_id: None,
        nlp_id: None,
        created_at: now,
        updated_at: now,
    };
    store::editions_repo::EditionsRepo::new(db.inner()).upsert(&edition)
}

/// L10 (2026-08-11): 书设置弹窗改学习档案 —— 只改这本书**下次生成时**的默认参数
/// (books.profile_id), 不影响已生成的译本 (editions 各自有自己的 profile_id 快照)。
#[tauri::command]
pub fn library_book_set_profile(
    db: State<store::Db>,
    book_id: String,
    profile_id: String,
) -> Result<(), String> {
    let repo = store::books_repo::BooksRepo::new(db.inner());
    let mut book = repo
        .get(&book_id)
        .ok_or_else(|| format!("书不存在: {book_id}"))?;
    book.profile_id = profile_id;
    book.updated_at = now_ms();
    repo.upsert(&book)
}

/// 删除一本书
#[tauri::command]
pub fn library_remove(
    db: State<store::Db>,
    cache: State<crate::infrastructure::bookpack_cache::BookpackCache>,
    id: String,
    delete_files: bool,
) -> Result<(), String> {
    let editions = store::editions_repo::EditionsRepo::new(db.inner());
    let packs = if editions.get(&id).is_some() {
        crate::application::library_asset_service::delete_edition(db.inner(), &id)?
    } else {
        crate::application::library_asset_service::delete_source(db.inner(), &id)?
    };
    // 阶段3 (F46): 删除后失效书包缓存, 防删了还能读到旧内容
    for p in &packs {
        cache.invalidate(p);
    }
    if delete_files {
        for p in packs {
            let _ = std::fs::remove_dir_all(p);
        }
    }
    Ok(())
}

/// 打开一本书 (登记打开时间)
#[tauri::command]
pub fn library_open(db: State<store::Db>, id: String) -> Result<serde_json::Value, String> {
    let repo = store::editions_repo::EditionsRepo::new(db.inner());
    let edition = repo.get(&id).ok_or("成品不存在")?;
    repo.touch_opened(&id, now_ms())?;
    serde_json::to_value(edition).map_err(|e| e.to_string())
}

/// M1-a (2026-08-12): book 级 pack_state 由 editions 聚合。
/// 规则: 无 edition → None (未处理书, 与本功能无关); 有 edition 且全部 ok → Some("ok");
/// 任一 missing/incomplete → 取最坏值 (missing > incomplete)。
/// 不能对 book 直接 attach_pack_state —— 原书 pack_dir 本来就是空的, 那样会把未处理的
/// 书也判成缺失。取最坏值的动机: 只要有一个译本成品丢了, 书卡就该标红提示, 而不是
/// 靠"另一个译本还好的"糊过去。
fn aggregate_book_pack_state(editions: &[serde_json::Value]) -> Option<String> {
    if editions.is_empty() {
        return None;
    }
    let rank = |s: &str| match s {
        "ok" => 0,
        "incomplete" => 1,
        _ => 2,
    };
    editions
        .iter()
        .filter_map(|e| e.get("pack_state").and_then(|p| p.as_str()))
        .max_by_key(|p| rank(p))
        .map(|p| p.to_string())
}

/// book_id → 书包所在目录(登记过的书查 DB; 否则按路径/兜底目录猜)。
/// 从 load_bookpack 提取, load_bookpack_chapter 复用同一套解析规则(两个命令必须
/// 找到同一个目录, 不能一个走 DB、一个走猜测导致"元信息"和"章节内容"不是同一本书)。
pub(crate) fn resolve_book_pack_dir(
    db: &store::Db,
    cfg: &crate::PrepConfig,
    book_id: &str,
) -> std::path::PathBuf {
    let editions = store::editions_repo::EditionsRepo::new(db);
    if let Some(e) = editions.get(book_id) {
        std::path::PathBuf::from(&e.pack_dir)
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

/// L2 (2026-08-11): 给 edition JSON 附上 `pack_state` 字段, 区分三种成品文件状态:
///   - `ok`: pack_dir 存在且 bookpack.json 在 (可读)
///   - `missing`: pack_dir 目录不存在 (991MB 事故场景 —— 数据没了)
///   - `incomplete`: 目录在但内容不全 (bookpack.json 不在/为空 —— 可能被清理过)
///
/// 书卡据此把"已就绪"改成红色「成品文件缺失」并给两个出口, 而不是点了没反应。
fn attach_pack_state(edition: &mut serde_json::Value) {
    let pack_dir = edition
        .get("pack_dir")
        .and_then(|p| p.as_str())
        .unwrap_or("");
    let state = if pack_dir.is_empty() {
        "missing".to_string()
    } else {
        let dir = std::path::Path::new(pack_dir);
        if !dir.is_dir() {
            "missing".to_string()
        } else {
            let bp = dir.join("bookpack.json");
            let complete = std::fs::metadata(&bp)
                .map(|m| m.is_file() && m.len() > 0)
                .unwrap_or(false);
            if complete {
                "ok".to_string()
            } else {
                "incomplete".to_string()
            }
        }
    };
    if let Some(o) = edition.as_object_mut() {
        o.insert("pack_state".into(), serde_json::json!(state));
    }
}

/// 把书包里每章的 sentences 换成只含 original_text 的轻量占位(供全文搜索/章节列表用)。
///
/// 修复(2026-08-07 用真实书撞见): `load_bookpack` 曾经把整本书(含每句的译文/讲解/
/// 逐词时间轴)一次性通过 IPC 传给前端。真实的《The Ultimate Hitchhiker's Guide》
/// bookpack.json 有 92MB, 92MB 字符串在前端 JS 侧 `JSON.parse` 是同步的, 会把界面主
/// 线程整个卡死好几秒甚至更久, 表现就是"点开始阅读没反应/渲染不出来"。现在只回元信息,
/// 具体某一章的完整内容(译文/讲解/时间轴)按需另调 `load_bookpack_chapter`。
///
/// N7 (2026-08-10): 这里保留的每句 `original_text` 是**有意为之**, 不是漏删 —— 它喂的是
/// 前端"全书搜索"的跨章索引 (`reader/views/reader/search.js` → `core/search_index.js`,
/// 打开书时 `ReaderSearch.build(chapters)` 一次构建)。代价: Wolf 21 实测全书 original_text
/// ≈1.3MB 随每次打开走一次 IPC。若哪天要把搜索改成按章惰性建索引(会失去跨章搜索),
/// 才能省掉这部分; 在那之前别删。
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
/// 阶段3 (F46): 解析一次后写入书包缓存, 章节加载复用, 不重复整文件读+全量解析。
#[tauri::command]
pub fn load_bookpack(
    app: tauri::AppHandle,
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    cache: State<crate::infrastructure::bookpack_cache::BookpackCache>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let repo = store::editions_repo::EditionsRepo::new(db.inner());
    let target = resolve_book_pack_dir(db.inner(), &cfg, &book_id);
    let key = target.to_string_lossy().to_string();

    let mut bookpack = match cache.get(&key) {
        Some(v) => (*v).clone(),
        None => {
            let bp_path = target.join("bookpack.json");
            let data = std::fs::read_to_string(&bp_path).map_err(|e| {
                format!(
                    "读书包失败: {e} (book_id={book_id}, target={})",
                    target.display()
                )
            })?;
            let v: serde_json::Value =
                serde_json::from_str(&data).map_err(|e| format!("书包 JSON 解析失败: {e}"))?;
            crate::domain::bookpack::check_version(&v)?;
            (*cache.put(&key, v)).clone()
        }
    };

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
            format!("synthetic-source-{auto_id}"),
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
/// 阶段3 (F46, 2026-08-09): 优先用书包缓存, 不再每章整文件重读重解析。
#[tauri::command]
pub fn load_bookpack_chapter(
    db: State<store::Db>,
    cfg: State<crate::PrepConfig>,
    cache: State<crate::infrastructure::bookpack_cache::BookpackCache>,
    book_id: String,
    chapter_index: usize,
) -> Result<serde_json::Value, String> {
    let target = resolve_book_pack_dir(db.inner(), &cfg, &book_id);
    let key = target.to_string_lossy().to_string();
    let bookpack = match cache.get(&key) {
        Some(v) => v,
        None => {
            let bp_path = target.join("bookpack.json");
            let data = std::fs::read_to_string(&bp_path)
                .map_err(|e| format!("读书包失败: {e} (book_id={book_id})"))?;
            let v: serde_json::Value =
                serde_json::from_str(&data).map_err(|e| format!("书包 JSON 解析失败: {e}"))?;
            crate::domain::bookpack::check_version(&v)?;
            cache.put(&key, v)
        }
    };
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
    fn r1_sample_book_import_is_idempotent_and_registers() {
        // R1 (UX5 #7): 内置样书导入 —— 写入 bookpack + 登记译本, 幂等 (二次导入不重复建)。
        let root = std::env::temp_dir().join(format!("aidulc_sample_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let out_dir = root.join("jobs_out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let db_path = root.join("t.db");
        let db = crate::store::Db::open(db_path.to_str().unwrap()).unwrap();
        let cfg = crate::PrepConfig {
            prep_path: root.join("prep.exe"),
            out_dir: out_dir.clone(),
            ffmpeg: std::path::PathBuf::new(),
        };
        // 首次导入
        let r = sample_book_import_core(&cfg, &db).unwrap();
        assert_eq!(r["already"], false);
        let pack = std::path::PathBuf::from(r["pack_dir"].as_str().unwrap());
        assert!(pack.join("bookpack.json").is_file(), "样书包应写入磁盘");
        // 已登记译本 + original 书
        let ed = crate::store::editions_repo::EditionsRepo::new(&db)
            .get("sample-book-default-1")
            .expect("译本应登记");
        assert_eq!(ed.source_id, "sample-book");
        assert!(crate::store::books_repo::BooksRepo::new(&db)
            .get("sample-book")
            .is_some());
        // 幂等: 二次导入直接返回 already
        let r2 = sample_book_import_core(&cfg, &db).unwrap();
        assert_eq!(r2["already"], true);
        let _ = std::fs::remove_dir_all(&root);
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

    #[test]
    fn l2_pack_state_detects_missing_incomplete_ok() {
        // L2 (2026-08-11): 成品文件缺失三态 —— missing(目录不存在) / incomplete(目录在但
        // bookpack 缺) / ok。书卡据此红色报错而不是"已就绪"点了没反应。
        let root = std::env::temp_dir().join(format!("aidulc_l2_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let missing_dir = root.join("job-gone");
        let incomplete_dir = root.join("job-incomplete");
        let ok_dir = root.join("job-ok");
        std::fs::create_dir_all(&incomplete_dir).unwrap();
        std::fs::create_dir_all(&ok_dir).unwrap();
        std::fs::write(ok_dir.join("bookpack.json"), "{}").unwrap();

        for (dir, expected) in [
            (&missing_dir, "missing"),
            (&incomplete_dir, "incomplete"),
            (&ok_dir, "ok"),
        ] {
            let mut v = serde_json::json!({ "id": "e", "pack_dir": dir.to_string_lossy() });
            attach_pack_state(&mut v);
            assert_eq!(
                v["pack_state"], expected,
                "pack_dir={dir:?} 应判为 {expected}"
            );
        }
        // pack_dir 空字符串也判 missing (避免 panic / 误判 ok)
        let mut v = serde_json::json!({ "id": "e", "pack_dir": "" });
        attach_pack_state(&mut v);
        assert_eq!(v["pack_state"], "missing");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn m1a_book_pack_state_aggregates_from_editions() {
        // M1-a (2026-08-12): book 级 pack_state 由 editions 聚合。
        // 无 edition → 不设; 全部 ok → ok; 任一坏 → 取最坏值 (missing > incomplete)。
        let e = |ps: &str| serde_json::json!({ "id": "e", "pack_state": ps });
        assert_eq!(aggregate_book_pack_state(&[]), None, "无 edition 不设");
        assert_eq!(
            aggregate_book_pack_state(&[e("ok"), e("ok")]).as_deref(),
            Some("ok"),
            "全部 ok → ok"
        );
        assert_eq!(
            aggregate_book_pack_state(&[e("ok"), e("missing")]).as_deref(),
            Some("missing"),
            "任一 missing → missing"
        );
        assert_eq!(
            aggregate_book_pack_state(&[e("ok"), e("incomplete")]).as_deref(),
            Some("incomplete"),
            "任一 incomplete → incomplete"
        );
        assert_eq!(
            aggregate_book_pack_state(&[e("incomplete"), e("missing")]).as_deref(),
            Some("missing"),
            "missing > incomplete (最坏值)"
        );
        // 缺少 pack_state 字段的 edition 不参与 (理论上 attach_pack_state 都会填)
        assert_eq!(
            aggregate_book_pack_state(&[serde_json::json!({ "id": "e" }), e("ok")]).as_deref(),
            Some("ok")
        );
    }

    #[test]
    fn l10_book_set_profile_updates_book_only_not_editions() {
        // L10 (2026-08-11): 书设置改档案 —— 只改 books.profile_id (下次生成默认),
        // 已生成译本 (editions.profile_id) 保持不动。
        let path = std::env::temp_dir().join(format!("aidulc_l10_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        let now = crate::store::now_ms_for_store();
        store::books_repo::BooksRepo::new(&db)
            .upsert(&store::books_repo::Book {
                id: "s1".into(),
                title: "Book".into(),
                source_path: "C:/b.epub".into(),
                pack_dir: String::new(),
                profile_id: "default".into(),
                status: "done".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store::editions_repo::EditionsRepo::new(&db)
            .upsert(&store::editions_repo::Edition {
                id: "e1".into(),
                source_id: "s1".into(),
                title: "译本".into(),
                pack_dir: "p".into(),
                profile_id: "default".into(),
                status: "ready".into(),
                chapter_count: 1,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        drop(db);

        // 直接调命令层逻辑 (State 由 tauri 注入, 单测里走 repo)
        let db = crate::store::Db::open(path.to_str().unwrap()).unwrap();
        let books = store::books_repo::BooksRepo::new(&db);
        let mut b = books.get("s1").unwrap();
        b.profile_id = "kid".into();
        b.updated_at = now;
        books.upsert(&b).unwrap();
        let edition = store::editions_repo::EditionsRepo::new(&db)
            .get("e1")
            .unwrap();
        assert_eq!(edition.profile_id, "default", "已生成译本档案不动");
        let book2 = books.get("s1").unwrap();
        assert_eq!(book2.profile_id, "kid", "书的默认档案更新");
        let _ = std::fs::remove_file(&path);
    }
}

/// 阶段3 (F46) 回归测试: 真实书包解析路径 —— 用磁盘上的真实 bookpack.json 验证
/// 元信息加载 + 按章取内容 + 缓存复用(读文件只发生一次)。
#[cfg(test)]
mod bookpack_path_tests {
    use std::io::Write;

    /// 按包目录解析书包并走缓存 —— 与 load_bookpack_chapter 同路径的独立可测函数。
    fn cached_bookpack_and_chapter(
        cache: &crate::infrastructure::bookpack_cache::BookpackCache,
        pack_dir: &std::path::Path,
        chapter_index: usize,
    ) -> Result<(String, serde_json::Value, serde_json::Value), String> {
        let key = pack_dir.to_string_lossy().to_string();
        let bookpack = match cache.get(&key) {
            Some(v) => (*v).clone(),
            None => {
                let bp_path = pack_dir.join("bookpack.json");
                let data =
                    std::fs::read_to_string(&bp_path).map_err(|e| format!("读书包失败: {e}"))?;
                let v: serde_json::Value =
                    serde_json::from_str(&data).map_err(|e| format!("书包 JSON 解析失败: {e}"))?;
                crate::domain::bookpack::check_version(&v)?;
                (*cache.put(&key, v)).clone()
            }
        };
        let chapter = bookpack
            .get("chapters")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.get(chapter_index))
            .cloned()
            .ok_or_else(|| format!("章节下标越界: {chapter_index}"))?;
        Ok((key, bookpack, chapter))
    }

    fn write_sample_pack(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        let bp = serde_json::json!({
            "schemaVersion": 1,
            "title": "Regr",
            "profile": {"id": "default", "name": "成人自读"},
            "generatedAt": "1700000000000",
            "prepVersion": "0.1.0",
            "chapters": [
                {
                    "index": 0, "title": "C0", "audioFile": "audio/ch_000.opus",
                    "sentences": [{ "original_text": "One.", "translation": "一。", "segments": [["One","NUM","one"]], "audio": {"chapter":0,"start_ms":0,"end_ms":500} }]
                },
                {
                    "index": 1, "title": "C1", "audioFile": "audio/ch_001.opus",
                    "sentences": [{ "original_text": "Two.", "translation": "二。", "segments": [["Two","NUM","two"]], "audio": {"chapter":1,"start_ms":500,"end_ms":1000} }]
                }
            ],
            "quality": {"stages": {}},
            "models": {}
        });
        let mut f = std::fs::File::create(dir.join("bookpack.json")).unwrap();
        f.write_all(serde_json::to_string(&bp).unwrap().as_bytes())
            .unwrap();
    }

    #[test]
    fn chapter_load_uses_cache_and_returns_requested_chapter() {
        let dir = std::env::temp_dir().join(format!("aidulc_bpc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_sample_pack(&dir);
        let cache = crate::infrastructure::bookpack_cache::BookpackCache::new();

        // 第一次: 从磁盘解析并入缓存
        let (key, bp, ch0) = cached_bookpack_and_chapter(&cache, &dir, 0).unwrap();
        assert_eq!(ch0["title"], "C0");
        assert_eq!(bp["chapters"].as_array().unwrap().len(), 2);
        assert!(cache.get(&key).is_some(), "解析后应写入缓存");
        assert_eq!(cache.len(), 1);

        // 第二次: 命中缓存 (若缓存失效会返回 Err"章节下标越界", 这里应正常返回)
        let (_k2, _bp2, ch1) = cached_bookpack_and_chapter(&cache, &dir, 1).unwrap();
        assert_eq!(ch1["title"], "C1");
        assert_eq!(cache.len(), 1, "缓存复用不应新增条目");

        // 越界章 → 明确错误而非 panic
        assert!(cached_bookpack_and_chapter(&cache, &dir, 99).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalidate_after_delete_prevents_stale_read() {
        let dir = std::env::temp_dir().join(format!("aidulc_bpd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_sample_pack(&dir);
        let cache = crate::infrastructure::bookpack_cache::BookpackCache::new();
        cached_bookpack_and_chapter(&cache, &dir, 0).unwrap();
        assert!(cache.get(&dir.to_string_lossy().as_ref()).is_some());
        cache.invalidate(&dir.to_string_lossy().to_string());
        assert!(
            cache.get(&dir.to_string_lossy().as_ref()).is_none(),
            "删除后应失效缓存"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
    let repo = store::editions_repo::EditionsRepo::new(db.inner());
    let book = repo.get(&id).ok_or("成品不存在")?;
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
        format!("synthetic-source-{new_id}"),
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
