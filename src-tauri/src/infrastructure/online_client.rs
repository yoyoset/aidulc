//! infrastructure/online_client.rs —— 在线 AI 引擎客户端 (K3, 2026-08-11)
//!
//! OpenAI 兼容 chat/completions 调用 (覆盖 OpenAI/DeepSeek/Moonshot/OpenRouter/本地 vLLM)。
//! 用户填自己的 key, 从本机直连服务商 —— 作者的服务器不在链条里 (架构一直守的边界)。
//!
//! 用途 (三档授权里前两档, 一次一句, 用户点了才发):
//!   - 查词: 1 个词 + 所在那 1 句 (~200 字符)
//!   - 单句讲解/核对翻译: 该句 (至多带前后各 1 句) (~500 字符)
//!
//! HTTP 模式沿用 sync_v1_client (reqwest::blocking + 超时 + 重试), 不新造一套。

use serde_json::json;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// 查词元组 (与 commands::reader::LookupTuple 同构; 避免重复引入命令层类型)。
pub(crate) type LookupTuple = (
    String,
    String,
    Vec<String>,
    Vec<String>,
    Vec<String>,
    String,
    Vec<String>,
);

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("构建在线引擎客户端失败: {e}"))
}

/// 查词: 发 1 个词 + 1 句上下文, 要求返回 (词性, 音标, 释义, 例句, 例句翻译, 用法, 搭配)。
/// 与离线词典守护的 tuple 同构, 方便上游直接当离线结果用。
/// 只在用户显式点击"用在线 AI 查一次"时调用 —— 绝不自动回退 (K3 硬约束 1)。
pub fn lookup_word(
    endpoint: &str,
    api_key: &str,
    model: &str,
    word: &str,
    context: &str,
) -> Result<LookupTuple, String> {
    if endpoint.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err("在线引擎未配置".into());
    }
    let ctx = context.trim();
    let prompt = if ctx.is_empty() {
        format!(
            "你是英语精读词典。解释单词「{word}」: 返回 JSON, 字段 pos(词性), phonetic(音标), \
             meanings(释义数组), examples(例句数组, 2 条), example_zh(例句中文翻译数组), \
             usage(用法说明), phrases(常用搭配数组)。只返回 JSON。"
        )
    } else {
        format!(
            "你是英语精读词典。单词「{word}」出现在句子:「{ctx}」。结合语境解释该词: \
             返回 JSON, 字段 pos(词性), phonetic(音标), meanings(释义数组), \
             examples(例句数组, 2 条), example_zh(例句中文翻译数组), \
             usage(用法说明), phrases(常用搭配数组)。只返回 JSON。"
        )
    };
    let content = chat_completion(endpoint, api_key, model, &prompt)?;
    let cleaned = strip_json_fence(&content);
    let v: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("在线引擎响应不是有效 JSON: {e} (原文: {cleaned:.200})"))?;
    parse_lookup_json(v)
}

/// 单句讲解/核对翻译: 该句 (至多带前后各 1 句)。
/// TODO(未接线): 阅读器支撑区"在线核对这一句"按钮 (K3 三档授权第二档) —— 后续接 UI。
#[allow(dead_code)]
pub fn explain_sentence(
    endpoint: &str,
    api_key: &str,
    model: &str,
    sentence: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<String, String> {
    if endpoint.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err("在线引擎未配置".into());
    }
    let mut ctx = String::new();
    if let Some(b) = before {
        if !b.trim().is_empty() {
            ctx.push_str(&format!("前一句: {}\n", b.trim()));
        }
    }
    ctx.push_str(&format!("当前句: {}", sentence.trim()));
    if let Some(a) = after {
        if !a.trim().is_empty() {
            ctx.push_str(&format!("\n后一句: {}", a.trim()));
        }
    }
    let prompt = format!("请讲解下面这句英语 (逐词难点 + 整句翻译 + 语法要点), 用中文回答:\n{ctx}");
    chat_completion(endpoint, api_key, model, &prompt)
}

/// 连通性测试: 最小请求, 确认 endpoint+key+model 可用。
pub fn test_connection(
    endpoint: &str,
    api_key: &str,
    model: &str,
) -> Result<serde_json::Value, String> {
    if endpoint.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err("在线引擎未配置 (填 endpoint + API key + 模型名)".into());
    }
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
        "max_tokens": 8,
        "temperature": 0,
    });
    let resp = post_json(&url, api_key, &body)?;
    let reply = resp
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(json!({ "ok": true, "reply": reply, "model": model }))
}

