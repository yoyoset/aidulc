//! jobs/progress.rs —— NDJSON 解析 → 结构化进度事件 (给 Tauri event 广播)

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgressEvent {
    StageStart {
        stage: String,
        ts: i64,
    },
    StageProgress {
        stage: String,
        current: i64,
        total: i64,
        ts: i64,
    },
    StageDone {
        stage: String,
        current: i64,
        total: i64,
        ts: i64,
    },
    SentenceDone {
        sentence_index: i64,
        status: String,
        ts: i64,
    },
    JobDone {
        exit_code: i64,
        message: String,
        ts: i64,
    },
    Error {
        message: String,
        detail: Option<String>,
        ts: i64,
    },
}

pub fn parse_progress_line(line: &str) -> Result<ProgressEvent, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("NDJSON 解析失败: {e}"))?;
    let typ = v.get("type").and_then(|t| t.as_str()).ok_or("缺少 type")?;
    let ts = v.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
    let stage = v
        .get("stage")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let current = v.get("current").and_then(|c| c.as_i64()).unwrap_or(0);
    let total = v.get("total").and_then(|c| c.as_i64()).unwrap_or(0);
    match typ {
        "stage_start" => Ok(ProgressEvent::StageStart { stage, ts }),
        "stage_progress" => Ok(ProgressEvent::StageProgress {
            stage,
            current,
            total,
            ts,
        }),
        "stage_done" => Ok(ProgressEvent::StageDone {
            stage,
            current,
            total,
            ts,
        }),
        "sentence_done" => Ok(ProgressEvent::SentenceDone {
            sentence_index: v
                .get("sentence_index")
                .and_then(|s| s.as_i64())
                .unwrap_or(0),
            status: v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
            ts,
        }),
        "job_done" => Ok(ProgressEvent::JobDone {
            exit_code: v.get("exit_code").and_then(|e| e.as_i64()).unwrap_or(0),
            message: v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string(),
            ts,
        }),
        "error" => Ok(ProgressEvent::Error {
            message: v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string(),
            detail: v
                .get("detail")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string()),
            ts,
        }),
        other => Err(format!("未知事件类型: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stage_start() {
        let e = parse_progress_line(r#"{"type":"stage_start","stage":"nlp","ts":123}"#).unwrap();
        assert!(matches!(e, ProgressEvent::StageStart { stage, .. } if stage == "nlp"));
    }

    #[test]
    fn parses_sentence_done() {
        let e = parse_progress_line(
            r#"{"type":"sentence_done","sentence_index":5,"status":"ok","ts":1}"#,
        )
        .unwrap();
        assert!(
            matches!(e, ProgressEvent::SentenceDone { sentence_index: 5, status, .. } if status == "ok")
        );
    }

    #[test]
    fn parses_error_with_detail() {
        let e = parse_progress_line(
            r#"{"type":"error","message":"模型问题","detail":"GGUF 缺失","ts":1}"#,
        )
        .unwrap();
        match e {
            ProgressEvent::Error {
                message, detail, ..
            } => {
                assert_eq!(message, "模型问题");
                assert_eq!(detail.as_deref(), Some("GGUF 缺失"));
            }
            _ => panic!("应为 Error"),
        }
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(parse_progress_line(r#"{"type":"bogus","ts":1}"#).is_err());
    }
}
