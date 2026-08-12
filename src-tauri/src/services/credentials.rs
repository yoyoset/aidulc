//! services/credentials.rs —— Windows Credential Manager (M1: CF token 永不落明文/不进 WebView)
//!
//! 使用 keyring crate (Windows 后端 = Credential Manager)。
//! 失败策略: 无法访问时返回错误而不是静默用空 token (避免"以为已配置实际没配置")。

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "aidulc";
const TOKEN_ACCOUNT: &str = "cf-worker-token";
const TOKEN_ACCOUNT_PREFIX: &str = "cf-worker-token-user-";
const SERVER_USER_ACCOUNT_PREFIX: &str = "cf-server-user-";
// K3 (2026-08-11): 在线 AI 引擎 API key —— 存 Credential Manager, 不落明文、不进 config.toml
const ONLINE_KEY_ACCOUNT: &str = "online-ai-key";

// TODO(未接线): V6 起 token 按 user 分账 (save_cf_token_for); 旧单 token 入口仅测试用。
#[allow(dead_code)]
pub fn save_cf_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("token 不能为空".into());
    }
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("保存 token 失败: {e}"))
}

pub fn get_cf_token() -> Result<String, String> {
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(t) => Ok(t),
        Err(KeyringError::NoEntry) => Ok(String::new()), // 未配置 = 离线模式
        Err(e) => Err(format!("读 token 失败: {e}")),
    }
}

// ---- V6 (2026-08-09): 按 user 分账 —— 每个 user 一个 token (Credential Manager 按 account 分) ----

pub fn save_cf_token_for(user_id: &str, token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("token 不能为空".into());
    }
    let account = format!("{TOKEN_ACCOUNT_PREFIX}{user_id}");
    let entry = Entry::new(SERVICE, &account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("保存 token 失败: {e}"))
}

pub fn get_cf_token_for(user_id: &str) -> Result<String, String> {
    let t0 = crate::store::now_ms_for_store();
    let account = format!("{TOKEN_ACCOUNT_PREFIX}{user_id}");
    let entry = Entry::new(SERVICE, &account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    let r = match entry.get_password() {
        Ok(t) => Ok(t),
        Err(KeyringError::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读 token 失败: {e}")),
    };
    // 2026-08-10 排查: keyring (Windows Credential Manager) 读可能慢/卡, 记录耗时
    crate::infrastructure::log::info(
        "keyring",
        &format!(
            "get_cf_token_for({user_id}) {}ms",
            crate::store::now_ms_for_store() - t0
        ),
    );
    r
}

pub fn delete_cf_token_for(user_id: &str) -> Result<(), String> {
    let account = format!("{TOKEN_ACCOUNT_PREFIX}{user_id}");
    let entry = Entry::new(SERVICE, &account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("删除 token 失败: {e}"))
}

// ---- UX5 #3 (M3, 2026-08-13): token 按 (主体, 后端) 分账 —— 一个主体可同时启用多个后端 ----
// 凭据 account 名必须对 Windows Credential Manager 安全: 用 endpoint_key 的短哈希,
// 不直接放 URL/竖线等字符。

fn endpoint_account(user_id: &str, endpoint_key: &str) -> String {
    let mut h = 0xcbf29ce484222325u64;
    for b in endpoint_key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{TOKEN_ACCOUNT_PREFIX}{user_id}-{:016x}", h)
}

pub fn save_cf_token_for_endpoint(
    user_id: &str,
    endpoint_key: &str,
    token: &str,
) -> Result<(), String> {
    if token.is_empty() {
        return Err("token 不能为空".into());
    }
    let entry = Entry::new(SERVICE, &endpoint_account(user_id, endpoint_key))
        .map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("保存 token 失败: {e}"))
}

pub fn get_cf_token_for_endpoint(user_id: &str, endpoint_key: &str) -> Result<String, String> {
    let entry = Entry::new(SERVICE, &endpoint_account(user_id, endpoint_key))
        .map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(t) => Ok(t),
        Err(KeyringError::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读 token 失败: {e}")),
    }
}

pub fn delete_cf_token_for_endpoint(user_id: &str, endpoint_key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &endpoint_account(user_id, endpoint_key))
        .map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("删除 token 失败: {e}"))
}

