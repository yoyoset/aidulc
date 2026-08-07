//! application/model_service.rs —— 模型管理用例层 (H2)
//!
//! 职责: 登记/推荐/选择/绑定/移除/复用扫描/下载注册
//! 语言作为参数传入, 不写死 en —— 结构多语言化, 验收聚焦英文。

use crate::store::model_repo::{ModelEntry, ModelRepo};
use crate::store::Db;

/// 模型家族
pub const FAMILY_LLM: &str = "llm";
pub const FAMILY_TTS: &str = "tts";
pub const FAMILY_NLP: &str = "nlp";

/// 构造注册表 id: family|language|model_id|version
pub fn entry_id(family: &str, language: &str, model_id: &str, version: &str) -> String {
    format!("{family}|{language}|{model_id}|{version}")
}

/// 推荐: 某语言某家族的 active 模型 (无 active 则第一个已装)
pub fn recommend_for(db: &Db, family: &str, language: &str) -> Option<ModelEntry> {
    let repo = ModelRepo::new(db);
    let list = repo.list_by(family, language);
    list.into_iter()
        .find(|m| m.active)
        .or_else(|| repo.list_by(family, language).into_iter().next())
}

/// 推荐整套组合 (llm/tts/nlp)
pub fn recommend_bundle(
    db: &Db,
    language: &str,
) -> (Option<ModelEntry>, Option<ModelEntry>, Option<ModelEntry>) {
    (
        recommend_for(db, FAMILY_LLM, language),
        recommend_for(db, FAMILY_TTS, language),
        recommend_for(db, FAMILY_NLP, language),
    )
}

/// M 系列 (单一真相源): 解析某语言的运行时模型路径 (llm, tts, spacy)。
/// 全部来自 model_registry 推荐 (active); 不再读 config.toml 第二份状态。
/// 返回的 String 可能为空 = 该家族未注册模型。
pub fn resolve_paths(db: &Db, language: &str) -> (String, String, String) {
    let (llm, tts, nlp) = recommend_bundle(db, language);
    (
        llm.map(|m| m.path).unwrap_or_default(),
        tts.map(|m| m.path).unwrap_or_default(),
        nlp.map(|m| m.path).unwrap_or_default(),
    )
}

/// M 系列: 是否已有该语言的完整模型组合 (llm + tts 必填, nlp 可选)
// TODO(未接线): 写了测试(见 tests 模块)但没有任何 command/前端调用它, preflight_check
// 可能已覆盖同等语义 —— 接线前先确认是否与 preflight_check 重复, 避免留两套判定。
#[allow(dead_code)]
pub fn bundle_complete(db: &Db, language: &str) -> bool {
    let (llm, tts, _) = resolve_paths(db, language);
    !llm.is_empty() && !tts.is_empty()
}

/// 登记 (安装/复用后写入注册表); 若该家族语言无 active, 自动设为推荐
pub fn register(db: &Db, m: &mut ModelEntry) -> Result<(), String> {
    let repo = ModelRepo::new(db);
    let has_active = repo
        .list_by(&m.family, &m.language)
        .iter()
        .any(|x| x.active);
    if !has_active {
        m.active = true;
    }
    repo.upsert(m)
}

/// 设置推荐 (同一家族语言内把 active 唯一化)
pub fn set_recommended(db: &Db, id: &str) -> Result<(), String> {
    let repo = ModelRepo::new(db);
    let target = repo.get(id).ok_or("模型不存在")?;
    for other in repo.list_by(&target.family, &target.language) {
        if other.active {
            let mut o = other.clone();
            o.active = false;
            repo.upsert(&o)?;
        }
    }
    let mut t = target.clone();
    t.active = true;
    repo.upsert(&t)
}

/// 移除 (不被任何书绑定时可删)
pub fn remove(db: &Db, id: &str) -> Result<(), String> {
    let repo = ModelRepo::new(db);
    repo.remove(id)
}

/// 绑定书到模型组合 (书级: 语言/模型跟随书)
pub fn bind_book(
    db: &Db,
    book_id: &str,
    source_lang: &str,
    target_lang: &str,
    llm_id: Option<String>,
    tts_id: Option<String>,
    nlp_id: Option<String>,
) -> Result<(), String> {
    let repo = crate::store::books_repo::BooksRepo::new(db);
    let mut book = repo.get(book_id).ok_or("书不存在")?;
    book.source_language = source_lang.into();
    book.target_language = target_lang.into();
    book.llm_id = llm_id;
    book.tts_id = tts_id;
    book.nlp_id = nlp_id;
    book.updated_at = crate::store::now_ms_for_store();
    repo.upsert(&book)
}

