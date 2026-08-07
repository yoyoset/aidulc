//! domain/vocab.rs —— VocabEntry + normalize (对 aidu 契约, 跑 golden fixture)
//!
//! aidu 的 normalizeVocabEntry (schema_constants.js:155):
//! - 无 word 无 lemma → null (拒绝)
//! - word/lemma 互补
//! - stage 非法 → 'new'; interval <0 → 0; easeFactor <1.3 → 2.5; reviews 非数 → 0
//! - nextReview undefined → now; collocations 非数组 → []
//! - addedAt 非数 → now; senseId 存在则转 String
//!
//! Rust conformance: 对 contracts/fixtures/vocab_golden.json 跑同样的 normalize,
//! 结果字段与 golden 字字相同 (R3 结构性防漂移)。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const VALID_STAGES: [&str; 4] = ["new", "learning", "review", "mastered"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VocabEntry {
    pub word: String,
    pub lemma: String,
    #[serde(default)]
    pub pos: String,
    #[serde(default)]
    pub meaning: String,
    #[serde(default, rename = "senseId")]
    pub sense_id: Option<String>,
    #[serde(default)]
    pub phonetic: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub collocations: Vec<String>,
    #[serde(default, rename = "deepData")]
    pub deep_data: Value,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub interval: f64, // AIDU: 天数, 允许浮点 (M1 修复)
    #[serde(default, rename = "easeFactor")]
    pub ease_factor: f64,
    #[serde(default, rename = "nextReview")]
    pub next_review: Option<i64>,
    #[serde(default)]
    pub reviews: i64,
    #[serde(default, rename = "lastReview")]
    pub last_review: Option<i64>,
    #[serde(default, rename = "lastGrade")]
    pub last_grade: Option<i64>,
    #[serde(default, rename = "addedAt")]
    pub added_at: i64,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 返回 None = 该条目不治 (无 word 也无 lemma, 对应 aidu 返回 null)。
pub fn normalize_vocab_entry(mut e: VocabEntry) -> Option<VocabEntry> {
    if e.word.is_empty() && e.lemma.is_empty() {
        return None;
    }
    if e.word.is_empty() {
        e.word = e.lemma.clone();
    }
    if e.lemma.is_empty() {
        e.lemma = e.word.to_lowercase();
    }
    if !VALID_STAGES.contains(&e.stage.as_str()) {
        e.stage = "new".to_string();
    }
    if e.interval < 0.0 {
        e.interval = 0.0;
    }
    if e.ease_factor < 1.3 {
        e.ease_factor = 2.5;
    }
    if e.reviews < 0 {
        e.reviews = 0;
    }
    if e.next_review.is_none() {
        e.next_review = Some(now_ms());
    }
    if e.collocations.is_empty() && e.collocations.capacity() == 0 {
        // aidu: 非数组 → []; Rust 反序列化时非数组会失败, 这里保持现状
    }
    if e.added_at <= 0 {
        e.added_at = now_ms();
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_golden() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../contracts/fixtures/vocab_golden.json"
        );
        let text = std::fs::read_to_string(path).expect("golden fixture 缺失");
        serde_json::from_str(&text).expect("golden fixture JSON 解析失败")
    }

    #[test]
    fn golden_vocab_entry_normalizes_identically() {
        let golden = load_golden();
        let entry: VocabEntry =
            serde_json::from_value(golden["vocab_entry_canonical"].clone()).expect("解析 golden 条目");
        let out = normalize_vocab_entry(entry).expect("canonical 条目不该被拒");
        assert_eq!(out.word, "break");
        assert_eq!(out.lemma, "break");
        assert_eq!(out.stage, "new");
        assert_eq!(out.interval, 0.0);
        assert_eq!(out.ease_factor, 2.5);
        assert_eq!(out.reviews, 0);
        assert_eq!(out.next_review, Some(1700000000000));
        assert_eq!(out.sense_id.as_deref(), Some("break:verb:1"));
    }

    #[test]
    fn minimal_entry_gets_defaults() {
        let entry = VocabEntry {
            word: "break".into(),
            lemma: String::new(),
            pos: String::new(),
            meaning: String::new(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: Value::Null,
            stage: "bogus".into(),
            interval: -5.0,
            ease_factor: 1.0,
            next_review: None,
            reviews: -1,
            last_review: None,
            last_grade: None,
            added_at: 0,
            updated_at: 0,
        };
        let out = normalize_vocab_entry(entry).expect("minimal 条目不该被拒");
        assert_eq!(out.lemma, "break");
        assert_eq!(out.stage, "new");
        assert_eq!(out.interval, 0.0);
        assert_eq!(out.ease_factor, 2.5);
        assert!(out.next_review.is_some());
        assert!(out.added_at > 0);
    }

    #[test]
    fn entry_without_word_or_lemma_rejected() {
        let entry = VocabEntry {
            word: String::new(),
            lemma: String::new(),
            ..VocabEntry {
                word: String::new(),
                lemma: String::new(),
                pos: String::new(),
                meaning: String::new(),
                sense_id: None,
                phonetic: String::new(),
                context: String::new(),
                level: String::new(),
                collocations: vec![],
                deep_data: Value::Null,
                stage: String::new(),
                interval: 0.0,
                ease_factor: 2.5,
                next_review: None,
                reviews: 0,
                last_review: None,
                last_grade: None,
                added_at: 0,
                updated_at: 0,
            }
        };
        assert!(normalize_vocab_entry(entry).is_none());
    }
}
