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

/// 推荐: 某语言某家族的 active 模型 (无 active 则第一个已装)。
/// 一次 list_by (不再查两遍: 旧实现 find(active) 落空后再 list_by 一次 = 双锁双查询)。
pub fn recommend_for(db: &Db, family: &str, language: &str) -> Option<ModelEntry> {
    let list = ModelRepo::new(db).list_by(family, language);
    let first = list.first().cloned();
    list.into_iter().find(|m| m.active).or(first)
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

/// 登记 (安装/复用后写入注册表); 若该家族语言无 active, 自动设为推荐。
/// UX5 修正 (2026-08-13): **自定义/扫描登记 (custom=true) 不再自动设推荐** —— 扫描扫到的
/// 文件家族可能误判 (whisper/silero/OCR 被当 tts), 自动推荐会让任务一路跑到 TTS 阶段才炸
/// (用户实测: manga-ocr 的 pytorch_model 被扫成 tts 自动当上推荐 → voices 不存在)。只有
/// 官方下载 (custom=false) 自动推荐; 扫描登记需用户显式「设为推荐」(模型页会标"未设推荐")。
/// UX5 修正 (2026-08-13): **不完整的 TTS 直接拒绝登记** —— 平铺 kokoro-v1_0.pth (同目录
/// 缺 config.json/voices) 登记进去之后任务跑到 TTS 阶段才炸, 不如登记时立刻给可操作错误。
pub fn register(db: &Db, m: &mut ModelEntry) -> Result<(), String> {
    if m.family == FAMILY_TTS && std::path::Path::new(&m.path).is_file() && !tts_complete(&m.path) {
        return Err(format!(
            "语音模型不完整: {} 同目录缺 config.json 或 voices/。Kokoro 需要 模型文件+config.json+voices/ 同目录 —— 请指向 HF 缓存里完整的 models--hexgrad--Kokoro-82M/snapshots/<sha>/ 目录内的 kokoro-v1_0.pth。",
            m.path
        ));
    }
    let repo = ModelRepo::new(db);
    let has_active = repo
        .list_by(&m.family, &m.language)
        .iter()
        .any(|x| x.active);
    if !m.custom && !has_active {
        m.active = true;
    }
    repo.upsert(m)
}

/// Kokoro TTS 完整性: 模型文件同目录必须有 config.json + voices/ 目录 (引擎硬校验, 见
/// prep/pipeline/tts/engine.py)。与 preflight_check 的 TTS 完整性分支同判据, 登记时更早拦截。
pub fn tts_complete(path: &str) -> bool {
    let dir = std::path::Path::new(path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    dir.join("config.json").is_file() && dir.join("voices").is_dir()
}

/// UX5 修正 (2026-08-13): 模型完整性校验已内联进 preflight_check (每本书前置检查), 见
/// preflight_check 的 TTS 完整性分支 (config.json + voices/)。这里不再保留独立函数。
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

/// K15 (2026-08-14): 移除 + 可选顺带删磁盘文件——之前 remove() 只删注册表那一行,
/// LLM/TTS 模型几 GB 级, 换一次模型/升一次版本磁盘只涨不消。`delete_files=true`
/// 时先查绑定数, 仍被书绑定就拒绝(不能删还在用的文件); 磁盘删除失败会如实报错,
/// 不静默吞掉(不然用户以为清理成功、下次还是发现磁盘没变化)。
pub fn remove_with_files(db: &Db, id: &str, delete_files: bool) -> Result<(), String> {
    let repo = ModelRepo::new(db);
    let model = repo
        .list_all_with_bound()
        .into_iter()
        .find(|(m, _)| m.id == id);
    let Some((entry, bound)) = model else {
        return Err("模型不存在".into());
    };
    if delete_files && bound > 0 {
        return Err(format!(
            "这个模型仍被 {bound} 本书绑定, 不能删磁盘文件(可以先解绑或只删注册表记录)"
        ));
    }
    repo.remove(id)?;
    if delete_files && !entry.path.trim().is_empty() {
        let path = std::path::Path::new(&entry.path);
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("注册表已移除, 但删磁盘文件失败: {e}"))?;
        }
    }
    Ok(())
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
    let editions = crate::store::editions_repo::EditionsRepo::new(db);
    if let Some(mut e) = editions.get(book_id) {
        e.source_language = source_lang.into();
        e.target_language = target_lang.into();
        e.llm_id = llm_id;
        e.tts_id = tts_id;
        e.nlp_id = nlp_id;
        e.updated_at = crate::store::now_ms_for_store();
        return editions.upsert(&e);
    }
    // Legacy source-only records remain readable; new product records never use this path.
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
    let editions = crate::store::editions_repo::EditionsRepo::new(db);
    match editions.get(book_id) {
        Some(e) => serde_json::json!({
            "book_id": e.id, "source_language": e.source_language, "target_language": e.target_language,
            "llm_id": e.llm_id, "tts_id": e.tts_id, "nlp_id": e.nlp_id,
        }),
        None => {
            let repo = crate::store::books_repo::BooksRepo::new(db);
            match repo.get(book_id) {
                Some(b) => {
                    serde_json::json!({"book_id":b.id,"source_language":b.source_language,"target_language":b.target_language,"llm_id":b.llm_id,"tts_id":b.tts_id,"nlp_id":b.nlp_id})
                }
                None => serde_json::json!({"book_id": book_id}),
            }
        }
    }
}