/// 读书的语言+模型绑定 (无绑定返回默认值, 供书设置弹窗回显)
pub fn book_binding(db: &Db, book_id: &str) -> serde_json::Value {
    let repo = crate::store::books_repo::BooksRepo::new(db);
    match repo.get(book_id) {
        Some(b) => serde_json::json!({
            "book_id": b.id,
            "source_language": b.source_language,
            "target_language": b.target_language,
            "llm_id": b.llm_id,
            "tts_id": b.tts_id,
            "nlp_id": b.nlp_id,
        }),
        None => serde_json::json!({"book_id": book_id}),
    }
}

/// 按书解析运行时模型路径 (llm, tts, spacy)。
/// 书级绑定 (llm_id/tts_id) 优先; 未绑定的家族回落到该书语言的全局推荐。
/// M5 单一真相源 + 书级覆盖层。
pub fn resolve_for_book(db: &Db, book_id: &str, lang: &str) -> (String, String, String) {
    let repo = crate::store::books_repo::BooksRepo::new(db);
    let book = repo.get(book_id);
    let mut llm = String::new();
    let mut tts = String::new();
    let mut nlp = String::new();
    let model_repo = ModelRepo::new(db);
    if let Some(b) = book {
        if let Some(id) = &b.llm_id {
            if let Some(m) = model_repo.get(id) {
                llm = m.path;
            }
        }
        if let Some(id) = &b.tts_id {
            if let Some(m) = model_repo.get(id) {
                tts = m.path;
            }
        }
        if let Some(id) = &b.nlp_id {
            if let Some(m) = model_repo.get(id) {
                nlp = m.path;
            }
        }
    }
    // 书级缺失的家族 → 全局推荐按语言回落
    if llm.is_empty() {
        llm = resolve_paths(db, lang).0;
    }
    if tts.is_empty() {
        tts = resolve_paths(db, lang).1;
    }
    if nlp.is_empty() {
        nlp = resolve_paths(db, lang).2;
    }
    (llm, tts, nlp)
}

/// 书级模型是否完整 (llm + tts)
// TODO(未接线): 同 bundle_complete, 写了测试但没有调用方, 可能与下方 preflight_check 重复。
#[allow(dead_code)]
pub fn book_bundle_complete(db: &Db, book_id: &str, lang: &str) -> bool {
    let (llm, tts, _) = resolve_for_book(db, book_id, lang);
    !llm.is_empty() && !tts.is_empty()
}

/// 可处理性检查 (R2/S3): 一本书能否开始阅读准备。
/// 返回结构化原因列表 (空 = 可处理)。检查项: 书文件/模型注册/模型文件/侧车/侧车可执行/ffmpeg。
pub fn preflight_check(
    db: &Db,
    book_id: &str,
    book_path: &str,
    lang: &str,
    prep_path: &std::path::Path,
    ffmpeg: &std::path::Path,
) -> Vec<String> {
    let mut problems = Vec::new();
    // 1. 原书文件存在
    if !book_path.is_empty() && !std::path::Path::new(book_path).exists() {
        problems.push("原书文件不存在, 请重新导入".into());
    }
    // 2. 模型注册 + 文件存在 (书级绑定优先 → 全局推荐)
    let (llm, tts, _nlp) = resolve_for_book(db, book_id, lang);
    if llm.is_empty() {
        problems.push("缺翻译引擎 (LLM), 请到模型中心配置".into());
    } else if !std::path::Path::new(&llm).exists() {
        problems.push(format!("翻译引擎文件丢失: {llm}"));
    }
    if tts.is_empty() {
        problems.push("缺语音引擎 (TTS), 请到模型中心配置".into());
    } else if !std::path::Path::new(&tts).exists() {
        problems.push(format!("语音引擎文件丢失: {tts}"));
    }
    // 3. 侧车存在
    if !prep_path.exists() {
        problems.push(format!("处理引擎未就绪 (找不到 {}", prep_path.display()));
    } else if !prep_path.is_file() {
        problems.push("处理引擎路径不是文件".into());
    }
    // 4. ffmpeg (打包阶段必需)
    if !ffmpeg.as_os_str().is_empty() && !ffmpeg.exists() {
        problems.push(format!("ffmpeg 未就绪 (找不到 {}", ffmpeg.display()));
    }
    problems
}

