//! domain/sync.rs —— envelope 合并策略 (新者胜 / 双方独有保留)
//!
//! CF 是镜像不是真相源 (3.4): 冲突时以 SQLite 的 updatedAt 逐条新者胜, 远端只是跨设备通道。

use serde::{Deserialize, Serialize};

/// 一条待同步/已同步的条目载体
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope {
    pub key: String,
    pub updated_at: i64,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// 合并本地与远端: 新者胜; 只在一侧存在的保留。
/// 返回合并后的 (key, Envelope) 列表。
pub fn merge_envelopes(local: &[Envelope], remote: &[Envelope]) -> Vec<Envelope> {
    let mut map: std::collections::HashMap<String, Envelope> = std::collections::HashMap::new();
    for e in local {
        map.insert(e.key.clone(), e.clone());
    }
    for e in remote {
        match map.get(&e.key) {
            Some(local_e) if local_e.updated_at >= e.updated_at => {}
            _ => {
                map.insert(e.key.clone(), e.clone());
            }
        }
    }
    let mut out: Vec<Envelope> = map.into_values().collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(key: &str, updated_at: i64) -> Envelope {
        Envelope {
            key: key.into(),
            updated_at,
            payload: serde_json::json!({}),
        }
    }

    #[test]
    fn newer_local_wins() {
        let merged = merge_envelopes(&[env("a", 200)], &[env("a", 100)]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].updated_at, 200);
    }

    #[test]
    fn newer_remote_wins() {
        let merged = merge_envelopes(&[env("a", 100)], &[env("a", 200)]);
        assert_eq!(merged[0].updated_at, 200);
    }

    #[test]
    fn only_local_kept() {
        let merged = merge_envelopes(&[env("a", 100)], &[]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].key, "a");
    }

    #[test]
    fn only_remote_kept() {
        let merged = merge_envelopes(&[], &[env("b", 100)]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].key, "b");
    }

    #[test]
    fn equal_timestamp_keeps_local() {
        let merged = merge_envelopes(&[env("a", 100)], &[env("a", 100)]);
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn mixed_sets_merge() {
        let merged = merge_envelopes(
            &[env("a", 100), env("b", 50)],
            &[env("b", 200), env("c", 300)],
        );
        let keys: Vec<&str> = merged.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b", "c"]);
        assert_eq!(
            merged.iter().find(|e| e.key == "b").unwrap().updated_at,
            200
        );
    }
}
