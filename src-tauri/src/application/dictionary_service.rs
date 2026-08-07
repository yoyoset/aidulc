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
pub fn lookup(
    db: &Db,
    profile_id: &str,
    word: &str,
    context: &str,
    lookup_llm: &LookupFn,
) -> Result<WordLookup, String> {
    let repo = DictRepo::new(db);
    let key = word.trim().to_lowercase();
    if key.is_empty() {
        return Err("空词".into());
    }

    // 1. 本地命中
    if let Some(payload) = repo.get(&key, profile_id) {
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
        let in_vocab = vocab_repo.get(profile_id, &key).is_some();
        return Ok(WordLookup {
            word: key.clone(),
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
        });
    }

    // 2. LLM 补全 + 沉淀词典 (不自动进生词本)
    let (pos, phonetic, meanings, examples, example_zh, usage, phrases) =
        lookup_llm(&key, context)?;
    let payload = serde_json::json!({
        "word": key, "lemma": key, "pos": pos, "phonetic": phonetic,
        "meanings": meanings, "examples": examples,
        "example_zh": example_zh, "usage": usage, "phrases": phrases,
        "source": "llm", "confidence": 0.7,
        "createdAt": crate::store::now_ms_for_store(),
        "updatedAt": crate::store::now_ms_for_store(),
    });
    let _ = repo.upsert(&key, &payload, profile_id); // 沉淀失败不阻断 (词典是缓存性质)

    Ok(WordLookup {
        word: key.clone(),
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

/// 加入生词本 (显式用户动作)
pub fn add_to_vocab(db: &Db, profile_id: &str, word: &str) -> Result<serde_json::Value, String> {
    let repo = DictRepo::new(db);
    let key = word.trim().to_lowercase();
    let payload = repo
        .get(&key, profile_id)
        .unwrap_or_else(|| serde_json::json!({"word": key, "lemma": key}));
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
        context: String::new(),
        level: String::new(),
        collocations: vec![],
        deep_data: serde_json::Value::Null,
        stage: "new".into(),
        interval: 0.0,
        ease_factor: 2.5,
        next_review: None,
        reviews: 0,
        last_review: None,
        last_grade: None,
        added_at: crate::store::now_ms_for_store(),
        updated_at: crate::store::now_ms_for_store(),
    };
    let vocab = VocabRepo::new(db);
    vocab.upsert_content(entry, profile_id)?;
    Ok(serde_json::json!({"added": key}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_ds_test_{}.db", std::process::id()));
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
            "default",
        )
        .unwrap();
        let r = lookup(&db, "default", "Bank", "ctx", &fake_llm).unwrap();
        assert_eq!(r.source, "local");
        assert_eq!(r.meanings, vec!["银行"]);
        assert!(!r.in_vocab);
    }

    #[test]
    fn llm_fallback_populates_and_persists() {
        let db = temp_db();
        let r = lookup(&db, "default", "zebra", "ctx", &fake_llm).unwrap();
        assert_eq!(r.source, "llm");
        assert_eq!(r.pos, "NOUN");
        // 已沉淀
        let repo = DictRepo::new(&db);
        assert!(repo.get("zebra", "default").is_some());
    }

    #[test]
    fn llm_fallback_never_auto_adds_vocab() {
        let db = temp_db();
        lookup(&db, "default", "zebra", "ctx", &fake_llm).unwrap();
        let vocab = VocabRepo::new(&db);
        assert!(
            vocab.get("default", "zebra").is_none(),
            "LLM 补全不得自动进生词本"
        );
    }

    #[test]
    fn add_to_vocab_explicit() {
        let db = temp_db();
        let r = lookup(&db, "default", "zebra", "ctx", &fake_llm).unwrap();
        assert!(!r.in_vocab);
        add_to_vocab(&db, "default", "zebra").unwrap();
        let vocab = VocabRepo::new(&db);
        assert!(
            vocab.get("default", "zebra").is_some(),
            "显式加入后才进生词本"
        );
    }

    #[test]
    fn empty_word_rejected() {
        let db = temp_db();
        assert!(lookup(&db, "default", "  ", "ctx", &fake_llm).is_err());
    }
}