/// M3 迁移: 老 key (`cf-worker-token-user-{user_id}`, V6 按 user 分账, 未按后端分) →
/// 新 key (`...-{user_id}-{endpoint_hash}`)。老 key 读得到 → 迁到当前 endpoint 的新 key;
/// 迁不动 (读失败且不是"未配置") → 明确报错 (不静默丢 token)。返回是否发生过迁移。
pub fn migrate_cf_token_for(user_id: &str, endpoint_key: &str) -> Result<bool, String> {
    if endpoint_key.is_empty() {
        return Ok(false);
    }
    let old_account = format!("{TOKEN_ACCOUNT_PREFIX}{user_id}");
    let old_entry =
        Entry::new(SERVICE, &old_account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    let old = match old_entry.get_password() {
        Ok(t) if !t.is_empty() => Some(t),
        Ok(_) => None,
        Err(KeyringError::NoEntry) => None,
        Err(e) => return Err(format!("迁移 token 失败 (老凭据不可读): {e}")),
    };
    if let Some(t) = old {
        save_cf_token_for_endpoint(user_id, endpoint_key, &t)?;
        let _ = old_entry.delete_credential();
        Ok(true)
    } else {
        Ok(false)
    }
}

// ---- UX A1 (2026-08-11): 每个 user 记一份"token 属于服务端哪个 user" ----
// auth_device 返回的服务端 user_id 此前被丢掉。endpoint_key 需要它来判定"换 URL /
// 换 token 后是否还是同一份同步进度" —— 服务端 user 变了 = 是另一个人的词库, 必须
// 全量重推, 不能用旧 last_push_at 跳过。与 token 一样按 user 分账, 存 Windows Credential
// Manager (不落明文、不进 WebView)。

pub fn save_server_user_for(user_id: &str, server_user_id: &str) -> Result<(), String> {
    if server_user_id.is_empty() {
        return Ok(());
    }
    let account = format!("{SERVER_USER_ACCOUNT_PREFIX}{user_id}");
    let entry = Entry::new(SERVICE, &account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(server_user_id)
        .map_err(|e| format!("保存服务端 user 失败: {e}"))
}

pub fn get_server_user_for(user_id: &str) -> Result<String, String> {
    let account = format!("{SERVER_USER_ACCOUNT_PREFIX}{user_id}");
    let entry = Entry::new(SERVICE, &account).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(v),
        Err(KeyringError::NoEntry) => Ok(String::new()), // 从未配过 → 空
        Err(e) => Err(format!("读服务端 user 失败: {e}")),
    }
}

// ---- UX5 #3 (M3): 服务端 user 也按 (主体, 后端) 分账 —— endpoint_key = url|server_user ----

fn server_user_account(user_id: &str, url: &str) -> String {
    let mut h = 0xcbf29ce484222325u64;
    for b in url.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{SERVER_USER_ACCOUNT_PREFIX}{user_id}-{:016x}", h)
}

pub fn save_server_user_for_endpoint(
    user_id: &str,
    url: &str,
    server_user_id: &str,
) -> Result<(), String> {
    if server_user_id.is_empty() {
        return Ok(());
    }
    let entry = Entry::new(SERVICE, &server_user_account(user_id, url))
        .map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(server_user_id)
        .map_err(|e| format!("保存服务端 user 失败: {e}"))
}

pub fn get_server_user_for_endpoint(user_id: &str, url: &str) -> Result<String, String> {
    let entry = Entry::new(SERVICE, &server_user_account(user_id, url))
        .map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(v),
        Err(KeyringError::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读服务端 user 失败: {e}")),
    }
}

// TODO(未接线): 写了测试但没有 command/前端调用它 —— 界面上没有"断开 CF 同步"入口。
#[allow(dead_code)]
pub fn delete_cf_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("删除 token 失败: {e}"))
}

// ---- K3 (2026-08-11): 在线 AI 引擎 API key (OpenAI 兼容, 用户自己的 key) ----

pub fn save_online_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("API key 不能为空".into());
    }
    let entry =
        Entry::new(SERVICE, ONLINE_KEY_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .set_password(key)
        .map_err(|e| format!("保存 API key 失败: {e}"))
}

pub fn get_online_key() -> Result<String, String> {
    let entry =
        Entry::new(SERVICE, ONLINE_KEY_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(k) => Ok(k),
        Err(KeyringError::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读 API key 失败: {e}")),
    }
}

/// UX5 #6 (2026-08-13): 已接 UI —— 设置页在线引擎区的「清除在线引擎 key」按钮。
pub fn delete_online_key() -> Result<(), String> {
    let entry =
        Entry::new(SERVICE, ONLINE_KEY_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry
        .delete_credential()
        .map_err(|e| format!("删除 API key 失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_token_rejected() {
        assert!(save_cf_token("").is_err());
    }

    #[test]
    fn save_get_delete_roundtrip() {
        // 真实 Credential Manager 操作 (Windows)
        let _ = delete_cf_token();
        save_cf_token("test-token-123").expect("保存应成功");
        assert_eq!(get_cf_token().unwrap(), "test-token-123");
        delete_cf_token().expect("删除应成功");
        assert_eq!(get_cf_token().unwrap(), "", "删除后应返回空 (未配置)");
    }
}
