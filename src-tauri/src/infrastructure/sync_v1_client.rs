//! infrastructure/sync_v1_client.rs —— 协议 v1 同步 HTTP 客户端 (V6, 2026-08-09)
//!
//! 替换 aidu_worker_client.rs (整包信封 ?profile=)。协议 v1:
//!   POST /v1/auth/device  { root_secret 或 code, device_name } → { ok, user_id, user_name, device_id, token }
//!   POST /v1/auth/code    { type: add-device|invite-user, name? } (带 token) → { ok, code, expires_in_ms }
//!   POST /v1/sync         body { words: {word_key: 词条最小集} } → { ok, rev, wrote }
//!   GET  /v1/sync?since={rev} (带 token) → { ok, rev, changed: [...] }
//! 只做网络 I/O, 不编排 (编排在 sync_service)。
//! 只存 SRS 状态 + 词条最小集(含来源单句), 服务端绝不收书文件/整章正文。

use std::time::Duration;

const MAX_PUSH_BYTES: usize = 25 * 1024 * 1024; // KV 单值上限 25 MiB (V0② 实测)

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthDeviceResult {
    pub ok: bool,
    pub user_id: String,
    pub user_name: String,
    pub device_id: String,
    pub token: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MakeCodeResult {
    pub ok: bool,
    pub code: String,
    pub expires_in_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PushResult {
    pub ok: bool,
    pub rev: i64,
    pub wrote: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PullResult {
    pub ok: bool,
    pub rev: i64,
    #[serde(default)]
    pub changed: Vec<serde_json::Value>,
    #[serde(default)]
    pub deck_exists: bool,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))
}

fn auth_header(token: &str) -> String {
    format!("Bearer {token}")
}

fn post_json(
    url: &str,
    token: Option<&str>,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let c = client()?;
    let mut req = c.post(url);
    if let Some(t) = token {
        req = req.header("Authorization", auth_header(t));
    }
    let mut last_err = String::new();
    for attempt in 0..3 {
        match req
            .try_clone()
            .ok_or_else(|| "请求不可重试".to_string())?
            .json(body)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json::<serde_json::Value>()
                    .map_err(|e| format!("解析响应失败: {e}"));
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("网络错误: {e}"),
        }
        std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
    }
    Err(last_err)
}

/// 首台 (ROOT_SECRET) 或 6 位码 换第一个/新 device 的 token。
/// root_secret 与 code 二选一。
pub fn auth_device(
    worker_url: &str,
    root_secret: Option<&str>,
    code: Option<&str>,
    device_name: &str,
) -> Result<AuthDeviceResult, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let mut body = serde_json::json!({ "device_name": device_name });
    if let Some(rs) = root_secret {
        body["root_secret"] = serde_json::json!(rs);
    }
    if let Some(c) = code {
        body["code"] = serde_json::json!(c);
    }
    let url = format!("{worker_url}/v1/auth/device");
    let v = post_json(&url, None, &body)?;
    serde_json::from_value(v).map_err(|e| format!("解析 auth 响应失败: {e}"))
}

/// 已登录设备生成 6 位一次性码 (add-device / invite-user)。
pub fn make_code(
    worker_url: &str,
    token: &str,
    code_type: &str,
    name: Option<&str>,
) -> Result<MakeCodeResult, String> {
    let mut body = serde_json::json!({ "type": code_type });
    if let Some(n) = name {
        body["name"] = serde_json::json!(n);
    }
    let url = format!("{worker_url}/v1/auth/code");
    let v = post_json(&url, Some(token), &body)?;
    serde_json::from_value(v).map_err(|e| format!("解析 code 响应失败: {e}"))
}

/// 整批推送 (一次会话 O(1) 次 HTTP 写)。words: (word_key, 词条最小集 JSON)。
pub fn push(
    worker_url: &str,
    token: &str,
    words: &[(String, serde_json::Value)],
) -> Result<PushResult, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let mut map = serde_json::Map::new();
    for (k, v) in words {
        map.insert(k.clone(), v.clone());
    }
    let body = serde_json::json!({ "words": map });
    let payload = serde_json::to_vec(&body).map_err(|e| format!("序列化失败: {e}"))?;
    if payload.len() > MAX_PUSH_BYTES {
        return Err(format!(
            "同步 payload {:.1}MB 超过 KV 单值上限 {:.0}MiB, 请分批或减少条目",
            payload.len() as f64 / 1e6,
            MAX_PUSH_BYTES as f64 / (1024.0 * 1024.0)
        ));
    }
    let url = format!("{worker_url}/v1/sync");
    let v = post_json(&url, Some(token), &body)?;
    serde_json::from_value(v).map_err(|e| format!("解析 push 响应失败: {e}"))
}

/// 增量拉取: since={rev} 返回该版本后的变更。
pub fn pull(worker_url: &str, token: &str, since_rev: i64) -> Result<PullResult, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let url = format!("{worker_url}/v1/sync?since={since_rev}");
    let c = client()?;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match c
            .get(&url)
            .header("Authorization", auth_header(token))
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                let v: serde_json::Value = resp.json().map_err(|e| format!("解析响应失败: {e}"))?;
                return serde_json::from_value(v).map_err(|e| format!("解析 pull 响应失败: {e}"));
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                // 该 user 还没有 deck (新 user) → 空
                return Ok(PullResult {
                    ok: true,
                    rev: 0,
                    changed: vec![],
                    deck_exists: false,
                });
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = format!("网络错误: {e}"),
        }
        std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_url_is_offline() {
        assert!(auth_device("", None, Some("123456"), "d").is_err());
        assert!(push("", "t", &[]).is_err());
        assert!(pull("", "t", 0).is_err());
    }

    #[test]
    fn push_payload_limited_to_25mib() {
        let big = serde_json::json!({ "x": "y".repeat(26 * 1024 * 1024) });
        let err = push("http://x", "t", &[("k".into(), big)]).unwrap_err();
        assert!(err.contains("25"), "应提示超限: {err}");
    }
}
