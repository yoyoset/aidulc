//! services/credentials.rs —— Windows Credential Manager (M1: CF token 永不落明文/不进 WebView)
//!
//! 使用 keyring crate (Windows 后端 = Credential Manager)。
//! 失败策略: 无法访问时返回错误而不是静默用空 token (避免"以为已配置实际没配置")。

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "aidulc";
const TOKEN_ACCOUNT: &str = "cf-worker-token";

pub fn save_cf_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("token 不能为空".into());
    }
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry.set_password(token).map_err(|e| format!("保存 token 失败: {e}"))
}

pub fn get_cf_token() -> Result<String, String> {
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    match entry.get_password() {
        Ok(t) => Ok(t),
        Err(KeyringError::NoEntry) => Ok(String::new()), // 未配置 = 离线模式
        Err(e) => Err(format!("读 token 失败: {e}")),
    }
}

pub fn delete_cf_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, TOKEN_ACCOUNT).map_err(|e| format!("创建凭据条目失败: {e}"))?;
    entry.delete_credential().map_err(|e| format!("删除 token 失败: {e}"))
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
