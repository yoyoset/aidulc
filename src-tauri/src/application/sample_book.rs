//! application/sample_book.rs —— 内置样书 (E1, 2026-11-16)
//!
//! 随安装包发一本**带朗读**的公版样书 (Alice's Adventures in Wonderland 前三章的几个句子,
//! 1865 年公版, 原文是自己打字的, 见 contracts/fixtures/sample_book)。新用户不装任何模型就能
//! 体验"整本跟读 + 逐句高亮 + 查词", 是装完向导后的第一次成功体验。
//!
//! 资产是用真实侧车 (Qwen3-4B 讲解 + Kokoro af_heart 朗读) 跑出来的成品, 编进二进制
//! (include_bytes!, 同 dict_seed.jsonl 的做法), 不依赖 Tauri resource 路径解析。
//! 体积约 215 KB (书包 32 KB + 3 章 opus 184 KB)。
//!
//! 取代 2026-08-13 的纯文本样书 ("A Morning Walk", 无音频): 它体验不到跟读这个核心卖点。

use crate::store;

const ID: &str = "sample-book-default-1";
const SOURCE_ID: &str = "sample-book";

const BOOKPACK_JSON: &[u8] = include_bytes!("../../resources/sample_book/bookpack.json");
/// (相对书包目录的路径, 内容); 路径与 bookpack.json 里各章 audioFile 一致
const AUDIO: [(&str, &[u8]); 3] = [
    (
        "audio/ch_000.opus",
        include_bytes!("../../resources/sample_book/audio/ch_000.opus"),
    ),
    (
        "audio/ch_001.opus",
        include_bytes!("../../resources/sample_book/audio/ch_001.opus"),
    ),
    (
        "audio/ch_002.opus",
        include_bytes!("../../resources/sample_book/audio/ch_002.opus"),
    ),
];

/// 书包目录里该有的文件都在 (bookpack + 全部章节音频)。
/// 旧版 (纯文本样书) 导入过的目录只有 bookpack.json, 这里返回 false → 重新写入升级。
fn pack_complete(dir: &std::path::Path) -> bool {
    dir.join("bookpack.json").is_file() && AUDIO.iter().all(|(rel, _)| dir.join(rel).is_file())
}

fn write_pack(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir.join("audio")).map_err(|e| format!("建样书目录失败: {e}"))?;
    for (rel, bytes) in AUDIO {
        std::fs::write(dir.join(rel), bytes).map_err(|e| format!("写样书音频失败: {e}"))?;
    }
    // bookpack 最后写: 它在 = 前面的音频都已写好, 中途失败不会留下"能登记但缺音频"的半成品
    std::fs::write(dir.join("bookpack.json"), BOOKPACK_JSON)
        .map_err(|e| format!("写样书包失败: {e}"))
}

