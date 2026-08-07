//! application/book_transfer_service.rs —— 书包导出/导入为 zip (P1.3-P1.4)
//!
//! 用户原话:处理过的书包"也是资产,是可以导出导入的,这样跨端也可以了"(见 docs/ROADMAP.md P1)。
//! 与 transfer_service.rs(.aidu-data 词典/生词)是不同的资产类型,独立实现不复用它。
//!
//! 导出: pack_dir 下的内容原样压缩进 zip 根(不套一层文件夹), 导入时直接解到
//! out_dir/<new_id>/ 即可复现同样的目录结构, 不需要额外剥壳逻辑。
//! 压缩用 Stored(不压缩)——音频已经是 Opus 编码过的, 再走 Deflate 只会白费 CPU
//! 还几乎不减体积, sentences.json 等文本部分量小可忽略。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn export_book_zip(pack_dir: &Path, dest_zip: &Path) -> Result<(), String> {
    if !pack_dir.is_dir() {
        return Err(format!("书包目录不存在: {}", pack_dir.display()));
    }
    let file = fs::File::create(dest_zip).map_err(|e| format!("建 zip 文件失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut entries: Vec<PathBuf> = vec![];
    collect_files(pack_dir, pack_dir, &mut entries)
        .map_err(|e| format!("遍历书包目录失败: {e}"))?;

    let mut buf = Vec::new();
    for rel in &entries {
        let abs = pack_dir.join(rel);
        let name = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(name, options)
            .map_err(|e| format!("写 zip 条目失败: {e}"))?;
        buf.clear();
        fs::File::open(&abs)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| format!("读文件失败({}): {e}", abs.display()))?;
        zip.write_all(&buf)
            .map_err(|e| format!("写 zip 内容失败: {e}"))?;
    }
    zip.finish().map_err(|e| format!("关闭 zip 失败: {e}"))?;
    Ok(())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else {
            out.push(path.strip_prefix(root).unwrap().to_path_buf());
        }
    }
    Ok(())
}

/// 解压 zip 到 out_dir/<new_id>/, 返回新书包目录的绝对路径。
/// new_id 对应目录已存在时报错(不覆盖, 与 dir_migration 的"不覆盖"纪律一致)。
pub fn import_book_zip(zip_path: &Path, out_dir: &Path, new_id: &str) -> Result<PathBuf, String> {
    let dest = out_dir.join(new_id);
    if dest.exists() {
        return Err(format!("目标目录已存在, 换个名字: {}", dest.display()));
    }
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 格式无效: {e}"))?;
    fs::create_dir_all(&dest).map_err(|e| format!("建目标目录失败: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读 zip 条目失败: {e}"))?;
        // enclosed_name() 拒绝 ".." 路径穿越/绝对路径等不安全条目, 返回 None 时跳过不解。
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("建目录失败: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建父目录失败: {e}"))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读条目内容失败: {e}"))?;
        fs::write(&out_path, &buf).map_err(|e| format!("写文件失败: {e}"))?;
    }

    if !dest.join("bookpack.json").exists() {
        let _ = fs::remove_dir_all(&dest);
        return Err("zip 内没有找到 bookpack.json, 不是有效的书包".into());
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aidulc_transfer_test_{}_{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_sample_pack(dir: &Path) {
        fs::create_dir_all(dir.join("audio")).unwrap();
        fs::write(dir.join("bookpack.json"), br#"{"title":"Alice"}"#).unwrap();
        fs::write(dir.join("sentences.json"), b"[]").unwrap();
        fs::write(dir.join("audio").join("ch_001.opus"), b"fake opus bytes").unwrap();
    }

    #[test]
    fn export_then_import_roundtrip() {
        let src = tmp_dir("src_a");
        make_sample_pack(&src);
        let zip_path = tmp_dir("zipdst_a").join("book.zip");

        export_book_zip(&src, &zip_path).unwrap();
        assert!(zip_path.exists());

        let out_dir = tmp_dir("outdir_a");
        let dest = import_book_zip(&zip_path, &out_dir, "alice_2").unwrap();
        assert_eq!(dest, out_dir.join("alice_2"));
        assert!(dest.join("bookpack.json").exists());
        assert!(dest.join("audio").join("ch_001.opus").exists());
        let content = fs::read_to_string(dest.join("bookpack.json")).unwrap();
        assert!(content.contains("Alice"));

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(zip_path.parent().unwrap());
        let _ = fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn export_missing_pack_dir_errors() {
        let missing = std::env::temp_dir().join("aidulc_does_not_exist_pack_xyz");
        let dest = tmp_dir("zipdst_b").join("book.zip");
        let err = export_book_zip(&missing, &dest).unwrap_err();
        assert!(err.contains("不存在"));
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }

    #[test]
    fn import_rejects_zip_without_bookpack() {
        let src = tmp_dir("src_c");
        fs::write(src.join("random.txt"), b"not a bookpack").unwrap();
        let zip_path = tmp_dir("zipdst_c").join("book.zip");
        export_book_zip(&src, &zip_path).unwrap();

        let out_dir = tmp_dir("outdir_c");
        let err = import_book_zip(&zip_path, &out_dir, "not_a_book").unwrap_err();
        assert!(err.contains("bookpack.json"));
        assert!(
            !out_dir.join("not_a_book").exists(),
            "校验失败应清理已解压的残留目录"
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(zip_path.parent().unwrap());
        let _ = fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn import_refuses_to_overwrite_existing_dest() {
        let src = tmp_dir("src_d");
        make_sample_pack(&src);
        let zip_path = tmp_dir("zipdst_d").join("book.zip");
        export_book_zip(&src, &zip_path).unwrap();

        let out_dir = tmp_dir("outdir_d");
        fs::create_dir_all(out_dir.join("dup")).unwrap();
        let err = import_book_zip(&zip_path, &out_dir, "dup").unwrap_err();
        assert!(err.contains("已存在"));

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(zip_path.parent().unwrap());
        let _ = fs::remove_dir_all(&out_dir);
    }
}
