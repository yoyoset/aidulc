//! infrastructure/downloader/mod.rs —— 统一下载器 (H2)
//!
//! 第一性原理: 单一下载语义 (断点续传 + sha256 校验 + .part 原子改名),
//! 不管来源是 HF resolve URL 还是 GitHub Release 资产。
//!
//! HF: https://huggingface.co/{repo}/resolve/{revision}/{file}  (支持 Range)
//! GitHub: API 解析 release 资产 URL 后走同一管道

use std::io::Write;
use std::path::{Path, PathBuf};

/// 下载文件: 断点续传 + 可选 sha256 校验 + 原子改名
/// 返回最终路径; Err = 失败 (保留 .part 供续传)
pub fn download(
    url: &str,
    dest: PathBuf,
    expected_sha256: Option<&str>,
    timeout_secs: u64,
) -> Result<PathBuf, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let part_path = dest.with_extension(format!(
        "{}.part",
        dest.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    // 已存在且校验通过 → 直接返回
    if dest.exists() {
        if let Some(sha) = expected_sha256 {
            if let Ok(h) =
                crate::infrastructure::model_store::scan::sha256_hex(&dest.to_string_lossy())
            {
                if h == sha {
                    return Ok(dest);
                }
            }
            return Err("已有文件 sha256 不匹配, 请删除后重试".into());
        }
        return Ok(dest);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))?;

    // 断点续传: 已有 .part 则从 offset 继续
    let existing = if part_path.exists() {
        std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let mut resp = if existing > 0 {
        client
            .get(url)
            .header("Range", format!("bytes={existing}-"))
            .send()
            .map_err(|e| format!("下载请求失败: {e}"))?
    } else {
        client
            .get(url)
            .send()
            .map_err(|e| format!("下载请求失败: {e}"))?
    };
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .map_err(|e| format!("打开 .part 失败: {e}"))?;
    resp.copy_to(&mut file)
        .map_err(|e| format!("写入失败: {e}"))?;
    file.flush().ok();
    drop(file);

    // sha256 校验
    if let Some(sha) = expected_sha256 {
        let h = crate::infrastructure::model_store::scan::sha256_hex(&part_path.to_string_lossy())
            .map_err(|e| format!("校验失败: {e}"))?;
        if h != sha {
            return Err(format!("sha256 不匹配: 期望 {sha}, 实得 {h}"));
        }
    }

    // 原子改名
    std::fs::rename(&part_path, &dest).map_err(|e| format!("落盘失败: {e}"))?;
    Ok(dest)
}

/// 从 GitHub Release 解析资产下载 URL
pub fn github_release_asset_url(repo: &str, tag: &str, asset: &str) -> Result<String, String> {
    // 直接构造已知 release 资产 URL (GitHub 官方 redirect, 无需 API token 也能下公开资产)
    Ok(format!(
        "https://github.com/{repo}/releases/download/{tag}/{asset}"
    ))
}

/// HF resolve URL 构造
pub fn hf_resolve_url(repo: &str, revision: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/{revision}/{file}")
}

/// 估算磁盘可用空间 (G2)
pub fn disk_free_bytes(path: &str) -> u64 {
    // Windows: GetDiskFreeSpaceExW
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut free_total);
    }
    free
}

/// 简单 GPU 检测 (是否存在 NVIDIA 驱动)
pub fn has_nvidia_gpu() -> bool {
    std::path::Path::new("C:\\Windows\\System32\\nvapi64.dll").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_url_format() {
        assert_eq!(
            hf_resolve_url("hexgrad/Kokoro-82M", "main", "kokoro-v1_0.pth"),
            "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth"
        );
    }

    #[test]
    fn github_url_format() {
        assert_eq!(
            github_release_asset_url("ggml-org/whisper.cpp", "v1.7.4", "whisper-cli.zip").unwrap(),
            "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.4/whisper-cli.zip"
        );
    }

    #[test]
    fn disk_free_returns_number() {
        let free = disk_free_bytes("C:\\");
        assert!(free > 0, "C: 盘可用空间应 > 0");
    }
}
