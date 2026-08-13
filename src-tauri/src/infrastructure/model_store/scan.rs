//! infrastructure/model_store/scan.rs —— 模型目录扫描器 (H1)
//!
//! 已实测 HF 缓存两种布局:
//! 1. 平铺: <root>/*.gguf  (subgen/comic-gen 手动放)
//! 2. HF 标准: <root>/hub/models--<owner>--<name>/snapshots/<sha>/<files>
//!
//! 扫描结果用于"复用检测": sha256/文件名/大小 匹配注册表 → 直接登记不下载。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ScannedModel {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub layout: String,          // flat | hf
    pub repo_id: Option<String>, // hf 布局的 repo
    pub commit_sha: Option<String>,
    /// 仅对 TTS (Kokoro `.pth`) 有意义: 同目录是否同时有 config.json + voices/。
    /// Some(true)=完整, Some(false)=缺依赖 (平铺只拷了 .pth), None=非 TTS 模型。
    pub complete: Option<bool>,
}

/// TTS (Kokoro) 完整性: `.pth` 同目录必须同时存在 config.json + voices/ 目录。
/// 引擎 (prep/pipeline/tts/engine.py) 在构造时硬校验这两项, 缺一即报"模型不完整"。
/// 平铺的 `F:/hf_cache/kokoro-v1_0.pth` (只有 .pth) 与 HF 快照
/// `models--hexgrad--Kokoro-82M/snapshots/<sha>/kokoro-v1_0.pth` (带 config+voices) 都能被
/// 扫到, 这里用 complete 区分, 前端据此标"⚠ 不完整"、不预勾、登记被拒。
fn kokoro_complete(path: &std::path::Path) -> Option<bool> {
    let ext = path
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "pth" {
        return None;
    }
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    Some(dir.join("config.json").is_file() && dir.join("voices").is_dir())
}

/// 扫描模型目录, 返回所有候选模型文件
pub fn scan_model_dir(root: &str) -> Vec<ScannedModel> {
    let mut out = Vec::new();
    let base = std::path::Path::new(root);
    if !base.is_dir() {
        return out;
    }

    // 1. 平铺布局: 根目录 *.gguf / *.pth
    if let Ok(rd) = std::fs::read_dir(base) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() {
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "gguf" | "pth" | "bin") {
                    if let Ok(md) = p.metadata() {
                        out.push(ScannedModel {
                            path: p.to_string_lossy().to_string(),
                            file_name: p
                                .file_name()
                                .map(|f| f.to_string_lossy().to_string())
                                .unwrap_or_default(),
                            size_bytes: md.len(),
                            layout: "flat".into(),
                            repo_id: None,
                            commit_sha: None,
                            complete: kokoro_complete(&p),
                        });
                    }
                }
            }
        }
    }

    // 2. HF 标准布局: hub/models--*/snapshots/<sha>/*
    let hub = base.join("hub");
    if hub.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&hub) {
            for e in rd.flatten() {
                let repo_dir = e.path();
                if !repo_dir.is_dir() {
                    continue;
                }
                // models--owner--name → owner/name
                let dir_name = repo_dir
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();
                let repo_id = dir_name
                    .strip_prefix("models--")
                    .map(|s| s.replace("--", "/"))
                    .unwrap_or_default();
                let snap_dir = repo_dir.join("snapshots");
                if !snap_dir.is_dir() {
                    continue;
                }
                if let Ok(rd2) = std::fs::read_dir(&snap_dir) {
                    for s in rd2.flatten() {
                        let sha_dir = s.path();
                        if !sha_dir.is_dir() {
                            continue;
                        }
                        let commit = sha_dir
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_default();
                        walk_hf_dir(&sha_dir, &repo_id, &commit, &mut out);
                    }
                }
            }
        }
    }

    out
}

