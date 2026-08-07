//! domain/bookpack.rs —— schemaVersion 校验 (高版本明确拒绝, 不尽力解析)

pub const SUPPORTED_SCHEMA_VERSION: i64 = 1;

/// 校验 schemaVersion: 高于支持版本 → Err (明确拒绝)。
/// 其余字段校验交给 conformance 测试 (用 fixtures/sample_bookpack)。
pub fn check_version(raw: &serde_json::Value) -> Result<(), String> {
    let v = raw
        .get("schemaVersion")
        .and_then(|v| v.as_i64())
        .ok_or("书包缺少 schemaVersion")?;
    if v > SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "书包 schemaVersion={v} 高于本应用支持的 {SUPPORTED_SCHEMA_VERSION}, 请升级应用"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_ok() {
        assert!(check_version(&serde_json::json!({"schemaVersion": 1})).is_ok());
    }

    #[test]
    fn version_too_high_rejected() {
        let err = check_version(&serde_json::json!({"schemaVersion": 2})).unwrap_err();
        assert!(err.contains("高于"));
    }

    #[test]
    fn missing_version_rejected() {
        assert!(check_version(&serde_json::json!({})).is_err());
    }
}
