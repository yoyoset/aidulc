//! commands/book_audit.rs —— 源书体检 (S1-S6) 的导入时把关入口
//!
//! STDIMPORT (2026-08-17, docs/GOAL_2026-08-16_STDIMPORT.md 第 3 节): 之前"导入"
//! 只是往 books 表登记一行(路径 + status=pending), 完全不碰文件内容——一本路径编码
//! 有问题、正文丢 95% 的书照样"导入成功", 要等用户点了开始处理、任务真跑起来才在
//! parse 阶段被拦下。这里把同一份判据(prep 侧 core/standard.py, Rust 不重写一遍)
//! 提前到导入这一步: 侧车 `--audit-book` 输出 JSON, 前端按 达标/警告/不达标 三色
//! 呈现, 不达标的默认不勾选。
//!
//! 判据本身刻意不在 Rust 这边实现: 它要读 EPUB、跑章节切分, 跟备料用的是同一套
//! 解析代码, 复制一份到 Rust 必然两边漂移。

use tauri::State;

/// 单本体检 (阻塞): spawn 侧车 --audit-book, 读一行 JSON。
/// 沿用 library_preview 那条链路的写法(隐藏窗口 + 读 stdout 带超时)。
fn audit_one_blocking(
    prep_path: &std::path::Path,
    source_path: &str,
) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(prep_path);
    cmd.arg("--audit-book")
        .arg(source_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let child = cmd.spawn().map_err(|e| format!("启动体检失败: {e}"))?;
    let out = crate::services::components::read_stdout_with_timeout(
        child,
        std::time::Duration::from_secs(120),
    )
    .map_err(|e| format!("读体检输出失败: {e}"))?;
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("体检无输出")?;
    serde_json::from_str(line).map_err(|e| format!("体检输出非法: {e}"))
}

/// 体检结果降级成"未知"而不是让整批导入失败 —— 侧车没装/超时不该挡住用户导入,
/// 只是拿不到把关信息(前端按"未知"呈现, 仍可导入)。
fn unknown(path: &str, why: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "title": "",
        "chapters": 0,
        "sentences": 0,
        "uncovered": 0,
        "real_missing": [],
        "severe_anomalies": [],
        "untitled": 0,
        "non_body_titles": [],
        "anomalies": [],
        "issues": [],
        "verdict": "unknown",
        "error": why,
    })
}

/// 批量体检待导入的源书。返回和入参同序、同长度的结果数组
/// (每项结构见 prep/aidulc_prep/application/book_audit.py::evaluate_book,
/// 额外可能出现 verdict="unknown" —— 侧车不可用时的降级)。
#[tauri::command]
pub async fn book_audit_sources(
    cfg: State<'_, crate::PrepConfig>,
    paths: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let prep_path = cfg.prep_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| {
                // EPUB 之外的格式(txt/pdf)判据不适用, 直接标 unknown 不去跑侧车
                let is_epub = std::path::Path::new(&p)
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("epub"))
                    .unwrap_or(false);
                if !is_epub {
                    return unknown(&p, "非 EPUB, 统一标准判据不适用");
                }
                match audit_one_blocking(&prep_path, &p) {
                    Ok(v) => v,
                    Err(e) => unknown(&p, &e),
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("体检执行失败: {e}"))
}
