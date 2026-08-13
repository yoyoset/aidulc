//! application/dictionary_service.rs —— 查词闭环用例层 (I-A)
//!
//! 职责: 本地词典优先 → 未命中调 LLM 补全并沉淀 → 不自动进生词本。
//! 依赖注入: lookup_llm 是可注入的补全函数 (测试用 fake)。

use crate::store::{dict_repo::DictRepo, vocab_repo::VocabRepo, Db};

/// 查词响应 DTO (契约: 前端面板渲染依据)
#[derive(Debug, Clone, serde::Serialize)]
pub struct WordLookup {
    pub word: String,
    pub pos: String,
    pub phonetic: String,
    pub meanings: Vec<String>,
    pub examples: Vec<String>,
    /// 本地 LLM 详细解释 (无 API): 例句翻译 / 用法说明 / 常见搭配
    #[serde(default)]
    pub example_zh: Vec<String>,
    #[serde(default)]
    pub usage: String,
    #[serde(default)]
    pub phrases: Vec<String>,
    pub source: String, // local | llm
    pub confidence: f64,
    pub in_vocab: bool,
}

/// LLM 补全签名: (word, context) -> (pos, phonetic, meanings, examples, example_zh, usage, phrases)
/// K2 (2026-08-11): 生产路径 word_lookup 已改用 lookup_local + spawn_blocking + persist_llm;
/// 这个复合闭包版 lookup 只在测试里用 (fake_llm 注入)。
#[cfg(test)]
pub type LookupFn = dyn Fn(
    &str,
    &str,
) -> Result<
    (
        String,
        String,
        Vec<String>,
        Vec<String>,
        Vec<String>,
        String,
        Vec<String>,
    ),
    String,
>;

/// 查词: 本地优先; 未命中调 llm; 结果写入词典 (沉淀); 永不自动进生词本
/// K2 (2026-08-11): 生产路径已拆成 lookup_local → (spawn_blocking) → persist_llm;
/// 这个复合函数只在测试用 (注入 fake_llm), 避免生产走旧的单线程路径。
#[cfg(test)]
pub fn lookup(
    db: &Db,
    user_id: &str,
    profile_id: &str,
    word: &str,
    context: &str,
    lookup_llm: &LookupFn,
) -> Result<WordLookup, String> {
    let key = word.trim().to_lowercase();
    if key.is_empty() {
        return Err("空词".into());
    }
    // 1. 本地命中
    if let Some(r) = lookup_local(db, user_id, profile_id, &key)? {
        return Ok(r);
    }
    // 2. LLM 补全 + 沉淀词典 (不自动进生词本)
    let tuple = lookup_llm(&key, context)?;
    persist_llm(db, user_id, profile_id, &key, tuple)
}