fn walk_hf_dir(dir: &std::path::Path, repo_id: &str, commit: &str, out: &mut Vec<ScannedModel>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_hf_dir(&p, repo_id, commit, out);
            } else if p.is_file() {
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "gguf" | "pth" | "bin") {
                    if let Ok(md) = p.metadata() {
                        out.push(ScannedModel {
                            path: p.to_string_lossy().to_string(),
                            file_name: p
                                .file_name()
                                .map(|f| f.to_string_lossy().to_string())
                                .unwrap_or_default(),
                            size_bytes: md.len(),
                            layout: "hf".into(),
                            repo_id: Some(repo_id.to_string()),
                            commit_sha: Some(commit.to_string()),
                            complete: kokoro_complete(&p),
                        });
                    }
                }
            }
        }
    }
}

/// 计算文件 sha256 (复用检测用)
pub fn sha256_hex(path: &str) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    let mut ctx = sha2::Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读失败: {e}"))?;
        if n == 0 {
            break;
        }
        use sha2::Digest;
        ctx.update(&buf[..n]);
    }
    use sha2::Digest;
    Ok(format!("{:x}", ctx.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_flat_layout() {
        let dir = std::env::temp_dir().join(format!("aidulc_scan_flat_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.gguf"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("note.txt"), b"x").unwrap();
        let found = scan_model_dir(&dir.to_string_lossy());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].layout, "flat");
        assert_eq!(found[0].file_name, "model.gguf");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_hf_layout() {
        let dir = std::env::temp_dir().join(format!("aidulc_scan_hf_{}", std::process::id()));
        let model_dir = dir
            .join("hub")
            .join("models--owner--repo")
            .join("snapshots")
            .join("abc123");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.pth"), vec![0u8; 50]).unwrap();
        let found = scan_model_dir(&dir.to_string_lossy());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].layout, "hf");
        assert_eq!(found[0].repo_id.as_deref(), Some("owner/repo"));
        assert_eq!(found[0].commit_sha.as_deref(), Some("abc123"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sha256_hex_stable() {
        let p = std::env::temp_dir().join(format!("aidulc_sha_{}", std::process::id()));
        std::fs::write(&p, b"hello").unwrap();
        let h1 = sha256_hex(&p.to_string_lossy()).unwrap();
        let h2 = sha256_hex(&p.to_string_lossy()).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        std::fs::remove_file(&p).unwrap();
    }

    /// UX5: 平铺 .pth (缺 config.json/voices) 标 complete=false, 完整快照标 true,
    /// 非 .pth (gguf/bin) 标 None。用户实测: 平铺 kokoro 被登记当推荐 → TTS 阶段才炸。
    #[test]
    fn scan_marks_kokoro_completeness() {
        let dir = std::env::temp_dir().join(format!("aidulc_scan_cmp_{}", std::process::id()));
        // 平铺: 只有 .pth, 没有 config.json/voices
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kokoro-v1_0.pth"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("qwen.gguf"), vec![0u8; 10]).unwrap();
        // 完整快照: .pth + config.json + voices/
        let snap = dir.join("hub/models--hexgrad--Kokoro-82M/snapshots/abc123");
        std::fs::create_dir_all(snap.join("voices")).unwrap();
        std::fs::write(snap.join("kokoro-v1_0.pth"), vec![0u8; 10]).unwrap();
        std::fs::write(snap.join("config.json"), b"{}").unwrap();
        std::fs::write(snap.join("voices/af_heart.pt"), vec![0u8; 5]).unwrap();

        let found = scan_model_dir(&dir.to_string_lossy());
        let flat = found
            .iter()
            .find(|m| m.layout == "flat" && m.file_name == "kokoro-v1_0.pth");
        let gguf = found.iter().find(|m| m.file_name == "qwen.gguf");
        let snap_model = found
            .iter()
            .find(|m| m.layout == "hf" && m.file_name == "kokoro-v1_0.pth");
        assert_eq!(flat.unwrap().complete, Some(false), "平铺 .pth 应标不完整");
        assert_eq!(gguf.unwrap().complete, None, "非 .pth 无完整性概念");
        assert_eq!(snap_model.unwrap().complete, Some(true), "完整快照应标完整");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
