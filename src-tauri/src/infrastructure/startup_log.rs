//! infrastructure/startup_log.rs —— P2-7 (2026-11-09): 固定位置启动日志
//!
//! 事故背景: `logs/` 原本在数据根里面, 数据根被整个删除时日志一起丢了, 事后查不到
//! 11/9 启动时到底读到了什么指针。这里每次启动都往**固定位置**
//! `%APPDATA%/aidulc/startup.log` 追加一行: 实际数据目录 / 是否回退 / 指针内容。
//!
//! 这个文件与当前数据根无关, 即使书库在 E: 盘被拔掉, 启动记录仍在。
//! 超过 1MB 时截掉前一半 (保留最近的记录), 避免无限增长。

use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 1024 * 1024;

pub fn startup_log_path(default_data_dir: &Path) -> PathBuf {
    default_data_dir.join("startup.log")
}

/// 追加一次启动记录。失败返回错误由调用方决定是否阻断 (启动流程里只记日志)。
pub fn append_startup_log(
    default_data_dir: &Path,
    data_dir: &Path,
    fell_back: bool,
    pointer: Option<&Path>,
) -> Result<(), String> {
    std::fs::create_dir_all(default_data_dir).map_err(|e| format!("建启动日志目录失败: {e}"))?;
    let path = startup_log_path(default_data_dir);
    trim_if_oversized(&path)?;
    let ts = crate::store::now_ms_for_store();
    let pointer_text = pointer
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "<none>".to_string());
    let line = format!(
        "{ts} data_dir={} fallback={} pointer={}\n",
        data_dir.to_string_lossy(),
        fell_back,
        pointer_text
    );
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开 startup.log 失败: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("写 startup.log 失败: {e}"))
}

/// 超过 1MB → 从大文件的后半段保留 (按行对齐, 不把一行/一个 UTF-8 字符切成两半)。
fn trim_if_oversized(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(()); // 文件还不存在, 无需截断
    };
    if meta.len() <= MAX_BYTES {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读 startup.log 失败: {e}"))?;
    let half = bytes.len() / 2;
    let start = bytes[half..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|i| half + i + 1)
        .unwrap_or(half);
    std::fs::write(path, &bytes[start..]).map_err(|e| format!("截断 startup.log 失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_log_written_to_default_dir() {
        // P2-7 验收: 记录写到默认数据目录下的 startup.log, 含 data_dir/是否回退/指针。
        let base = std::env::temp_dir().join(format!("aidulc_startup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let default_dir = base.join("appdata");
        let data_dir = base.join("E_drive_aidulc_data");
        append_startup_log(
            &default_dir,
            &data_dir,
            true,
            Some(Path::new("E:/aidulc_data")),
        )
        .unwrap();
        let path = startup_log_path(&default_dir);
        assert!(path.is_file(), "应写到默认目录: {}", path.display());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("data_dir={}", data_dir.to_string_lossy())));
        assert!(text.contains("fallback=true"), "got: {text}");
        assert!(text.contains("pointer=E:/aidulc_data"), "got: {text}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