/// 批次可处理性检查: 逐书 preflight, 返回 (可入队书, 跳过书+原因)
pub fn preflight_batch(
    db: &Db,
    books: &[serde_json::Value],
    prep_path: &std::path::Path,
    ffmpeg: &std::path::Path,
) -> (Vec<String>, Vec<serde_json::Value>) {
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    for b in books {
        let id = b
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let path = b
            .get("source_path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let lang = b
            .get("source_language")
            .and_then(|x| x.as_str())
            .unwrap_or("en")
            .to_string();
        let problems = preflight_check(db, &id, &path, &lang, prep_path, ffmpeg);
        if problems.is_empty() {
            ok.push(id);
        } else {
            skipped.push(serde_json::json!({ "book_id": id, "reasons": problems }));
        }
    }
    (ok, skipped)
}

/// 扫描已有模型目录 → 返回可复用候选 (供 UI 展示/一键登记)
pub fn scan_and_suggest(db: &Db, model_dir: &str) -> Vec<serde_json::Value> {
    use crate::infrastructure::model_store::scan::scan_model_dir;
    let found = scan_model_dir(model_dir);
    let repo = ModelRepo::new(db);
    found
        .into_iter()
        .filter_map(|m| {
            // 已登记的同路径跳过
            if repo.list_all().iter().any(|e| e.path == m.path) {
                return None;
            }
            Some(serde_json::json!({
                "path": m.path,
                "file_name": m.file_name,
                "size_bytes": m.size_bytes,
                "layout": m.layout,
                "repo_id": m.repo_id,
                "commit_sha": m.commit_sha,
                "registered": false,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_ms_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn entry(family: &str, lang: &str, model: &str, active: bool) -> ModelEntry {
        ModelEntry {
            id: entry_id(family, lang, model, "1.0"),
            family: family.into(),
            language: lang.into(),
            model_id: model.into(),
            version: "1.0".into(),
            variant: "cuda12.4".into(),
            path: format!("C:/models/{model}"),
            source_type: "hf".into(),
            source_ref: "r".into(),
            commit_sha: "".into(),
            sha256: "".into(),
            size_bytes: 100,
            installed_at: 100,
            active,
            custom: false,
        }
    }

    #[test]
    fn recommend_picks_active() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "qwen", false)).unwrap();
        repo.upsert(&entry("llm", "en", "sakura", true)).unwrap();
        let r = recommend_for(&db, "llm", "en").unwrap();
        assert_eq!(r.model_id, "sakura");
    }

    #[test]
    fn recommend_falls_back_to_first() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "qwen", false)).unwrap();
        let r = recommend_for(&db, "llm", "en").unwrap();
        assert_eq!(r.model_id, "qwen", "无 active 时取第一个");
    }

    #[test]
    fn first_registered_becomes_recommended() {
        let db = temp_db();
        let mut e = entry("tts", "en", "kokoro", false);
        register(&db, &mut e).unwrap();
        let repo = ModelRepo::new(&db);
        assert!(repo.get(&e.id).unwrap().active, "首个登记应自动推荐");
    }

    #[test]
    fn set_recommended_unique_per_family_lang() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "qwen", true)).unwrap();
        repo.upsert(&entry("llm", "en", "sakura", false)).unwrap();
        set_recommended(&db, "llm|en|sakura|1.0").unwrap();
        let list = repo.list_by("llm", "en");
        assert_eq!(
            list.iter().filter(|m| m.active).count(),
            1,
            "同一家族语言至多一个推荐"
        );
        assert!(repo.get("llm|en|sakura|1.0").unwrap().active);
    }

    #[test]
    fn resolve_paths_from_registry() {
        // M 系列核心: 单一真相源 — 组件检查/导入/查词全部从这里拿路径
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "qwen", true)).unwrap();
        repo.upsert(&entry("tts", "en", "kokoro", true)).unwrap();
        let (llm, tts, _) = resolve_paths(&db, "en");
        assert_eq!(llm, "C:/models/qwen", "LLM 来自注册表");
        assert_eq!(tts, "C:/models/kokoro", "TTS 来自注册表");
        assert!(bundle_complete(&db, "en"));
    }

    #[test]
    fn resolve_paths_empty_when_unregistered() {
        let db = temp_db();
        let (llm, tts, _) = resolve_paths(&db, "en");
        assert!(llm.is_empty() && tts.is_empty());
        assert!(!bundle_complete(&db, "en"));
    }

    #[test]
    fn bind_book_sets_language_and_models() {
        let db = temp_db();
        let books = crate::store::books_repo::BooksRepo::new(&db);
        books
            .upsert(&crate::store::books_repo::Book {
                id: "b1".into(),
                title: "B".into(),
                source_path: "".into(),
                pack_dir: "".into(),
                profile_id: "default".into(),
                status: "ready".into(),
                kind: "product".into(),
                source_book_id: None,
                chapter_count: 1,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 100,
                updated_at: 100,
            })
            .unwrap();
        bind_book(
            &db,
            "b1",
            "ja",
            "zh-CN",
            Some("llm|ja|qwen|1.0".into()),
            None,
            None,
        )
        .unwrap();
        let b = books.get("b1").unwrap();
        assert_eq!(b.source_language, "ja");
        assert_eq!(b.llm_id.as_deref(), Some("llm|ja|qwen|1.0"));
    }

    #[test]
    fn resolve_for_book_binding_overrides_global() {
        // P1 核心: 书级绑定优先, 未绑定家族回落全局推荐
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "global_llm", true))
            .unwrap();
        repo.upsert(&entry("tts", "en", "global_tts", true))
            .unwrap();
        repo.upsert(&entry("llm", "en", "book_llm", false)).unwrap();
        let books = crate::store::books_repo::BooksRepo::new(&db);
        books
            .upsert(&crate::store::books_repo::Book {
                id: "b1".into(),
                title: "B".into(),
                source_path: "".into(),
                pack_dir: "".into(),
                profile_id: "default".into(),
                status: "pending".into(),
                kind: "original".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: Some("llm|en|book_llm|1.0".into()),
                tts_id: None,
                nlp_id: None,
                created_at: 100,
                updated_at: 100,
            })
            .unwrap();
        let (llm, tts, _) = resolve_for_book(&db, "b1", "en");
        assert_eq!(llm, "C:/models/book_llm", "书级绑定优先");
        assert_eq!(tts, "C:/models/global_tts", "未绑定家族回落全局推荐");
        assert!(book_bundle_complete(&db, "b1", "en"));
    }

    #[test]
    fn book_binding_echo() {
        let db = temp_db();
        let books = crate::store::books_repo::BooksRepo::new(&db);
        books
            .upsert(&crate::store::books_repo::Book {
                id: "b2".into(),
                title: "B2".into(),
                source_path: "".into(),
                pack_dir: "".into(),
                profile_id: "default".into(),
                status: "ready".into(),
                kind: "product".into(),
                source_book_id: None,
                chapter_count: 1,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 100,
                updated_at: 100,
            })
            .unwrap();
        let v = book_binding(&db, "b2");
        assert_eq!(v["source_language"], "en");
        assert!(v["llm_id"].is_null());
    }

    #[test]
    fn preflight_reports_missing_models_and_sidecar() {
        // R2: 可处理性检查 — 无模型/无侧车 → 结构化原因
        let db = temp_db();
        let problems = preflight_check(
            &db,
            "b1",
            "C:/nonexistent/book.txt",
            "en",
            std::path::Path::new("C:/nonexistent/prep.exe"),
            std::path::Path::new("C:/nonexistent/ffmpeg.exe"),
        );
        assert!(
            problems.iter().any(|p| p.contains("原书文件")),
            "应报书文件缺失: {problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("翻译引擎")),
            "应报缺 LLM"
        );
        assert!(
            problems.iter().any(|p| p.contains("语音引擎")),
            "应报缺 TTS"
        );
        assert!(
            problems.iter().any(|p| p.contains("处理引擎")),
            "应报缺侧车"
        );
    }

    #[test]
    fn preflight_ok_with_registered_models() {
        // R2: 模型已注册 → 不再报"缺引擎" (文件存在性另查)
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        repo.upsert(&entry("llm", "en", "qwen", true)).unwrap();
        repo.upsert(&entry("tts", "en", "kokoro", true)).unwrap();
        let problems = preflight_check(
            &db,
            "b1",
            "",
            "en",
            std::path::Path::new("C:/nonexistent/prep.exe"),
            std::path::Path::new(""),
        );
        assert!(
            problems
                .iter()
                .all(|p| !p.contains("缺翻译引擎") && !p.contains("缺语音引擎")),
            "模型已注册不应报缺引擎: {problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("文件丢失")),
            "注册路径无效应报文件丢失"
        );
    }

    #[test]
    fn preflight_batch_partitions() {
        // R2: 批次检查分区 (可入队 vs 跳过+原因)
        let db = temp_db();
        let books = vec![
            serde_json::json!({"id": "ok1", "source_path": "", "source_language": "en"}),
            serde_json::json!({"id": "bad1", "source_path": "C:/gone.txt", "source_language": "en"}),
        ];
        let (ok, skipped) = preflight_batch(
            &db,
            &books,
            std::path::Path::new("C:/nope.exe"),
            std::path::Path::new(""),
        );
        assert!(ok.is_empty(), "无模型时都不应入队");
        assert_eq!(skipped.len(), 2);
        assert_eq!(skipped[0]["book_id"], "ok1");
        assert!(skipped[0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r.as_str().unwrap().contains("翻译引擎")));
    }
}