/// OpenAI 兼容 chat/completions POST (超时 + 重试, 与 sync_v1_client::post_json 同模式)。
/// 返回模型输出的原始文本 (可能含 ```json 围栏, 由调用方决定怎么解析)。
fn chat_completion(
    endpoint: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    });
    let resp = post_json(&url, api_key, &body)?;
    resp.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(String::from)
        .ok_or_else(|| "在线引擎响应缺 content".to_string())
}

fn strip_json_fence(s: &str) -> String {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

/// 把在线引擎的 JSON 解析成 (pos, phonetic, meanings, examples, example_zh, usage, phrases)
fn parse_lookup_json(v: serde_json::Value) -> Result<LookupTuple, String> {
    let str_vec = |k: &str| -> Vec<String> {
        v.get(k)
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let meanings = str_vec("meanings");
    if meanings.is_empty() {
        return Err("在线引擎未返回释义".into());
    }
    Ok((
        v.get("pos")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        v.get("phonetic")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        meanings,
        str_vec("examples"),
        str_vec("example_zh"),
        v.get("usage")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        str_vec("phrases"),
    ))
}

/// OpenAI 兼容 POST (超时 + 3 次指数退避重试)。
fn post_json(
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let c = client()?;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match c.post(url).bearer_auth(api_key).json(body).send() {
            Ok(resp) if resp.status().is_success() => {
                return resp
                    .json::<serde_json::Value>()
                    .map_err(|e| format!("解析在线引擎响应失败: {e}"));
            }
            Ok(resp) => {
                let status = resp.status();
                last_err = if status == 401 || status == 403 {
                    format!("API key 无效 (HTTP {status})")
                } else {
                    format!("HTTP {status}")
                };
            }
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
    fn strips_json_fence() {
        assert_eq!(strip_json_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_json_fence("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_json_fence("```\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[test]
    fn parse_lookup_json_maps_tuple() {
        let v = json!({
            "pos": "NOUN", "phonetic": "/dɔː/",
            "meanings": ["门"], "examples": ["knock the door"],
            "example_zh": ["敲门"], "usage": "可数名词", "phrases": ["next door"]
        });
        let t = parse_lookup_json(v).unwrap();
        assert_eq!(t.0, "NOUN");
        assert_eq!(t.2, vec!["门"]);
        assert_eq!(t.4, vec!["敲门"]);
    }

    #[test]
    fn parse_lookup_json_rejects_empty_meanings() {
        let v = json!({"pos": "NOUN"});
        assert!(parse_lookup_json(v).is_err());
    }

    #[test]
    fn missing_config_is_clear_error() {
        assert!(lookup_word("", "", "", "door", "").is_err());
    }

    #[test]
    fn local_lookup_path_never_imports_online_client() {
        // K3 硬约束 1: 绝不自动回退 —— 本地查词失败后, 只有用户显式点"用在线 AI 查一次"
        // (单独命令 word_lookup_online) 才会发网络请求。锁住结构: 本地查词命令与用例层
        // 不认识 online_client, 编译期就没有"自动回退"的调用点。
        let reader_src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/reader.rs"),
        )
        .unwrap();
        let dict_src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/application/dictionary_service.rs"),
        )
        .unwrap();
        // 本地路径允许显式提及 (word_lookup_online 命令本身), 但 dictionary_service 决不允许
        assert!(
            !dict_src.contains("online_client") && !dict_src.contains("online_lookup"),
            "dictionary_service (本地查词路径) 不得引用在线引擎 —— 否则就存在自动回退调用点"
        );
        // 本地查词命令只在独立的 word_lookup_online 命令里引用, 不在 word_lookup 里
        let wl_start = reader_src
            .find("pub fn word_lookup")
            .or_else(|| reader_src.find("pub async fn word_lookup"));
        let wl_online_start = reader_src.find("word_lookup_online");
        if let (Some(local), Some(online)) = (wl_start, wl_online_start) {
            assert!(
                local < online,
                "word_lookup 定义应在 word_lookup_online 之前 (后者是独立命令)"
            );
        }
    }
}