/// K2 (2026-08-11): 只做本地词典命中查询 (纯 DB 读, 快), 未命中返回 None。
/// 从 lookup 拆出, 让异步命令可以把"慢的 LLM 调用"单独丢进 spawn_blocking。
pub fn lookup_local(
    db: &Db,
    user_id: &str,
    profile_id: &str,
    key: &str,
) -> Result<Option<WordLookup>, String> {
    let repo = DictRepo::new(db);
    if let Some(payload) = repo.get(key, user_id, profile_id) {
        let meanings = payload
            .get("meanings")
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| {
                payload
                    .get("meaning")
                    .and_then(|m| m.as_str())
                    .map(|m| vec![m.to_string()])
                    .unwrap_or_default()
            });
        let vocab_repo = VocabRepo::new(db);
        let in_vocab = vocab_repo.get(user_id, profile_id, key).is_some();
        return Ok(Some(WordLookup {
            word: key.to_string(),
            pos: payload
                .get("pos")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string(),
            phonetic: payload
                .get("phonetic")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string(),
            meanings,
            examples: payload
                .get("examples")
                .and_then(|e| e.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            example_zh: payload
                .get("example_zh")
                .and_then(|e| e.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            usage: payload
                .get("usage")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            phrases: payload
                .get("phrases")
                .and_then(|p| p.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            source: "local".into(),
            confidence: payload
                .get("confidence")
                .and_then(|c| c.as_f64())
                .unwrap_or(0.8),
            in_vocab,
        }));
    }
    Ok(None)
}

/// K2 (2026-08-11): LLM 补全结果沉淀词典并组装 WordLookup。从 lookup 拆出,
/// 供异步命令在 spawn_blocking 拿到 tuple 后回主线程写库 (写库是快操作)。
pub fn persist_llm(
    db: &Db,
    user_id: &str,
    profile_id: &str,
    key: &str,
    (pos, phonetic, meanings, examples, example_zh, usage, phrases): crate::commands::dictionary::LookupTuple,
) -> Result<WordLookup, String> {
    let payload = serde_json::json!({
        "word": key, "lemma": key, "pos": pos, "phonetic": phonetic,
        "meanings": meanings, "examples": examples,
        "example_zh": example_zh, "usage": usage, "phrases": phrases,
        "source": "llm", "confidence": 0.7,
        "createdAt": crate::store::now_ms_for_store(),
        "updatedAt": crate::store::now_ms_for_store(),
    });
    let repo = DictRepo::new(db);
    let _ = repo.upsert(key, &payload, user_id, profile_id); // 沉淀失败不阻断 (词典是缓存性质)

    Ok(WordLookup {
        word: key.to_string(),
        pos,
        phonetic,
        meanings,
        examples,
        example_zh,
        usage,
        phrases,
        source: "llm".into(),
        confidence: 0.7,
        in_vocab: false,
    })
}

/// V4 (2026-08-09): 来源定位 (从哪本书哪章哪句划出来的)。打包成结构体避免
/// add_to_vocab 参数过多 (clippy 基线只降不升)。
#[derive(Debug, Clone, Default)]
pub struct SourceLocation {
    pub edition_id: Option<String>,
    pub chapter_index: Option<i64>,
    pub sentence_index: Option<i64>,
}

/// 加入生词本 (显式用户动作)
/// context: 来源句原文 (阶段6 设计交付 §04 生词本: 词条卡显示原句上下文)。可选,
/// 为空时保留已存 context(重加不覆盖旧上下文)。
/// V4 (2026-08-09): source 来源定位; 均可选, 旧数据留空 UI 降级。
pub fn add_to_vocab(
    db: &Db,
    user_id: &str,
    profile_id: &str,
    word: &str,
    context: Option<String>,
    source: SourceLocation,
) -> Result<serde_json::Value, String> {
    let repo = DictRepo::new(db);
    let key = word.trim().to_lowercase();
    let payload = repo
        .get(&key, user_id, profile_id)
        .unwrap_or_else(|| serde_json::json!({"word": key, "lemma": key}));
    // 阶段6: 旧 context 从已有生词条目读 (重加不覆盖旧上下文), 不从词典 payload 读
    let old_context = VocabRepo::new(db)
        .get(user_id, profile_id, &key)
        .map(|e| e.context)
        .unwrap_or_default();
    let entry = crate::domain::vocab::VocabEntry {
        word: payload
            .get("word")
            .and_then(|w| w.as_str())
            .unwrap_or(&key)
            .to_string(),
        lemma: key.clone(),
        pos: payload
            .get("pos")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string(),
        meaning: payload
            .get("meaning")
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| {
                payload.get("meanings").and_then(|m| m.as_array()).map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                })
            })
            .unwrap_or_default(),
        sense_id: None,
        phonetic: payload
            .get("phonetic")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string(),
        // 阶段6: 来源句优先用本次传入; 没有则保留旧的
        context: context
            .filter(|c| !c.trim().is_empty())
            .unwrap_or(old_context),
        level: String::new(),
        collocations: vec![],
        deep_data: serde_json::Value::Null,
        stage: "new".into(),
        interval: 0.0,
        interval_ms: 0,
        ease_factor: 2.5,
        next_review: None,
        reviews: 0,
        last_review: None,
        last_grade: None,
        added_at: crate::store::now_ms_for_store(),
        updated_at: crate::store::now_ms_for_store(),
        edition_id: source.edition_id,
        chapter_index: source.chapter_index,
        sentence_index: source.sentence_index,
    };
    let vocab = VocabRepo::new(db);
    vocab.upsert_content(entry, user_id, profile_id)?;
    // H5 (2026-08-11): 入库侧词频门槛 —— **默认不拦、只提示**。词在档案对应阈值内
    // (成人 top3000 / 儿童 top2000) → common_word: true, 前端 toast 提示"这词很常见, 确定
    // 要背吗", 但不阻断加入 (避免把用户真想学的词悄悄吃掉; 孩子更需要基础词, 阈值更严)。
    let top_n = if profile_id == "kid" {
        crate::infrastructure::frequency::KID_COMMON_TOP_N
    } else {
        crate::infrastructure::frequency::ADULT_COMMON_TOP_N
    };
    let common_word = crate::infrastructure::frequency::is_common(&key, top_n);
    Ok(serde_json::json!({
        "added": key,
        "common_word": common_word,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("aidulc_ds_test_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn fake_llm(
        word: &str,
        _ctx: &str,
    ) -> Result<
        (
            String,
            String,
            Vec<String>,
            Vec<String>,
            Vec<String>,
            String,
            Vec<String>,
        ),
        String,
    > {
        Ok((
            "NOUN".into(),
            "/fake/".into(),
            vec![format!("{word} 的释义")],
            vec!["example".into()],
            vec!["例句翻译".into()],
            "用法说明".into(),
            vec!["固定搭配".into()],
        ))
    }

    #[test]
    fn local_hit_returns_local_source() {
        let db = temp_db();
        let repo = DictRepo::new(&db);
        repo.upsert(
            "bank",
            &serde_json::json!({"word": "bank", "pos": "NOUN", "meanings": ["银行"]}),
            "me",
            "default",
        )
        .unwrap();
        let r = lookup(&db, "me", "default", "Bank", "ctx", &fake_llm).unwrap();
        assert_eq!(r.source, "local");
        assert_eq!(r.meanings, vec!["银行"]);
        assert!(!r.in_vocab);
    }

    #[test]
    fn llm_fallback_populates_and_persists() {
        let db = temp_db();
        let r = lookup(&db, "me", "default", "zebra", "ctx", &fake_llm).unwrap();
        assert_eq!(r.source, "llm");
        assert_eq!(r.pos, "NOUN");
        // 已沉淀
        let repo = DictRepo::new(&db);
        assert!(repo.get("zebra", "me", "default").is_some());
    }

    #[test]
    fn llm_fallback_never_auto_adds_vocab() {
        let db = temp_db();
        lookup(&db, "me", "default", "zebra", "ctx", &fake_llm).unwrap();
        let vocab = VocabRepo::new(&db);
        assert!(
            vocab.get("me", "default", "zebra").is_none(),
            "LLM 补全不得自动进生词本"
        );
    }

    #[test]
    fn add_to_vocab_explicit() {
        let db = temp_db();
        let r = lookup(&db, "me", "default", "zebra", "ctx", &fake_llm).unwrap();
        assert!(!r.in_vocab);
        add_to_vocab(
            &db,
            "me",
            "default",
            "zebra",
            None,
            SourceLocation::default(),
        )
        .unwrap();
        let vocab = VocabRepo::new(&db);
        assert!(
            vocab.get("me", "default", "zebra").is_some(),
            "显式加入后才进生词本"
        );
    }

    #[test]
    fn add_to_vocab_stores_source_context() {
        // 阶段6 设计交付 §04: 加词记录来源句上下文, 生词本词条卡能显示"从哪里读到的"
        let db = temp_db();
        add_to_vocab(
            &db,
            "me",
            "default",
            "gutter",
            Some("She watched the water in the gutters.".into()),
            SourceLocation::default(),
        )
        .unwrap();
        let vocab = VocabRepo::new(&db);
        let got = vocab.get("me", "default", "gutter").expect("词应在");
        assert_eq!(got.context, "She watched the water in the gutters.");
        // 再次加词不带 context → 保留旧上下文 (不覆盖成空)
        add_to_vocab(
            &db,
            "me",
            "default",
            "gutter",
            None,
            SourceLocation::default(),
        )
        .unwrap();
        let got2 = vocab.get("me", "default", "gutter").expect("词应在");
        assert_eq!(
            got2.context, "She watched the water in the gutters.",
            "空 context 不覆盖旧值"
        );
    }

    #[test]
    fn add_to_vocab_stores_source_location() {
        // V4 (2026-08-09): 来源定位 —— 记录从哪本书哪章哪句划出来的
        let db = temp_db();
        add_to_vocab(
            &db,
            "me",
            "default",
            "gutter",
            Some("ctx".into()),
            SourceLocation {
                edition_id: Some("edition-1".into()),
                chapter_index: Some(3),
                sentence_index: Some(12),
            },
        )
        .unwrap();
        let vocab = VocabRepo::new(&db);
        let got = vocab.get("me", "default", "gutter").expect("词应在");
        assert_eq!(got.edition_id.as_deref(), Some("edition-1"));
        assert_eq!(got.chapter_index, Some(3));
        assert_eq!(got.sentence_index, Some(12));
    }

    #[test]
    fn add_to_vocab_without_source_location_is_none() {
        // V4: 旧数据/未带定位 → None (UI 降级)
        let db = temp_db();
        add_to_vocab(
            &db,
            "me",
            "default",
            "plain",
            None,
            SourceLocation::default(),
        )
        .unwrap();
        let got = VocabRepo::new(&db)
            .get("me", "default", "plain")
            .expect("词应在");
        assert!(got.edition_id.is_none());
        assert!(got.chapter_index.is_none());
        assert!(got.sentence_index.is_none());
    }

    #[test]
    fn add_to_vocab_isolated_by_user() {
        // V1 (2026-08-09): 同一词不同 user 各自独立加词, 互不影响
        let db = temp_db();
        add_to_vocab(
            &db,
            "me",
            "default",
            "gutter",
            None,
            SourceLocation::default(),
        )
        .unwrap();
        add_to_vocab(
            &db,
            "u-kid",
            "default",
            "gutter",
            None,
            SourceLocation::default(),
        )
        .unwrap();
        let vocab = VocabRepo::new(&db);
        assert!(vocab.get("me", "default", "gutter").is_some());
        assert!(vocab.get("u-kid", "default", "gutter").is_some());
        assert_eq!(vocab.list("me", "default").len(), 1);
        assert_eq!(vocab.list("u-kid", "default").len(), 1);
    }

    #[test]
    fn empty_word_rejected() {
        let db = temp_db();
        assert!(lookup(&db, "me", "default", "  ", "ctx", &fake_llm).is_err());
    }
}
