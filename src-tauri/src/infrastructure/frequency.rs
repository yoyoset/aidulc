//! infrastructure/frequency.rs —— 词频门槛 (H5, 2026-08-11)
//!
//! 背景 (实测): 成人自读档案把 `either`/`lead`/`confirmed` 这类高频词收进生词本 ——
//! 划词入库没有词频门槛。5.4 小时的今日队列里有相当比例花在背 `either` 上, 直接毁掉
//! 用户对这个功能的信任。
//!
//! 数据源: `assets/common_words.txt` —— Google Trillion Word Corpus 前 10000 词
//! (first20hours/google-10000-english, no-swears 版, MIT)。按行存, 行序 = 词频降序。
//!
//! 用途:
//!   1. 词表"按词频批量剔除"(一次性收拾存量, 如剔除最常见 3000 词);
//!   2. 入库侧门槛: add_to_vocab 时若词在 top-N 内 → **默认不拦、只提示**
//!      (避免把用户真想学的词悄悄吃掉; 档案相关阈值见 profile 侧判定)。

use std::collections::HashSet;

/// 词频表 (编译期嵌入, 不读磁盘)。行序 = 词频降序。
const COMMON_WORDS: &str = include_str!("../../assets/common_words.txt");

/// 成人自读档案的入库词频门槛: 最常见前 3000 词算"高频"(提示)。
/// 儿童档案更严格 (孩子更需要基础词), 见前端 profile 判定 (kid 用 2000)。
pub const ADULT_COMMON_TOP_N: usize = 3000;
/// 儿童档案门槛 (更少词被标记为"太常见"——对孩子来说基础词也是要学的)
pub const KID_COMMON_TOP_N: usize = 2000;

/// 全部词频词 (小写) —— 一次性解析缓存。
fn all_words() -> Vec<&'static str> {
    COMMON_WORDS
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect()
}

/// 取最常见的前 N 个词, 返回小写集合。
pub fn top_n(n: usize) -> HashSet<String> {
    all_words()
        .into_iter()
        .take(n)
        .map(|w| w.to_lowercase())
        .collect()
}

/// 该词 (小写) 是否落在最常见前 N 词里。
pub fn is_common(word: &str, n: usize) -> bool {
    let w = word.trim().to_lowercase();
    if w.is_empty() {
        return false;
    }
    all_words().into_iter().take(n).any(|cw| cw == w)
}

/// 词频表里有多少词 (自检用)。
#[cfg(test)]
pub fn total_entries() -> usize {
    all_words().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_3000_contains_very_common_words() {
        // either/lead 是 H5 截图的元凶 —— 必须在最常见 3000 内
        assert!(is_common("either", 3000), "either 应命中 top3000");
        assert!(is_common("lead", 3000), "lead 应命中 top3000");
        assert!(is_common("the", 3000));
        assert!(is_common("of", 3000));
    }

    #[test]
    fn case_insensitive_and_case_normalized() {
        assert!(is_common("EITHER", 3000));
        assert!(is_common("Lead", 3000));
        assert!(!is_common("hieroglyphics", 3000), "生僻词不应命中");
    }

    #[test]
    fn top_n_is_more_restrictive_for_smaller_n() {
        // 前 100 词 vs 前 3000 词: 前者更严格
        assert!(is_common("the", 100));
        assert!(!is_common("either", 100), "either 不在前 100");
        assert!(is_common("either", 3000));
    }

    #[test]
    fn empty_word_never_common() {
        assert!(!is_common("", 3000));
        assert!(!is_common("   ", 3000));
    }

    #[test]
    fn list_has_reasonable_size() {
        assert!(
            total_entries() >= 9000 && total_entries() <= 10000,
            "词频表应在 9000-10000 词之间, 实得 {}",
            total_entries()
        );
    }

    #[test]
    fn top_n_returns_set_of_right_size() {
        let s = top_n(3000);
        assert_eq!(s.len(), 3000, "top_n(3000) 应恰好 3000 个");
        assert!(s.contains("the"));
        assert!(s.contains("either"));
        assert!(!s.contains("hieroglyphics"));
    }
}
