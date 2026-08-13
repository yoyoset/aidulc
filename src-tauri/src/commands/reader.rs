//! commands/reader.rs —— 阅读会话相关命令 (整本在线翻译 + 书签)
//! 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 原文件把词典/生词本/背单词/
//! 同步后端管理/日志五个不相关域全挤在一起(1710 行), 已拆到 commands/vocab.rs、
//! commands/sync_backend.rs、commands/log.rs。这里只留真正"阅读"相关的命令。

use crate::store;
use tauri::State;

/// L8② (2026-08-13): 整本在线翻译/讲解 —— 前端「整本翻译/讲解(在线)」入口确认后调用。
/// 逐句调在线引擎, 生成一个无音频的"在线版"译本并登记 (复用 register_book)。
/// 权限护栏: 只有 online_whole_book_enabled 为真且 endpoint+key 配置齐才放行 (L8 ②开关);
/// 每本的外发量由前端在确认框里显示 (全书正文可能很大)。
#[tauri::command]
pub async fn book_online_translate(
    db: State<'_, store::Db>,
    cfg: State<'_, crate::PrepConfig>,
    paths: State<'_, crate::DataPaths>,
    book_id: String,
) -> Result<serde_json::Value, String> {
    crate::infrastructure::log::info("cmd", &format!("enter: book_online_translate {book_id}"));
    let cfg_dir = paths.inner().data_dir.clone();
    let conf = crate::services::config::Config::load(&cfg_dir);
    if !conf.online_whole_book_enabled {
        return Err(
            "整本在线翻译未开启: 请先在 设置 → 在线引擎 勾选 ② 整本翻译/讲解 并保存".into(),
        );
    }
    let key = crate::services::credentials::get_online_key().unwrap_or_default();
    if key.is_empty() {
        return Err("在线引擎未配置 API key".into());
    }
    let endpoint = conf.online_endpoint.clone();
    if endpoint.is_empty() {
        return Err("在线引擎未配置 endpoint".into());
    }
    let model = if conf.online_model.trim().is_empty() {
        "deepseek-v4-flash".to_string()
    } else {
        conf.online_model.trim().to_string()
    };

    // 找源书包: book_id 是译本 → 它的 pack; 是原书 → 第一本有 pack 的译本
    let editions_repo = store::editions_repo::EditionsRepo::new(db.inner());
    let source = if let Some(e) = editions_repo.get(&book_id) {
        if e.pack_dir.is_empty() {
            None
        } else {
            Some((
                e.pack_dir.clone(),
                e.source_id.clone(),
                e.profile_id.clone(),
                e.source_language.clone(),
                e.target_language.clone(),
            ))
        }
    } else {
        store::books_repo::BooksRepo::new(db.inner())
            .get(&book_id)
            .and_then(|_| {
                let eds = editions_repo.list_by_source(&book_id);
                eds.into_iter().find(|e| !e.pack_dir.is_empty()).map(|e| {
                    (
                        e.pack_dir.clone(),
                        book_id.clone(),
                        e.profile_id.clone(),
                        e.source_language.clone(),
                        e.target_language.clone(),
                    )
                })
            })
    };
    let Some((source_pack, source_id, profile_id, src_lang, tgt_lang)) = source else {
        return Err("这本书还没有可用的译本文件, 无法在线整本翻译 (请先创建译本)".into());
    };
    if !std::path::Path::new(&source_pack)
        .join("bookpack.json")
        .is_file()
    {
        return Err("源译本的文件缺失, 无法在线整本翻译".into());
    }

    let source_pack_buf = source_pack.clone();
    let endpoint2 = endpoint.clone();
    let key2 = key.clone();
    let model2 = model.clone();
    let ts = crate::store::now_ms_for_store();
    let new_id = format!("online-{book_id}-{ts}");
    let out_root = cfg.out_dir.clone();
    let new_pack = out_root.join(&new_id);
    let pack_for_block = new_pack.clone();
    let (done, failed) = tauri::async_runtime::spawn_blocking(move || {
        let text =
            std::fs::read_to_string(std::path::Path::new(&source_pack_buf).join("bookpack.json"))
                .map_err(|e| format!("读源书包失败: {e}"))?;
        let mut bp: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("解析源书包失败: {e}"))?;
        if let Some(obj) = bp.as_object_mut() {
            let title = obj
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            obj.insert(
                "title".into(),
                serde_json::json!(format!("{title} · 在线版")),
            );
        }
        let (d, f) = crate::infrastructure::online_client::translate_book(
            &endpoint2, &key2, &model2, &mut bp,
        )?;
        std::fs::create_dir_all(&pack_for_block).map_err(|e| format!("建在线译本目录失败: {e}"))?;
        std::fs::write(
            pack_for_block.join("bookpack.json"),
            serde_json::to_string_pretty(&bp).map_err(|e| format!("序列化在线译本失败: {e}"))?,
        )
        .map_err(|e| format!("写在线译本失败: {e}"))?;
        Ok::<(usize, usize), String>((d, f))
    })
    .await
    .map_err(|e| format!("在线翻译任务执行失败: {e}"))??;

    let registered = crate::application::library_service::register_book(
        db.inner(),
        new_id.clone(),
        &new_pack.to_string_lossy(),
        String::new(),
        source_id.clone(),
        profile_id,
        src_lang,
        tgt_lang,
        Some(format!("online|{model}")),
        None,
        None,
    );
    if registered.is_none() {
        return Err("在线译本登记失败".into());
    }
    crate::infrastructure::log::info(
        "cmd",
        &format!("book_online_translate done: {done} ok {failed} failed"),
    );
    Ok(serde_json::json!({
        "edition_id": new_id,
        "pack_dir": new_pack.to_string_lossy(),
        "sentences_done": done,
        "sentences_failed": failed,
        "model": model,
        "source_id": source_id,
    }))
}

/// 书签列表 (本书所有书签句子)
#[tauri::command]
pub fn bookmarks_list(
    db: State<store::Db>,
    book_key: String,
    user_id: String,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let repo = store::reading_repo::ReadingRepo::new(db.inner());
    let state = repo.get(&user_id, &book_key);
    // 返回带句文本的书签 (前端从 bookpack 拿文本; 这里先返回下标)
    Ok(serde_json::json!({
        "book_key": book_key,
        "profile_id": profile_id,
        "bookmarks": state.map(|s| s.bookmarks).unwrap_or_default(),
    }))
}
