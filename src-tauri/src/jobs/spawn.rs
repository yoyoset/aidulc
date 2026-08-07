//! jobs/spawn.rs —— 起 prep 侧车 + 写 job_request.json

use crate::jobs::job_guard::bind_child_to_job;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};

pub fn build_job_request(
    book_path: &str,
    out_dir: &str,
    profile: &serde_json::Value,
    models: &serde_json::Value,
) -> serde_json::Value {
    // 归一化: 兼容前端传字符串 profile ("default") 与数组 models ([])
    // (schema 要求 object —— 实测 job_request 校验失败根因, 见 2026-08-04 排查)
    let profile_obj = match profile {
        serde_json::Value::String(s) => serde_json::json!({"id": s}),
        v => v.clone(),
    };
    let models_obj = match models {
        serde_json::Value::Array(_) | serde_json::Value::Null => serde_json::json!({}),
        v => v.clone(),
    };
    serde_json::json!({
        "job_id": format!("job-{}", std::process::id()),
        "book_path": book_path,
        "out_dir": out_dir,
        "profile": profile_obj,
        "models": models_obj,
        "tokens": {"temperature": 0.3, "max_tokens": 400},
    })
}

/// 启动 prep 侧车, 绑定 Job Object, 返回 (child, NDJSON 进度行 reader)。
/// prep_path: Python 侧车启动器 (exe 或 venv python)。
pub fn spawn_prep(
    prep_path: &std::path::Path,
    job_request_path: &std::path::Path,
    out_dir: &std::path::Path,
) -> Result<(Child, Box<dyn Iterator<Item = String> + Send>), String> {
    let mut cmd = Command::new(prep_path);
    cmd.args(["--job"])
        .arg(job_request_path)
        .args(["--out"])
        .arg(out_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("启动侧车失败: {e}"))?;
    bind_child_to_job(&child);
    let stdout = child.stdout.take().ok_or("无法取得侧车 stdout")?;
    let reader = BufReader::new(stdout);
    let iter = reader.lines().filter_map(|l| l.ok());
    Ok((child, Box::new(iter)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_request_shape_matches_contract() {
        let req = build_job_request(
            "C:/book.epub",
            "C:/out",
            &serde_json::json!({"id": "self", "explain_strategy": "brief", "voice": "af_heart", "speed": 1.0, "highlight_granularity": "sentence"}),
            &serde_json::json!({"llm": "F:/m.gguf", "tts": "F:/k.pth"}),
        );
        assert_eq!(req["book_path"], "C:/book.epub");
        assert_eq!(req["profile"]["id"], "self");
        assert!(req["job_id"].as_str().is_some());
    }

    #[test]
    fn normalizes_string_profile_and_empty_models() {
        // 前端传字符串 profile + 数组 models → 归一化为 schema 要求的 object
        let req = build_job_request(
            "C:/book.txt",
            "C:/out",
            &serde_json::json!("default"),
            &serde_json::json!([]),
        );
        assert!(req["profile"].is_object(), "profile 应为 object: {req}");
        assert_eq!(req["profile"]["id"], "default");
        assert!(req["models"].is_object(), "models 应为 object: {req}");
    }
}