/// 按书解析运行时模型路径 (llm, tts, spacy)。
/// 书级绑定 (llm_id/tts_id) 优先; 未绑定的家族回落到该书语言的全局推荐。
/// M5 单一真相源 + 书级覆盖层。
pub fn resolve_for_book(db: &Db, book_id: &str, lang: &str) -> (String, String, String) {
    let edition = crate::store::editions_repo::EditionsRepo::new(db).get(book_id);
    let repo = crate::store::books_repo::BooksRepo::new(db);
    let book = repo.get(book_id);
    let mut llm = String::new();
    let mut tts = String::new();
    let mut nlp = String::new();
    let model_repo = ModelRepo::new(db);
    if let Some(b) = edition.as_ref() {
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
    } else if let Some(b) = book {
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
    // 0. 格式支持 (R3.3, 2026-08-08): 处理前就告知不支持, 不在阅读整理时才报。
    //    与 prep/pipeline/loader 的 SUPPORTED_EXT 对齐: epub(原生)/pdf/mobi/azw3/fb2(PyMuPDF)/txt。
    if !book_path.is_empty() {
        let ext = std::path::Path::new(book_path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        const SUPPORTED: &[&str] = &["epub", "pdf", "mobi", "azw3", "fb2", "txt"];
        if !SUPPORTED.contains(&ext.as_str()) {
            problems.push(format!(
                "不支持的文件格式: .{ext} (支持 epub/pdf/mobi/azw3/fb2/txt)"
            ));
        }
    }
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
    } else {
        // UX5 修正 (2026-08-13): TTS 完整性 —— Kokoro 需要 模型文件+config.json+voices/ 同目录,
        // 否则任务一路跑到 TTS 阶段才炸 (扫到的假 tts 只查"文件存在"也能通过, 用户实测撞见)。
        if !tts_complete(&tts) {
            problems.push(format!(
                "语音模型不完整: {} 同目录缺 config.json 或 voices/ (Kokoro 需要 模型+config.json+voices/ 同目录)。到模型中心把推荐 TTS 指向 HF 缓存里完整的 models--hexgrad--Kokoro-82M/snapshots/<sha>/kokoro-v1_0.pth, 或直接下载推荐引擎。",
                tts
            ));
        }
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
    let registered_paths: std::collections::HashSet<String> =
        repo.list_all().iter().map(|e| e.path.clone()).collect();
    found
        .into_iter()
        .map(|m| {
            let family =
                infer_model_family(&m.file_name, &m.path, m.repo_id.as_deref().unwrap_or(""));
            serde_json::json!({
                "path": m.path,
                "file_name": m.file_name,
                "size_bytes": m.size_bytes,
                "layout": m.layout,
                "repo_id": m.repo_id,
                "commit_sha": m.commit_sha,
                // M4 (2026-08-12): 家族按特征推断, 不是'非 gguf 即 tts'的二元瞎猜;
                // unknown = 未识别, 前端让用户自己选。
                "family_hint": family,
                "registered": registered_paths.contains(&m.path),
            })
        })
        .collect()
}

/// M4-3③ (2026-08-12): 按文件名/路径特征推断模型家族。
/// 此前前端二元判定 `file_name.ends_with('.gguf') ? 'llm' : 'tts'` —— 把 pytorch_model /
/// ggml-silero (VAD) / ggml-large-v3 (whisper) 全塞进「语音合成」。这里按特征识别:
///   .gguf → llm; kokoro → tts; silero → vad; whisper/ggml- → asr; spacy/core_web → nlp。
/// 识别不出 → "unknown" (前端标「未识别」让用户自己选, 不许瞎猜)。
/// asr/vad 有特征但本应用无对应功能 → 归 unknown 展示, 不自动登记。
pub fn infer_model_family(file_name: &str, path: &str, repo_id: &str) -> String {
    let f = file_name.to_lowercase();
    let p = path.to_lowercase();
    let r = repo_id.to_lowercase();
    if f.ends_with(".gguf") || f.ends_with(".safetensors") {
        "llm".to_string()
    } else if f.contains("kokoro") || p.contains("kokoro") {
        "tts".to_string()
    } else if f.contains("silero") || p.contains("silero") {
        "vad".to_string()
    } else if f.contains("whisper")
        || p.contains("whisper")
        || (f.starts_with("ggml-") && !f.contains("silero"))
    {
        "asr".to_string()
    } else if f.contains("spacy")
        || r.contains("spacy")
        || f.contains("core_web")
        || p.contains("core_web")
    {
        "nlp".to_string()
    } else {
        "unknown".to_string()
    }
}

/// M4-3③: 存量误登记改家族 (移除旧 id, 按新家族重建 id; 保持 active 状态)。
pub fn set_family(db: &Db, id: &str, family: &str) -> Result<(), String> {
    if !["llm", "tts", "nlp"].contains(&family) {
        return Err("家族只支持 llm / tts / nlp".to_string());
    }
    let repo = ModelRepo::new(db);
    let mut e = repo.get(id).ok_or("模型不存在")?;
    e.family = family.to_string();
    e.id = entry_id(&e.family, &e.language, &e.model_id, &e.version);
    if e.id != id {
        repo.remove(id)?;
    }
    repo.upsert(&e)
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
            detected_family: String::new(),
        }
    }

    #[test]
    fn m4_infer_model_family_by_features() {
        // M4-3③: 家族按特征推断, 不再'非 gguf 即 tts'二元瞎猜。
        assert_eq!(
            infer_model_family("Qwen3-4B-Q4_K_M.gguf", "C:/m/x.gguf", ""),
            "llm"
        );
        assert_eq!(
            infer_model_family("kokoro-v1_0.pth", "C:/m/kokoro.pth", ""),
            "tts"
        );
        assert_eq!(
            infer_model_family("ggml-silero-v5.1.2.onnx", "C:/m/silero.onnx", ""),
            "vad"
        );
        assert_eq!(
            infer_model_family("ggml-large-v3.bin", "C:/m/ggml-large-v3.bin", ""),
            "asr"
        );
        assert_eq!(
            infer_model_family("ggml-base.bin", "C:/m/ggml-base.bin", ""),
            "asr"
        );
        assert_eq!(
            infer_model_family("whisper.cpp", "C:/m/whisper.bin", ""),
            "asr"
        );
        assert_eq!(
            infer_model_family(
                "model.bin",
                "F:/hf_cache/hub/models--spacy--en_core_web_sm/snapshots/x/model.bin",
                "spacy/en_core_web_sm"
            ),
            "nlp"
        );
        assert_eq!(
            infer_model_family("pytorch_model.bin", "C:/m/pytorch_model.bin", ""),
            "unknown"
        );
        assert_eq!(
            infer_model_family("random.pth", "C:/m/random.pth", ""),
            "unknown"
        );
    }

    #[test]
    fn m4_set_family_rekeys_entry_and_keeps_active() {
        // M4-3③: 存量误登记改家族 —— id 含家族, 改家族后 id 重建, active 保持。
        let db = temp_db();
        let mut e = entry("tts", "en", "kokoro-v1_0", false);
        e.active = true;
        register(&db, &mut e).unwrap();
        let old_id = e.id.clone();
        assert!(set_family(&db, &old_id, "nlp").is_ok());
        let repo = ModelRepo::new(&db);
        let updated = repo
            .get(&entry_id("nlp", "en", "kokoro-v1_0", "1.0"))
            .expect("新家族 id 应存在");
        assert_eq!(updated.family, "nlp");
        assert!(updated.active, "active 应保持");
        assert!(repo.get(&old_id).is_none(), "旧 id 应移除");
        // 非法家族拒绝
        assert!(set_family(&db, &updated.id, "asr").is_err());
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
    }

    #[test]
    fn resolve_paths_empty_when_unregistered() {
        let db = temp_db();
        let (llm, tts, _) = resolve_paths(&db, "en");
        assert!(llm.is_empty() && tts.is_empty());
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

    /// UX5 修正 (2026-08-13): preflight 必须拒绝不完整的推荐 TTS (无 config.json/voices)。
    /// 用户实测: 扫到 manga-ocr 当 tts 推荐 (文件在, 无 voices), 跑完 translate 才在 TTS 炸。
    #[test]
    fn preflight_rejects_incomplete_tts() {
        let root = std::env::temp_dir().join(format!("aidulc_pt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        let mut llm = entry("llm", "en", "qwen", true);
        llm.path = format!("{}/qwen.gguf", root.to_string_lossy());
        std::fs::write(&llm.path, b"x").unwrap();
        repo.upsert(&llm).unwrap();
        let mut tts = entry("tts", "en", "kokoro", true);
        tts.path = format!("{}/kokoro-v1_0.pth", root.to_string_lossy());
        std::fs::write(&tts.path, b"x").unwrap();
        repo.upsert(&tts).unwrap();
        // 只有 .pth, 没有 config.json/voices → preflight 必须报"语音模型不完整"
        let problems = preflight_check(
            &db,
            "b1",
            "C:/book.epub",
            "en",
            std::path::Path::new("C:/prep"),
            std::path::Path::new(""),
        );
        assert!(
            problems.iter().any(|p| p.contains("语音模型不完整")),
            "不完整 tts 必须被 preflight 拦下: {problems:?}"
        );
        // 补上 config.json + voices → 不再报模型问题
        std::fs::write(root.join("config.json"), b"{}").unwrap();
        std::fs::create_dir_all(root.join("voices")).unwrap();
        let problems2 = preflight_check(
            &db,
            "b1",
            "C:/book.epub",
            "en",
            std::path::Path::new("C:/prep"),
            std::path::Path::new(""),
        );
        assert!(
            !problems2.iter().any(|p| p.contains("模型不完整")),
            "补全后不应再报模型不完整: {problems2:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// UX5 修正 (2026-08-13): register 拒绝不完整的 TTS (平铺 .pth 缺 config.json/voices),
    /// 完整快照 (带 config.json+voices) 照常登记。用户实测: 平铺 kokoro 登记当推荐 → TTS 阶段才炸。
    #[test]
    fn register_rejects_incomplete_tts() {
        let root = std::env::temp_dir().join(format!("aidulc_reg_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let flat = root.join("flat");
        std::fs::create_dir_all(&flat).unwrap();
        let flat_pth = flat.join("kokoro-v1_0.pth");
        std::fs::write(&flat_pth, b"x").unwrap();

        let db = temp_db();
        let mut e = entry("tts", "en", "kokoro-v1_0", false);
        e.path = flat_pth.to_string_lossy().to_string();
        e.custom = true;
        assert!(
            register(&db, &mut e).is_err(),
            "平铺 .pth 缺 config.json/voices 必须被拒"
        );

        // 补上 config.json + voices/ → 通过
        std::fs::write(flat.join("config.json"), b"{}").unwrap();
        std::fs::create_dir_all(flat.join("voices")).unwrap();
        assert!(register(&db, &mut e).is_ok(), "完整快照应能登记");
        let _ = std::fs::remove_dir_all(&root);
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

    #[test]
    fn k15_remove_with_files_deletes_disk_file_when_unbound() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        let path = std::env::temp_dir().join(format!("aidulc_k15_{}.bin", std::process::id()));
        std::fs::write(&path, b"fake model bytes").unwrap();
        let mut e = entry("llm", "en", "test-model", true);
        e.path = path.to_string_lossy().to_string();
        repo.upsert(&e).unwrap();
        remove_with_files(&db, &e.id, true).unwrap();
        assert!(repo.get(&e.id).is_none(), "注册表行应删除");
        assert!(!path.exists(), "磁盘文件应删除");
    }

    #[test]
    fn k15_remove_with_files_false_keeps_disk_file() {
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        let path = std::env::temp_dir().join(format!("aidulc_k15b_{}.bin", std::process::id()));
        std::fs::write(&path, b"fake model bytes").unwrap();
        let mut e = entry("llm", "en", "test-model2", true);
        e.path = path.to_string_lossy().to_string();
        repo.upsert(&e).unwrap();
        remove_with_files(&db, &e.id, false).unwrap();
        assert!(repo.get(&e.id).is_none(), "注册表行应删除");
        assert!(path.exists(), "delete_files=false 不应碰磁盘文件");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn k15_remove_with_files_blocked_when_bound() {
        // 还被书绑定时, delete_files=true 应该拒绝(不能删还在用的文件),
        // 且不删注册表行(整体失败, 不是"删了库但没删文件"的半吊子状态)。
        let db = temp_db();
        let repo = ModelRepo::new(&db);
        let path = std::env::temp_dir().join(format!("aidulc_k15c_{}.bin", std::process::id()));
        std::fs::write(&path, b"fake model bytes").unwrap();
        let mut e = entry("llm", "en", "test-model3", true);
        e.path = path.to_string_lossy().to_string();
        repo.upsert(&e).unwrap();
        {
            use crate::store::books_repo::{Book, BooksRepo};
            let books = BooksRepo::new(&db);
            books
                .upsert(&Book {
                    id: "b1".into(),
                    title: "T".into(),
                    source_path: String::new(),
                    pack_dir: String::new(),
                    profile_id: "default".into(),
                    status: "ready".into(),
                    kind: "original".into(),
                    source_book_id: None,
                    chapter_count: 0,
                    failed_count: 0,
                    last_opened_at: None,
                    source_language: "en".into(),
                    target_language: "zh-CN".into(),
                    llm_id: Some(e.id.clone()),
                    tts_id: None,
                    nlp_id: None,
                    created_at: 0,
                    updated_at: 0,
                })
                .unwrap();
        }
        let err = remove_with_files(&db, &e.id, true).unwrap_err();
        assert!(err.contains("绑定"), "应报绑定中不能删: {err}");
        assert!(repo.get(&e.id).is_some(), "拒绝时注册表行不应被删");
        assert!(path.exists(), "拒绝时磁盘文件不应被删");
        let _ = std::fs::remove_file(&path);
    }
}
