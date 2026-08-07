//! services/sync.rs —— AIDU Worker 推拉 + 离线降级 (M1)
//!
//! 协议严格对齐 aidu/worker/index.js:
//! - GET  <worker>?profile=<id>   → {vocab, dictionary, dictionaries?, meta?} | 404 {} (新 profile)
//! - POST <worker>?profile=<id>   body {vocab, dictionary, meta} → Saved
//! - Authorization: Bearer <token>
//!
//! 离线 = 本地照常用, 同步标记 pending, 不阻塞阅读。
//! 推前测体积, >15MB 界面告警 (R4)。CF 是镜像不是真相源 (新者胜, domain/sync.rs)。

use crate::domain::sync::Envelope;
use std::time::Duration;

const MAX_PAYLOAD_BYTES: usize = 15 * 1024 * 1024;

/// AIDU Worker 全量信封
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkerEnvelope {
    #[serde(default)]
    pub vocab: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub dictionary: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub meta: serde_json::Value,
}

impl Default for WorkerEnvelope {
    fn default() -> Self {
        Self {
            vocab: serde_json::Map::new(),
            dictionary: serde_json::Map::new(),
            meta: serde_json::json!({}),
        }
    }
}

impl WorkerEnvelope {
    pub fn to_envelopes(&self) -> Vec<Envelope> {
        let mut out = Vec::new();
        for (key, payload) in &self.vocab {
            out.push(Envelope {
                key: key.clone(),
                updated_at: payload
                    .get("updatedAt")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                payload: payload.clone(),
            });
        }
        out
    }

    pub fn from_entries(entries: &[(String, serde_json::Value)]) -> Self {
        let mut vocab = serde_json::Map::new();
        for (k, v) in entries {
            vocab.insert(k.clone(), v.clone());
        }
        Self {
            vocab,
            dictionary: serde_json::Map::new(),
            meta: serde_json::json!({}),
        }
    }
}

/// 推送当前 profile 到 AIDU Worker。
/// 返回 Err = 网络/超限问题; Ok(fresh) = 是否成功写入。
pub fn push_profile(
    worker_url: &str,
    token: &str,
    profile: &str,
    envelope: &WorkerEnvelope,
) -> Result<(), String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let payload = serde_json::to_vec(envelope).map_err(|e| format!("序列化失败: {e}"))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "同步 payload {:.1}MB 超过 {:.0}MB 阈值, 请减少同步条目",
            payload.len() as f64 / 1e6,
            MAX_PAYLOAD_BYTES as f64 / 1e6
        ));
    }
    let url = format!("{worker_url}?profile={}", urlencode(profile));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))?;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .body(payload.clone())
            .send()
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("网络错误: {e}"),
        }
        std::thread::sleep(Duration::from_secs(2u64.pow(attempt))); // 1s, 2s, 4s
    }
    Err(last_err)
}

/// 从 AIDU Worker 拉取当前 profile。
/// Ok(None) = 404 新 profile (无数据); Ok(Some(env)) = 远端信封。
pub fn pull_profile(worker_url: &str, token: &str, profile: &str) -> Result<Option<WorkerEnvelope>, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let url = format!("{worker_url}?profile={}", urlencode(profile));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))?;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                let v: serde_json::Value = resp.json().map_err(|e| format!("解析远端响应失败: {e}"))?;
                return Ok(Some(serde_json::from_value(v).unwrap_or_default()));
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                return Ok(None); // 新 profile
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("网络错误: {e}"),
        }
        std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
    }
    Err(last_err)
}

/// 合并本地 + 远端 → 新者胜 (domain 规则, 生产调用方直接用 domain::sync::merge_envelopes)

fn urlencode(s: &str) -> String {
    // 极简 URL 编码 (profile id 通常是字母数字)
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_worker_url_is_offline() {
        let env = WorkerEnvelope::default();
        assert!(push_profile("", "t", "default", &env).is_err());
        assert!(pull_profile("", "t", "default").is_err());
    }

    #[test]
    fn huge_payload_rejected() {
        let mut vocab = serde_json::Map::new();
        vocab.insert("k".into(), serde_json::Value::String("x".repeat(16 * 1024 * 1024)));
        let env = WorkerEnvelope { vocab, dictionary: serde_json::Map::new(), meta: serde_json::json!({}) };
        let err = push_profile("http://x", "t", "default", &env).unwrap_err();
        assert!(err.contains("超过"), "应告警 payload 超限: {err}");
    }

    #[test]
    fn urlencode_basic() {
        assert_eq!(urlencode("default"), "default");
        assert_eq!(urlencode("a b"), "a%20b");
    }

    #[test]
    fn envelope_roundtrip() {
        let mut vocab = serde_json::Map::new();
        vocab.insert("bank".into(), serde_json::json!({"word": "bank", "updatedAt": 123}));
        let env = WorkerEnvelope { vocab, dictionary: serde_json::Map::new(), meta: serde_json::json!({}) };
        let envs = env.to_envelopes();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].key, "bank");
        assert_eq!(envs[0].updated_at, 123);
        let back = WorkerEnvelope::from_entries(&[("bank".into(), serde_json::json!({"word": "bank"}))]);
        assert!(back.vocab.contains_key("bank"));
    }
}
