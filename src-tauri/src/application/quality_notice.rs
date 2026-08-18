//! application/quality_notice.rs —— quality_report.json 的读取与解释
//!
//! 两件事: (1) 失败句"真实阶段"过滤 (消费方共享判据); (2) quality_summary ——
//! 从报告生成给用户看的人话失败摘要。后者 2026-08-18 从 job_orchestrator.rs 挪来:
//! 它整个函数只做"读 quality_report.json 并解释", 和这里的过滤判据是同一个域,
//! 放在编排逻辑里既不内聚、也让那个文件继续膨胀。
//!
//! A2 (2026-08-18): prep 侧新跑的书不再把 nlp_realign 写进 failedSentences, 但磁盘上
//! 已有 10 本书的 quality_report.json 仍混着它, 不能要求用户重跑一遍才看对数字。
//! 三个消费方 (书库卡片 / 任务失败原因 / 前端任务详情) 数失败句时都走这里, 排除
//! stages **只含** nlp_realign 的条目 —— 条目若同时含 nlp_realign 和真实阶段, 仍算失败。

use serde_json::Value;

/// prep 侧记账用的伪阶段名。2026-08-18 起新跑的书不会再产出它 (改走 quality 的
/// notice 通道), 这里只为读懂**存量**报告而保留。
pub const NOTICE_STAGE: &str = "nlp_realign";

/// 过滤失败句: 返回 stages 里**不只含** nlp_realign 的条目引用。
/// stages 缺失/为空/含非字符串项的条目无从排除, 按真实失败算 —— 这些条目带着
/// reason, 确实是记下来的失败, 宁可多报也不要静默吞掉。
pub fn real_failures(arr: &[Value]) -> Vec<&Value> {
    arr.iter().filter(|f| is_real_failure(f)).collect()
}

/// 单个失败句是否算真实失败: stages 数组里存在任意非 nlp_realign 的阶段。
fn is_real_failure(f: &Value) -> bool {
    match f.get("stages").and_then(|s| s.as_array()) {
        None => true,
        Some(stages) if stages.is_empty() => true,
        Some(stages) => stages
            .iter()
            .any(|s| s.as_str().map(|n| n != NOTICE_STAGE).unwrap_or(true)),
    }
}

/// I-C: 从 quality_report.json 生成失败摘要 (失败句数 + 涉及阶段 + 前 3 条原因)
pub fn quality_summary(out_dir: &str) -> Option<String> {
    let path = std::path::Path::new(out_dir).join("quality_report.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    // I-C: 阶段级错误优先 (pack 超时/完整性校验等, 不是句级失败)
    if let Some(err) = v
        .get("error")
        .and_then(|e| e.as_str())
        .filter(|e| !e.is_empty())
    {
        return Some(err.to_string());
    }
    let failed_sents = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|a| real_failures(a).len())
        .unwrap_or(0);
    let stages = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|arr| {
            let mut set: Vec<String> = Vec::new();
            // A2: 历史报告里 stages 只含 nlp_realign 的条目不算失败, 也不进阶段列表
            for f in real_failures(arr) {
                if let Some(ss) = f.get("stages").and_then(|s| s.as_array()) {
                    for s in ss {
                        if let Some(name) = s.as_str() {
                            // 混合条目 (如 ["tts","nlp_realign"]) 本身算失败, 但
                            // nlp_realign 这个名字不该出现在给用户看的阶段列表里
                            if name == NOTICE_STAGE {
                                continue;
                            }
                            if !set.contains(&name.to_string()) {
                                set.push(name.to_string());
                            }
                        }
                    }
                }
            }
            set
        })
        .unwrap_or_default();
    let reasons: Vec<String> = v
        .get("failedSentences")
        .and_then(|a| a.as_array())
        .map(|arr| {
            // A2: 与句数/阶段同一判据 —— 只采样真实失败的 reason
            real_failures(arr)
                .into_iter()
                .filter_map(|f| f.get("reason").and_then(|r| r.as_str()).map(String::from))
                .filter(|r| !r.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let reason_sample = reasons
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    if failed_sents == 0 && stages.is_empty() {
        return Some("任务失败 (bookpack 未生成)".into());
    }
    Some(format!(
        "{} 句有失败阶段 ({}){}",
        failed_sents,
        stages.join(", "),
        if reason_sample.is_empty() {
            String::new()
        } else {
            format!(": {reason_sample}")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(stages: &[&str]) -> Value {
        serde_json::json!({ "index": 0, "stages": stages })
    }

    #[test]
    fn all_nlp_realign_filtered_out() {
        // A2: 历史产物里 stages 只含 nlp_realign 的条目一律不算失败
        let arr = vec![
            entry(&["nlp_realign"]),
            entry(&["nlp_realign", "nlp_realign"]),
        ];
        assert!(real_failures(&arr).is_empty());
    }

    #[test]
    fn mixed_keeps_entries_with_real_stages() {
        // A2: 同时含 nlp_realign 和真实阶段的条目仍算失败
        let arr = vec![
            entry(&["nlp_realign"]),
            entry(&["tts", "nlp_realign"]),
            entry(&["nlp_realign", "parse"]),
            entry(&["tts"]),
        ];
        let kept = real_failures(&arr);
        assert_eq!(kept.len(), 3);
        assert!(kept.iter().all(|f| !f["stages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s == "nlp_realign")));
    }

    #[test]
    fn no_nlp_realign_keeps_all() {
        let arr = vec![entry(&["tts"]), entry(&["parse", "tts"])];
        assert_eq!(real_failures(&arr).len(), 2);
    }

    #[test]
    fn empty_stages_counts_as_real_failure() {
        // 空 stages 数组和 stages 缺失是同一类: 无从排除, 按真实失败算
        // (原实现这里返回 false, 和函数文档写的相反 —— 会静默少报)
        let arr = vec![serde_json::json!({"index": 0, "stages": []})];
        assert_eq!(real_failures(&arr).len(), 1);
    }

    #[test]
    fn missing_stages_counts_as_real_failure() {
        // stages 缺失 → 无从排除, 按真实失败算 (存量报告也有一批不带 stages 的条目)
        let arr = vec![serde_json::json!({"index": 0}), entry(&["nlp_realign"])];
        assert_eq!(real_failures(&arr).len(), 1);
    }
}
