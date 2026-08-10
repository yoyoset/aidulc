//! infrastructure/sync_v1_client.rs —— 协议 v1 同步 HTTP 客户端 (V6, 2026-08-09)
//!
//! 替换 aidu_worker_client.rs (整包信封 ?profile=)。协议 v1:
//!   POST /v1/auth/device  { root_secret 或 code, device_name } → { ok, user_id, user_name, device_id, token }
//!   POST /v1/auth/code    { type: add-device|invite-user, name? } (带 token) → { ok, code, expires_in_ms }
//!   POST /v1/auth/revoke  { token } (带 token) → { ok, revoked } —— P0-C 踢掉配对设备
//!   POST /v1/sync         body { words: {word_key: 词条最小集} } → { ok, rev, wrote }
//!   GET  /v1/sync?since={rev} (带 token) → { ok, rev, changed: [...] }
//! 只做网络 I/O, 不编排 (编排在 sync_service)。
//! 只存 SRS 状态 + 词条最小集(含来源单句), 服务端绝不收书文件/整章正文。

use std::time::Duration;

const MAX_PUSH_BYTES: usize = 25 * 1024 * 1024; // KV 单值上限 25 MiB (V0② 实测)

/// P0-C (2026-08-10): 手机端 PWA 地址 (二维码内容前缀, 改部署域名时同步这里)。
/// 带尾部 `/`, 二维码内容是 `<base>/#t=<token>&u=<worker_url>` (老 AIDU 同款形态)。
pub const MOBILE_APP_URL: &str = "https://aidulc-mobile.pages.dev/";

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
    /// S2 (2026-08-10): worker 前置拒绝/中途失败时的错误码 (kv_write_quota / kv_write_failed)
    #[serde(default)]
    pub code: Option<String>,
    /// S2: 人话错误信息 (写配额超限等)
    #[serde(default)]
    pub error: Option<String>,
    /// S2: 中途失败时**实际写成功**的词条键 (不把失败当成功, 客户端按此推进 last_push_at)
    #[serde(default)]
    pub written_keys: Vec<String>,
}

/// S2 (2026-08-10): worker 能力自述 (GET /v1/capabilities) —— 推送前估算写次数用。
/// CF KV 免费档 max_writes_per_day=1000; VPS 文件存储为 null (无配额)。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub max_writes_per_day: Option<i64>,
}

/// S2: 查询 worker 能力 (写配额)。旧版 worker 无此端点 → Err, 调用方按"未知"处理
/// (不回退到强拒绝, 靠 worker 侧护栏兜底)。
pub fn capabilities(worker_url: &str) -> Result<Capabilities, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let c = client()?;
    let url = format!("{worker_url}/v1/capabilities");
    let resp = c
        .get(&url)
        .send()
        .map_err(|e| format!("查询能力失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| format!("解析能力响应失败: {e}"))?;
    serde_json::from_value(v).map_err(|e| format!("解析能力字段失败: {e}"))
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

/// P0-C (2026-08-10): 踢掉一个设备 token (手机配对后想收回)。带 caller token,
/// 服务端只允许踢同 user 的 token。返回 worker 的原始 { ok, revoked } JSON。
pub fn revoke_token(
    worker_url: &str,
    caller_token: &str,
    target_token: &str,
) -> Result<serde_json::Value, String> {
    if worker_url.is_empty() {
        return Err("未配置 CF Worker URL (离线模式)".into());
    }
    let url = format!("{worker_url}/v1/auth/revoke");
    let body = serde_json::json!({ "token": target_token });
    post_json(&url, Some(caller_token), &body)
}

/// RFC 3986 只保留 unreserved 字符的 percent-encoding, 与浏览器 `encodeURIComponent`
/// 对 `:/?&=#` 等保留字符的行为一致 (非 ASCII 按 UTF-8 逐字节编码)。用于把 worker_url
/// 安全嵌进二维码 URL 的 `u=` 参数, 手机端 `URLSearchParams` 解码后原样还原。
pub fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
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

    #[test]
    fn url_encode_component_keeps_unreserved_encodes_rest() {
        // P0-C: worker_url 嵌进二维码 u= 参数, 手机 URLSearchParams 必须能原样还原
        let raw = "https://aidulc-mobile.example.workers.dev/path?x=1&y=2#z";
        let enc = url_encode_component(raw);
        assert_eq!(
            enc,
            "https%3A%2F%2Faidulc-mobile.example.workers.dev%2Fpath%3Fx%3D1%26y%3D2%23z"
        );
        // 非 ASCII 按 UTF-8 逐字节编码 (不会原样泄漏)
        assert_eq!(url_encode_component("a/我 b"), "a%2F%E6%88%91%20b");
        // 编码后不含任何 reserved 字符 (不会破坏 #t=..&u=.. 的片段解析)
        for b in enc.bytes() {
            assert!(
                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'%'),
                "应只剩 unreserved/百分号: {enc}"
            );
        }
    }

    #[test]
    fn revoke_requires_worker_url() {
        // P0-C: 未配置时直接报错 (不发起请求)
        let err = revoke_token("", "caller", "target").unwrap_err();
        assert!(err.contains("离线"), "{err}");
    }

    #[test]
    fn mobile_pairing_url_shape() {
        // P0-C: 二维码内容形状 #t=<token>&u=<encodeURIComponent(worker_url)>
        let worker_url = "https://aidulc.example.workers.dev";
        let token = "a1b2c3";
        let content = format!(
            "{MOBILE_APP_URL}#t={token}&u={}",
            url_encode_component(worker_url)
        );
        assert!(content.starts_with("https://aidulc-mobile.pages.dev/#t="));
        assert_eq!(
            content,
            "https://aidulc-mobile.pages.dev/#t=a1b2c3&u=https%3A%2F%2Faidulc.example.workers.dev"
        );
    }
}