/// 导入内置样书 (幂等): 把样书包写入书库输出目录并登记为译本 (original: sample-book)。
pub fn import(cfg: &crate::PrepConfig, db: &store::Db) -> Result<serde_json::Value, String> {
    use crate::application::library_service::register_book;
    crate::infrastructure::log::info("cmd", "enter: sample_book_import");
    let pack_dir = cfg.out_dir.join("sample-book");
    if let Some(e) = store::editions_repo::EditionsRepo::new(db).get(ID) {
        // 已登记且成品齐全: 直接返回; 丢了 / 是旧版无音频样书则重写 (登记行保留, 书库不重复)
        if pack_complete(std::path::Path::new(&e.pack_dir)) {
            return Ok(serde_json::json!({
                "edition_id": ID,
                "pack_dir": e.pack_dir,
                "already": true,
            }));
        }
    }
    write_pack(&pack_dir)?;
    let registered = register_book(
        db,
        ID.to_string(),
        &pack_dir.to_string_lossy(),
        String::new(),
        SOURCE_ID.into(),
        "default".into(),
        "en".into(),
        "zh-CN".into(),
        None,
        None,
        None,
    );
    if registered.is_none() {
        return Err("样书登记失败 (bookpack 不完整?)".into());
    }
    crate::infrastructure::log::info("cmd", "exit: sample_book_import");
    Ok(serde_json::json!({
        "edition_id": ID,
        "pack_dir": pack_dir.to_string_lossy(),
        "already": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(tag: &str) -> (std::path::PathBuf, crate::PrepConfig, store::Db) {
        let root = std::env::temp_dir().join(format!("aidulc_sample_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let out_dir = root.join("jobs_out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let db = store::Db::open(root.join("t.db").to_str().unwrap()).unwrap();
        let cfg = crate::PrepConfig {
            prep_path: root.join("prep.exe"),
            out_dir,
            ffmpeg: std::path::PathBuf::new(),
        };
        (root, cfg, db)
    }

    #[test]
    fn import_writes_audio_registers_and_is_idempotent() {
        // R1 (UX5 #7) + E1: 写入 bookpack 与全部章节音频, 登记译本, 二次导入直接返回 already。
        let (root, cfg, db) = fixture("a");
        let r = import(&cfg, &db).unwrap();
        assert_eq!(r["already"], false);
        let pack = std::path::PathBuf::from(r["pack_dir"].as_str().unwrap());
        assert!(pack_complete(&pack), "书包 + 3 章音频都应写入磁盘");
        for (rel, bytes) in AUDIO {
            assert_eq!(
                std::fs::metadata(pack.join(rel)).unwrap().len() as usize,
                bytes.len(),
                "{rel} 内容应完整"
            );
        }
        let ed = store::editions_repo::EditionsRepo::new(&db)
            .get(ID)
            .expect("译本应登记");
        assert_eq!(ed.source_id, SOURCE_ID);
        assert!(store::books_repo::BooksRepo::new(&db)
            .get(SOURCE_ID)
            .is_some());
        let r2 = import(&cfg, &db).unwrap();
        assert_eq!(r2["already"], true);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn old_text_only_sample_is_upgraded_with_audio() {
        // 老用户导入过 2026-08 的无音频样书: 登记行在、目录里只有 bookpack.json。
        // 再点导入应补齐音频, 而不是因为"已登记"就原样返回。
        let (root, cfg, db) = fixture("b");
        import(&cfg, &db).unwrap();
        let pack = cfg.out_dir.join("sample-book");
        std::fs::remove_dir_all(pack.join("audio")).unwrap();
        assert!(!pack_complete(&pack));
        let r = import(&cfg, &db).unwrap();
        assert_eq!(r["already"], false, "缺音频 → 重写");
        assert!(pack_complete(&pack));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn embedded_bookpack_matches_embedded_audio() {
        // 资产自洽: 每章 audioFile 都在 AUDIO 里, 每句都成功 (样书不能自带失败句),
        // 且没有把生成机器的本地路径带进安装包。
        let bp: serde_json::Value = serde_json::from_slice(BOOKPACK_JSON).expect("合法 JSON");
        let chapters = bp["chapters"].as_array().unwrap();
        assert_eq!(chapters.len(), AUDIO.len());
        for c in chapters {
            let f = c["audioFile"].as_str().unwrap();
            assert!(AUDIO.iter().any(|(rel, _)| *rel == f), "{f} 未内置");
            for s in c["sentences"].as_array().unwrap() {
                assert_eq!(s["status"], "ok");
                assert!(s["failedStages"].as_array().is_none_or(|a| a.is_empty()));
                assert!(!s["translation"].as_str().unwrap().is_empty());
                assert!(s["audio"]["end_ms"].as_i64() > s["audio"]["start_ms"].as_i64());
            }
        }
        let text = String::from_utf8_lossy(BOOKPACK_JSON);
        assert!(
            !text.contains("hf_cache") && !text.contains("C:/Users"),
            "不能带本机路径"
        );
    }
}
