//! domain/srs.rs —— 背单词调度器 (V2, 2026-08-09)
//!
//! 纯函数: (词条状态, 评分 1-4, now) → (新 stage/interval/ease/到期), 零 I/O。
//! 命令层只做 取→算→写 (唯一写者 vocab_repo); 同函数供 UI 预览四档间隔。
//!
//! 与设计稿对齐 (docs/DESIGN_NOTES_SRS.md):
//! - 冲突 2: 分钟级步长存不下 → 引入毫秒级 interval_ms (interval_days 只留 AIDU 导出兼容)
//! - 冲突 3: 按钮时间由调度器对当前词算出后返回, 前端不写死
//! - 分钟级步长 (1 分/10 分) 是"学习中"未毕业的卡; 到天数即毕业进入 review
//!
//! 算法为 SM-2 变体: 新词/学习中按 评分→固定分钟/天步长; 复习按 ease_factor 增长。

/// 步长常量 (毫秒)
pub const MINUTE_1: i64 = 60_000;
pub const MINUTE_10: i64 = 600_000;
pub const DAY_1: i64 = 86_400_000;
pub const DAY_3: i64 = 3 * DAY_1;
pub const DAY_8: i64 = 8 * DAY_1;

const EASE_MIN: f64 = 1.3;
const EASE_MAX: f64 = 5.0;

/// 调度器输入 (从 VocabEntry 投影, 只取调度相关字段)
#[derive(Debug, Clone, PartialEq)]
pub struct SrsState {
    pub stage: String,    // "new" | "learning" | "review" | "mastered"
    pub interval_ms: i64, // 当前间隔 (毫秒; 秒级以下精度靠它)
    pub ease_factor: f64,
    pub reviews: i64,
    pub next_review: Option<i64>,
}

/// 调度器输出: 评分后词条应变成的状态
#[derive(Debug, Clone, PartialEq)]
pub struct SrsOutcome {
    pub stage: String,
    pub interval_ms: i64,
    /// AIDU 导出兼容: 天数浮点 (分钟级步长 < 1 天, 导出时会被 aidu 按 0 处理, 可接受)
    pub interval_days: f64,
    pub ease_factor: f64,
    pub reviews: i64,
    pub next_review: i64,
    pub last_review: i64,
    pub last_grade: i64,
}

/// 四档按钮之一 (UI 预览用)
#[derive(Debug, Clone, PartialEq)]
pub struct IntervalOption {
    pub grade: i64,       // 1-4
    pub label: String,    // 忘了/模糊/记得/太简单
    pub human: String,    // "1 分钟" / "3 天" ...
    pub delta_ms: i64,    // 相对间隔
    pub next_review: i64, // 绝对到期时刻 (now + delta_ms)
}

/// 从 VocabEntry 投影调度状态
pub fn state_from_entry(e: &crate::domain::vocab::VocabEntry) -> SrsState {
    SrsState {
        stage: e.stage.clone(),
        interval_ms: e.interval_ms,
        ease_factor: e.ease_factor,
        reviews: e.reviews,
        next_review: e.next_review,
    }
}

fn clamp_ease(e: f64) -> f64 {
    e.clamp(EASE_MIN, EASE_MAX)
}

/// 当前词是否到期 (next_review <= now; 无 next_review 视为到期)
pub fn is_due(s: &SrsState, now: i64) -> bool {
    match s.next_review {
        Some(ts) => ts <= now,
        None => true,
    }
}

/// 四档间隔 (预览): 对当前状态按四个评分各自算出的到期时刻。
/// 保证与 apply_grade 对同一 grade 的 next_review 完全一致 (一致性测试锁定)。
pub fn interval_options(s: &SrsState, now: i64) -> [IntervalOption; 4] {
    let labels = ["忘了", "模糊", "记得", "太简单"];
    let mut out: Vec<IntervalOption> = Vec::with_capacity(4);
    for grade in 1..=4i64 {
        let o = apply_grade(s, grade as u8, now);
        out.push(IntervalOption {
            grade,
            label: labels[(grade - 1) as usize].to_string(),
            human: human_duration(o.interval_ms),
            delta_ms: o.interval_ms,
            next_review: o.next_review,
        });
    }
    [out.remove(0), out.remove(0), out.remove(0), out.remove(0)]
}

