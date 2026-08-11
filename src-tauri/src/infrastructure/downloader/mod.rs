//! infrastructure/downloader/mod.rs —— 统一下载器 (H2)
//!
//! 第一性原理: 单一下载语义 (断点续传 + sha256 校验 + .part 原子改名),
//! 不管来源是 HF resolve URL 还是 GitHub Release 资产。
//!
//! HF: https://huggingface.co/{repo}/resolve/{revision}/{file}  (支持 Range)
//! GitHub: API 解析 release 资产 URL 后走同一管道

use std::io::Write;
use std::path::PathBuf;

/// 下载文件: 断点续传 + 可选 sha256 校验 + 原子改名 + 进度回调 (bytes_read, total)。
/// 返回最终路径; Err = 失败 (保留 .part 供续传)。M7 R12 起统一走带进度版本。
pub fn download_with_progress(
    url: &str,
    dest: PathBuf,
    expected_sha256: Option<&str>,
    timeout_secs: u64,
    mut on_progress: impl FnMut(u64, u64),
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
    // R12: 手动 Read 循环替代 copy_to —— 才能拿到进度
    use std::io::Read;
    let total = resp.content_length().unwrap_or(0) + existing;
    let mut buf = [0u8; 128 * 1024];
    let mut written = existing;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("读响应失败: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入失败: {e}"))?;
        written += n as u64;
        on_progress(written, total);
    }
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
// TODO(未接线): 写了测试但没有调用方 —— 需确认首次运行"自动下载缺失模型"这条路径
// 是否真的跑通, 还是只有 URL 构造函数、没有编排它们的下载流程。
#[allow(dead_code)]
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

/// J4 (2026-08-11): 把用户粘的 HF 页面/直链规范成可下载的 resolve 直链。
/// 用户给的是页面链接 (`.../blob/<rev>/<file>`) → 自动转 `.../resolve/<rev>/<file>`。
/// 转不了 (不是 HF 域名 / 结构不对) → Err, 让用户贴直链, **不静默失败**。
pub fn normalize_hf_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    // 已是 resolve 直链 → 直接用
    if t.contains("/resolve/") {
        return Ok(t.to_string());
    }
    // HF blob 页面链接: https://huggingface.co/<repo>/blob/<rev>/<file>
    let lower = t.to_lowercase();
    let host = if lower.starts_with("https://huggingface.co/") {
        "https://huggingface.co/"
    } else if lower.starts_with("http://huggingface.co/") {
        "http://huggingface.co/"
    } else {
        return Err("只支持 HuggingFace 链接 (https://huggingface.co/...)".to_string());
    };
    let rest = &t[host.len()..];
    let blob_marker = "/blob/";
    if let Some(idx) = rest.find(blob_marker) {
        // 剥掉可能的 /tree/ 前缀等, 取 blob 段
        let before = &rest[..idx]; // 不含 blob
        let after = &rest[idx + blob_marker.len()..];
        // after = <rev>/<file>; rev 可能带 @commit
        let (rev, file) = after
            .split_once('/')
            .ok_or_else(|| "blob 链接缺文件路径 (应为 …/blob/<rev>/<file>)".to_string())?;
        // 接上 hf_resolve_url (此前 TODO(未接线)): blob 页面链接 → resolve 直链
        return Ok(hf_resolve_url(before, rev, file));
    }
    // 不是 blob 也不是 resolve → 无法规范, 明确报错让用户贴直链
    Err("无法识别的 HuggingFace 链接。请用模型文件页 (…/blob/…) 或直链 (…/resolve/…)。".to_string())
}

/// 从 resolve 链接反解 (repo, revision, file) —— 校验并给出文件名 (下载落盘用)。
pub fn hf_url_parts(resolve_url: &str) -> Result<(String, String, String), String> {
    let t = resolve_url.trim();
    let prefix = "https://huggingface.co/";
    let rest = t
        .strip_prefix(prefix)
        .or_else(|| t.strip_prefix("http://huggingface.co/"))
        .ok_or_else(|| "不是 HuggingFace 链接".to_string())?;
    let marker = "/resolve/";
    let idx = rest
        .find(marker)
        .ok_or_else(|| "链接缺少 /resolve/ 段".to_string())?;
    let repo = &rest[..idx];
    let seg = &rest[idx + marker.len()..];
    let (rev, file) = seg
        .split_once('/')
        .ok_or_else(|| "resolve 链接缺文件路径".to_string())?;
    Ok((repo.to_string(), rev.to_string(), file.to_string()))
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

    #[test]
    fn normalize_blob_to_resolve() {
        // J4: 用户粘的 HF 页面 blob 链接 → 自动转 resolve 直链
        let got = normalize_hf_url(
            "https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/Qwen3-4B-Q4_K_M.gguf",
        )
        .unwrap();
        assert_eq!(
            got,
            "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
        );
    }

    #[test]
    fn normalize_passes_through_resolve() {
        assert_eq!(
            normalize_hf_url("https://huggingface.co/a/b/resolve/main/x.gguf").unwrap(),
            "https://huggingface.co/a/b/resolve/main/x.gguf"
        );
    }

    #[test]
    fn normalize_rejects_non_hf_or_malformed() {
        assert!(normalize_hf_url("https://example.com/x.gguf").is_err());
        assert!(normalize_hf_url("not a url").is_err());
    }

    #[test]
    fn url_parts_extract_repo_rev_file() {
        let (repo, rev, file) =
            hf_url_parts("https://huggingface.co/hexgrad/Kokoro-82M/resolve/v1.0/kokoro-v1_0.pth")
                .unwrap();
        assert_eq!(repo, "hexgrad/Kokoro-82M");
        assert_eq!(rev, "v1.0");
        assert_eq!(file, "kokoro-v1_0.pth");
    }
}
