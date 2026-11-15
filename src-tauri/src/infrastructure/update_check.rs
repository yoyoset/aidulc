//! infrastructure/update_check.rs —— D4 (2026-11-15): 应用本体「检查更新」
//!
//! 产品边界 (ROADMAP 里记过的决策题: 离线优先的软件要不要联网探测更新):
//! - **只在用户点「检查更新」时才联网**, 不在启动时、不在后台定时探测;
//! - 只查 GitHub Releases 的最新版本号 (一次公开 GET), **请求里不带任何用户数据**,
//!   User-Agent 是固定的通用名;
//! - 只报告"有没有新版本 + 下载页链接", 不下载、不替换、不自动更新 (那需要签名, 见 ROADMAP)。
//!
//! 版本比较和 JSON 解析都是纯函数, 单测不碰网络。

use std::time::Duration;

/// 最新发布信息的接口。仓库是公开的 (origin 即此地址)。
pub const LATEST_RELEASE_API: &str = "https://api.github.com/repos/yoyoset/aidulc/releases/latest";
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseInfo {
    /// 原始 tag, 如 "v0.2.0"
    pub tag: String,
    pub url: String,
}

/// "v0.2.0" / "0.2.0" / "0.2.0-rc1" → (0, 2, 0, 是否预发布)。解析不了返回 None。
fn parse_version(s: &str) -> Option<(u64, u64, u64, bool)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match s.split_once(['-', '+']) {
        Some((c, rest)) => (c, !rest.is_empty() && s.contains('-')),
        None => (s, false),
    };
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((major, minor, patch, pre))
}

/// latest 是否比 current 新。同一核心版本号时, 正式版比预发布版新; 任一方解析不了 → false
/// (宁可不提示, 也不要因为 tag 命名奇怪而误报"有新版本")。
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some((a, b, c, pre_l)), Some((x, y, z, pre_c))) => (a, b, c, !pre_l) > (x, y, z, !pre_c),
        _ => false,
    }
}

/// 从 GitHub `releases/latest` 的响应体里取 tag 和页面链接。
pub fn parse_release(body: &str) -> Result<ReleaseInfo, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("更新信息不是有效 JSON: {e}"))?;
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("更新信息里没有版本号 (tag_name)")?
        .to_string();
    let url = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ReleaseInfo { tag, url })
}

/// 联网取最新发布。没有任何发布 (404) → Ok(None), 不当错误。
pub fn fetch_latest() -> Result<Option<ReleaseInfo>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("aidulc-update-check")
        .build()
        .map_err(|e| format!("构建更新检查客户端失败: {e}"))?;
    let resp = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("连不上更新服务器 (可能离线): {e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("更新服务器返回 {status}"));
    }
    let body = resp.text().map_err(|e| format!("读取更新信息失败: {e}"))?;
    parse_release(&body).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_detected() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.10.0", "0.9.9"), "必须按数字比, 不能按字符串比");
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(is_newer("0.1.1", "0.1.0"));
    }

    #[test]
    fn same_or_older_is_not_newer() {
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
    }

    #[test]
    fn prerelease_is_older_than_release_of_same_core() {
        assert!(is_newer("0.2.0", "0.2.0-rc1"), "正式版比同版本预发布新");
        assert!(
            !is_newer("0.2.0-rc1", "0.2.0"),
            "预发布不能提示成比正式版新"
        );
        assert!(is_newer("0.3.0-rc1", "0.2.0"), "更高核心版本的预发布仍更新");
    }

    #[test]
    fn unparsable_tags_never_report_newer() {
        assert!(!is_newer("nightly", "0.1.0"));
        assert!(!is_newer("v0.2.0", "dev"));
        assert!(!is_newer("1.2.3.4", "0.1.0"), "四段版本号不认");
        assert!(!is_newer("", ""));
    }

    #[test]
    fn parse_release_reads_tag_and_url() {
        let r = parse_release(
            r#"{"tag_name":"v0.2.0","html_url":"https://github.com/yoyoset/aidulc/releases/tag/v0.2.0","draft":false}"#,
        )
        .unwrap();
        assert_eq!(r.tag, "v0.2.0");
        assert!(r.url.ends_with("/tag/v0.2.0"));
    }

    #[test]
    fn parse_release_rejects_missing_tag_and_bad_json() {
        assert!(parse_release(r#"{"html_url":"x"}"#).is_err());
        assert!(parse_release(r#"{"tag_name":""}"#).is_err());
        assert!(parse_release("<html>rate limited</html>").is_err());
    }

    #[test]
    fn crate_version_is_parsable() {
        // 编译期版本号必须是本模块认得的格式, 否则"检查更新"永远报"已是最新"。
        assert!(parse_version(env!("CARGO_PKG_VERSION")).is_some());
    }
}