/// 评分 1-4 应用: 返回词条新状态。now = 当前 epoch 毫秒。
pub fn apply_grade(s: &SrsState, grade: u8, now: i64) -> SrsOutcome {
    let mut ease = s.ease_factor;
    let (interval_ms, stage): (i64, String) = match (s.stage.as_str(), grade) {
        // 新词: 按评分直接定步长
        ("new", 1) => (MINUTE_1, "learning".into()),
        ("new", 2) => (MINUTE_10, "learning".into()),
        ("new", 3) => (DAY_3, "review".into()),
        ("new", 4) => (DAY_8, "review".into()),
        // 学习中 (分钟级步长未毕业): 忘了/模糊留在学习中, 记得/太简单毕业
        ("learning", 1) => (MINUTE_1, "learning".into()),
        ("learning", 2) => (MINUTE_10, "learning".into()),
        ("learning", 3) => (DAY_3, "review".into()),
        ("learning", 4) => (DAY_8, "review".into()),
        // 复习: 忘了打回学习; 其余按 ease 增长
        ("review", 1) => {
            ease -= 0.20;
            (MINUTE_1, "learning".into())
        }
        ("review", 2) => {
            ease -= 0.15;
            let base = s.interval_ms.max(MINUTE_10);
            (base * 12 / 10, "review".into())
        }
        ("review", 3) => {
            let base = (s.interval_ms.max(MINUTE_10) as f64 * ease) as i64;
            (base.max(DAY_1), "review".into())
        }
        ("review", 4) => {
            ease += 0.15;
            let base = s.interval_ms.max(MINUTE_10) as f64 * ease * 1.3;
            (base as i64, "review".into())
        }
        // mastered 被误评 (理论上不进队列): 按 review 处理, 兜底
        ("mastered", 1) => (MINUTE_1, "learning".into()),
        ("mastered", 2) => (MINUTE_10, "learning".into()),
        ("mastered", 3) => (DAY_3, "review".into()),
        ("mastered", 4) => (DAY_8, "review".into()),
        // 未知状态兜底 → 当新词 (grade 必须在 1-4, 命令层已校验)
        (_, 1) => (MINUTE_1, "learning".into()),
        (_, 2) => (MINUTE_10, "learning".into()),
        (_, 3) => (DAY_3, "review".into()),
        (_, 4) => (DAY_8, "review".into()),
        (_, _) => (MINUTE_1, "learning".into()),
    };
    let ease = clamp_ease(ease);
    SrsOutcome {
        stage,
        interval_ms,
        interval_days: interval_ms as f64 / DAY_1 as f64,
        ease_factor: ease,
        reviews: s.reviews + 1,
        next_review: now + interval_ms,
        last_review: now,
        last_grade: grade as i64,
    }
}

/// 人类可读时长 ("1 分钟" / "10 分钟" / "3 天" / "18 天" ...)
pub fn human_duration(ms: i64) -> String {
    if ms < 60_000 {
        format!("{} 秒", ms / 1_000)
    } else if ms < 3_600_000 {
        format!("{} 分钟", ms / 60_000)
    } else if ms < DAY_1 {
        format!("{} 小时", ms / 3_600_000)
    } else {
        format!("{} 天", ms / DAY_1)
    }
}

/// 把调度结果写回 VocabEntry (命令层取→算→写的"写"用; 由 vocab_repo 落库)
pub fn apply_outcome(
    mut e: crate::domain::vocab::VocabEntry,
    o: &SrsOutcome,
) -> crate::domain::vocab::VocabEntry {
    e.stage = o.stage.clone();
    e.interval = o.interval_days;
    e.interval_ms = o.interval_ms;
    e.ease_factor = o.ease_factor;
    e.reviews = o.reviews;
    e.next_review = Some(o.next_review);
    e.last_review = Some(o.last_review);
    e.last_grade = Some(o.last_grade);
    e.updated_at = o.last_review;
    e
}

// ---- H4 (2026-08-11): 存量打散 ----

/// H4: 首次导入/迁移进来的存量词打散到未来 N 天。
///
/// 背景 (实测): 一次性导入 1424 词, `next_review` 全部在过去 (最晚 2026-08-04),
/// 今日队列 1291 词 ≈ 323 分钟 —— "到期复习不封顶"的前提是日常增量, 存量撞上来第一天
/// 就是 5.4 小时, 没人会开始。
///
/// 规则: 按加入顺序 (added_at 升序) 把 next_review 摊到未来 ceil(N/daily_cap) 天,
/// 每天至多 daily_cap 词。day = i / daily_cap, next_review = 今天 0 点 + day 天。
/// 纯函数: 输入 (lemma, added_at, due) 列表, 输出 (lemma, next_review)。零 I/O。
pub fn spread_backlog_dates(
    items: &[(&str, i64)], // (lemma, added_at)
    daily_cap: usize,
    now: i64,
) -> Vec<(String, i64)> {
    if daily_cap == 0 || items.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<(&str, i64)> = items.to_vec();
    sorted.sort_by_key(|(_, added_at)| *added_at);
    let day_ms = DAY_1;
    let today_start = now - (now % day_ms); // 今天 0 点 (epoch, 简单确定性, 不掺时区)
    sorted
        .into_iter()
        .enumerate()
        .map(|(i, (lemma, _))| {
            let day = (i / daily_cap) as i64;
            (lemma.to_string(), today_start + day * day_ms)
        })
        .collect()
}

