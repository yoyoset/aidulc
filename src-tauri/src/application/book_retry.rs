//! application/book_retry.rs —— E2 (2026-11-15): 阅读器里「重试失败句」的入口
//!
//! 阅读器只认识书 (译本, edition id), 不认识任务。重试要落到生成这本书的那个任务上
//! (`job_retry_failed` 会按 checkpoint 只重跑失败/未完成的句子, 已成功的不重做)。
//! 这里负责从书反查任务并给出人话错误: 任务记录被清理 / 任务正在跑 等不同情况
//! 用户该做的事不一样, 不能都落成一句"任务不存在"。

use crate::store;

/// 反查后任务的状态 → 能不能重试 / 该怎么告诉用户。纯函数, 单测覆盖。
pub fn retry_blocker(status: &str) -> Option<&'static str> {
    match status {
        "done" | "failed" | "partial" | "paused" => None,
        "running" | "queued" => {
            Some("这本书正在处理中 (或已在排队), 不用再点重试, 在「处理中」页看进度")
        }
        "canceled" => Some("这本书的处理任务已被取消, 请到书库用「重新处理」重新开始"),
        _ => Some("这本书的处理任务状态异常, 请到书库用「重新处理」"),
    }
}

/// 找到生成这本书的任务并重试失败句。返回任务 id。
pub fn retry_for_book(
    app: tauri::AppHandle,
    state: &crate::PrepState,
    cfg: &crate::PrepConfig,
    db: &store::Db,
    book_id: &str,
) -> Result<String, String> {
    // 阅读器打开书用的 id 有两种: 译本 id (editions 表), 或老路径直接给书包目录
    // (处理台「打开阅读」传的是目录)。后者没有 edition 行, 就把 id 本身当 pack_dir 去匹配 output_dir。
    let pack_dir = store::editions_repo::EditionsRepo::new(db)
        .get(book_id)
        .map(|e| e.pack_dir)
        .unwrap_or_else(|| book_id.to_string());
    let job = store::jobs_repo::JobsRepo::new(db)
        .latest_for_book(book_id, &pack_dir)
        .ok_or("找不到这本书对应的处理任务 (任务记录可能已被清理), 请到书库用「重新处理」")?;
    if let Some(why) = retry_blocker(&job.status) {
        return Err(why.to_string());
    }
    let id = job.id.clone();
    crate::application::job_orchestrator::job_retry_failed(app, state, cfg, db, id.clone())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_states_can_be_retried() {
        for s in ["done", "failed", "partial", "paused"] {
            assert!(retry_blocker(s).is_none(), "{s} 应允许重试");
        }
    }

    #[test]
    fn running_and_queued_are_blocked_with_actionable_text() {
        for s in ["running", "queued"] {
            let why = retry_blocker(s).expect("应被拦住");
            assert!(why.contains("处理中"), "{why}");
        }
    }

    #[test]
    fn canceled_and_unknown_point_to_reprocess() {
        assert!(retry_blocker("canceled").unwrap().contains("重新处理"));
        assert!(retry_blocker("weird").unwrap().contains("重新处理"));
    }
}