#[cfg(test)]
mod h4_tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000; // 某个 epoch ms
    const DAY: i64 = DAY_1;

    #[test]
    fn spreads_evenly_by_join_order() {
        // 10 词, 每日 4 → 摊到 3 天 (4/4/2)
        let items: Vec<(String, i64)> = (0..10).map(|i| (format!("w{i}"), 1000 + i)).collect();
        let refs: Vec<(&str, i64)> = items.iter().map(|(l, a)| (l.as_str(), *a)).collect();
        let out = spread_backlog_dates(&refs, 4, NOW);
        assert_eq!(out.len(), 10);
        let day0 = NOW - (NOW % DAY);
        // 前 4 个今天, 4-7 明天, 8-9 后天
        assert_eq!(out[0].1, day0);
        assert_eq!(out[3].1, day0);
        assert_eq!(out[4].1, day0 + DAY);
        assert_eq!(out[7].1, day0 + DAY);
        assert_eq!(out[8].1, day0 + 2 * DAY);
        assert_eq!(out[9].1, day0 + 2 * DAY);
    }

    #[test]
    fn join_order_determines_slot() {
        // 后加入的排到后面 (按 added_at)
        let items: Vec<(String, i64)> =
            vec![("late".to_string(), 5000), ("early".to_string(), 1000)];
        let refs: Vec<(&str, i64)> = items.iter().map(|(l, a)| (l.as_str(), *a)).collect();
        let out = spread_backlog_dates(&refs, 1, NOW);
        let day0 = NOW - (NOW % DAY);
        assert_eq!(out[0].0, "early", "先加入的先排");
        assert_eq!(out[0].1, day0);
        assert_eq!(out[1].0, "late");
        assert_eq!(out[1].1, day0 + DAY);
    }

    #[test]
    fn empty_or_zero_cap_is_noop() {
        assert!(spread_backlog_dates(&[], 10, NOW).is_empty());
        let items: Vec<(&str, i64)> = vec![("a", 1)];
        assert!(spread_backlog_dates(&items, 0, NOW).is_empty());
    }

    #[test]
    fn all_fit_in_one_day_when_under_cap() {
        let items: Vec<(String, i64)> = (0..3).map(|i| (format!("w{i}"), i)).collect();
        let refs: Vec<(&str, i64)> = items.iter().map(|(l, a)| (l.as_str(), *a)).collect();
        let out = spread_backlog_dates(&refs, 40, NOW);
        let day0 = NOW - (NOW % DAY);
        for (_, ts) in &out {
            assert_eq!(*ts, day0, "3 词 < 40 上限 → 全在今天");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn state(stage: &str, interval_ms: i64, ease: f64, reviews: i64) -> SrsState {
        SrsState {
            stage: stage.into(),
            interval_ms,
            ease_factor: ease,
            reviews,
            next_review: Some(NOW - 1), // 已到期
        }
    }

    fn entry() -> crate::domain::vocab::VocabEntry {
        crate::domain::vocab::VocabEntry {
            word: "bank".into(),
            lemma: "bank".into(),
            pos: "NOUN".into(),
            meaning: "银行".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
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
            added_at: NOW,
            updated_at: NOW,
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        }
    }

    /// 新词 × 四档 (设计稿: 忘了 1 分钟 / 模糊 10 分钟 / 记得 3 天 / 太简单 8 天)
    #[test]
    fn new_word_four_grades() {
        let s = state("new", 0, 2.5, 0);
        let o = apply_grade(&s, 1, NOW);
        assert_eq!(o.stage, "learning");
        assert_eq!(o.interval_ms, MINUTE_1);
        assert_eq!(o.next_review, NOW + MINUTE_1);
        assert_eq!(o.reviews, 1);

        let o = apply_grade(&s, 2, NOW);
        assert_eq!(o.interval_ms, MINUTE_10);
        assert_eq!(o.stage, "learning");

        let o = apply_grade(&s, 3, NOW);
        assert_eq!(o.interval_ms, DAY_3);
        assert_eq!(o.stage, "review", "记得 → 毕业到复习");

        let o = apply_grade(&s, 4, NOW);
        assert_eq!(o.interval_ms, DAY_8);
        assert_eq!(o.stage, "review");
    }

    /// 学习中: 忘了/模糊留在学习中 (分钟级), 记得/太简单毕业
    #[test]
    fn learning_four_grades() {
        let s = state("learning", MINUTE_10, 2.5, 1);
        assert_eq!(apply_grade(&s, 1, NOW).stage, "learning");
        assert_eq!(apply_grade(&s, 1, NOW).interval_ms, MINUTE_1);
        assert_eq!(apply_grade(&s, 2, NOW).interval_ms, MINUTE_10);
        assert_eq!(apply_grade(&s, 3, NOW).stage, "review");
        assert_eq!(apply_grade(&s, 3, NOW).interval_ms, DAY_3);
        assert_eq!(apply_grade(&s, 4, NOW).interval_ms, DAY_8);
    }

    /// 复习: 忘了打回学习, 记得按 ease 增长, 太简单额外 1.3x
    #[test]
    fn review_four_grades() {
        let s = state("review", DAY_3, 2.5, 3);

        let lapsed = apply_grade(&s, 1, NOW);
        assert_eq!(lapsed.stage, "learning", "复习忘了 → 打回学习中");
        assert_eq!(lapsed.interval_ms, MINUTE_1);
        assert!(lapsed.ease_factor < 2.5, "忘了应降 ease");

        let hard = apply_grade(&s, 2, NOW);
        assert_eq!(hard.stage, "review");
        assert_eq!(hard.interval_ms, DAY_3 * 12 / 10, "模糊 = 1.2x");
        assert!(hard.ease_factor < 2.5, "模糊应微降 ease");

        let good = apply_grade(&s, 3, NOW);
        assert_eq!(good.stage, "review");
        assert_eq!(
            good.interval_ms,
            (DAY_3 as f64 * 2.5) as i64,
            "记得 = interval × ease"
        );
        assert!((good.ease_factor - 2.5).abs() < 1e-9, "记得不改 ease");

        let easy = apply_grade(&s, 4, NOW);
        assert_eq!(easy.stage, "review");
        // SM-2: ease 先 +0.15 再用 (新 EF 决定下一次增长)
        assert_eq!(
            easy.interval_ms,
            (DAY_3 as f64 * 2.65 * 1.3) as i64,
            "太简单 = 新 ease(2.65) × 1.3"
        );
        assert!((easy.ease_factor - 2.65).abs() < 1e-9, "太简单应升 ease");
    }

    /// 已掌握被误评 → 按学习/复习兜底, 不 panic
    #[test]
    fn mastered_fallback_does_not_panic() {
        let s = state("mastered", DAY_8, 2.5, 10);
        for g in 1..=4u8 {
            let o = apply_grade(&s, g, NOW);
            assert!(o.interval_ms > 0);
        }
    }

    /// 一致性: 按钮预览值 == 评分后实际到期 (V2 验收硬指标)
    #[test]
    fn button_preview_matches_actual_next_review() {
        for (stage, iv) in [
            ("new", 0),
            ("learning", MINUTE_10),
            ("review", DAY_3),
            ("review", DAY_8),
            ("mastered", DAY_8),
        ] {
            let s = state(stage, iv, 2.5, 2);
            let opts = interval_options(&s, NOW);
            assert_eq!(opts.len(), 4);
            for (i, opt) in opts.iter().enumerate() {
                let grade = (i + 1) as u8;
                let actual = apply_grade(&s, grade, NOW);
                assert_eq!(
                    opt.next_review, actual.next_review,
                    "{stage} grade {grade}: 预览 {}({}) != 实际 {}",
                    opt.human, opt.next_review, actual.next_review
                );
                assert_eq!(opt.label, ["忘了", "模糊", "记得", "太简单"][i]);
            }
        }
    }

    /// human_duration 人类可读
    #[test]
    fn human_duration_readable() {
        assert_eq!(human_duration(60_000), "1 分钟");
        assert_eq!(human_duration(600_000), "10 分钟");
        assert_eq!(human_duration(DAY_3), "3 天");
        assert_eq!(human_duration(DAY_3 * 6), "18 天");
    }

    /// is_due: 到期/未到期/无 next_review
    #[test]
    fn due_detection() {
        let mut s = state("review", DAY_3, 2.5, 3);
        s.next_review = Some(NOW - 1000);
        assert!(is_due(&s, NOW), "过去 → 到期");
        s.next_review = Some(NOW + 1000);
        assert!(!is_due(&s, NOW), "未来 → 不到期");
        s.next_review = None;
        assert!(is_due(&s, NOW), "无 next_review → 视为到期");
    }

    /// apply_outcome 写回 VocabEntry 字段全对
    #[test]
    fn outcome_applied_to_entry() {
        let s = state("new", 0, 2.5, 0);
        let o = apply_grade(&s, 3, NOW);
        let e = apply_outcome(entry(), &o);
        assert_eq!(e.stage, "review");
        assert_eq!(e.interval_ms, DAY_3);
        assert!(e.next_review.is_some());
        assert_eq!(e.next_review, Some(NOW + DAY_3));
        assert_eq!(e.last_grade, Some(3));
        assert_eq!(e.reviews, 1);
        assert_eq!(e.updated_at, NOW);
    }
}
