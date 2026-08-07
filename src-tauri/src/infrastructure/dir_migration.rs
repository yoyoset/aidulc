//! infrastructure/dir_migration.rs —— 目录树搬迁(P1.1: 换书库位置时自动搬旧数据)
//!
//! 策略与 subgen 的 migrate_models_dir 一致(该项目已实测验证过的模式, 见其
//! README"模型存放位置"一节): 同盘 rename 瞬间完成; 跨盘复制到临时名 → 核对大小/
//! 文件数 → 原子改名 → 删源文件, 任何一步中断源文件都还在原地, 不会两边都丢。
//! 单个子目录搬不动(比如目标已有同名文件、复制失败)只记一条问题继续搬下一个,
//! 不因为一个子目录卡住就让别的文件全跳过不搬——"尽力而为、不因单个失败中断整体"。
//!
//! subgen 搬的是扁平模型文件, 这里搬的是书目录树(book pack_dir 下整套
//! bookpack.json/sentences.json/audio/*), 所以复制这一步是递归的。

use std::fs;
use std::path::Path;

pub struct MigrationReport {
    /// 成功搬迁的顶层条目名
    pub moved: Vec<String>,
    /// (条目名, 失败原因)
    pub failed: Vec<(String, String)>,
}

impl MigrationReport {
    pub fn all_ok(&self) -> bool {
        self.failed.is_empty()
    }
}

/// 把 old_dir 下的全部顶层条目(文件或目录)搬到 new_dir 下, 逐条独立处理。
/// old_dir 不存在(比如全新安装、之前从没生成过书)视为无事可做, 不是错误。
pub fn migrate_directory_contents(
    old_dir: &Path,
    new_dir: &Path,
) -> Result<MigrationReport, String> {
    if !old_dir.exists() {
        return Ok(MigrationReport {
            moved: vec![],
            failed: vec![],
        });
    }
    fs::create_dir_all(new_dir).map_err(|e| format!("建目标目录失败: {e}"))?;

    let entries = fs::read_dir(old_dir).map_err(|e| format!("读旧目录失败: {e}"))?;
    let mut report = MigrationReport {
        moved: vec![],
        failed: vec![],
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let src = entry.path();
        let dst = new_dir.join(&name);
        if dst.exists() {
            report
                .failed
                .push((name, "目标位置已存在同名条目, 跳过(不覆盖)".into()));
            continue;
        }
        match migrate_one_entry(&src, &dst) {
            Ok(()) => report.moved.push(name),
            Err(e) => report.failed.push((name, e)),
        }
    }
    Ok(report)
}

fn migrate_one_entry(src: &Path, dst: &Path) -> Result<(), String> {
    // 快路径: 同盘直接 rename, 原子且瞬间完成(不区分文件/目录, Windows 两者都支持)。
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // 慢路径: 跨盘, 复制到临时名 → 核对 → 改名 → 删源。
    let tmp_dst = dst.with_extension("aidulc_migrating_tmp");
    if tmp_dst.exists() {
        fs::remove_dir_all(&tmp_dst)
            .or_else(|_| fs::remove_file(&tmp_dst))
            .map_err(|e| format!("清理残留临时目录失败: {e}"))?;
    }

    if src.is_dir() {
        copy_dir_recursive(src, &tmp_dst).map_err(|e| format!("复制失败: {e}"))?;
    } else {
        if let Some(parent) = tmp_dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建目标父目录失败: {e}"))?;
        }
        fs::copy(src, &tmp_dst).map_err(|e| format!("复制失败: {e}"))?;
    }

    // 核对: 文件数 + 总字节数(不做逐字节 hash——书目录可能有几十 GB 音频, 逐字节校验
    // 成本太高; 文件数+总大小对"复制中途截断/漏文件"这类真实故障已经足够灵敏)。
    let (src_count, src_bytes) = count_and_size(src).map_err(|e| format!("统计源失败: {e}"))?;
    let (dst_count, dst_bytes) =
        count_and_size(&tmp_dst).map_err(|e| format!("统计目标失败: {e}"))?;
    if src_count != dst_count || src_bytes != dst_bytes {
        let _ = fs::remove_dir_all(&tmp_dst).or_else(|_| fs::remove_file(&tmp_dst));
        return Err(format!(
            "复制后校验不一致(源: {src_count} 文件/{src_bytes} 字节, 目标: {dst_count} 文件/{dst_bytes} 字节), 已清理临时目录"
        ));
    }

    fs::rename(&tmp_dst, dst).map_err(|e| format!("临时目录改名失败: {e}"))?;

    // 删源(搬迁的最后一步; 万一失败, 目标已经是完整数据, 源留着不影响正确性,
    // 只是多占了旧盘空间——不因为删源失败就判定整个搬迁失败)。
    let del_result = if src.is_dir() {
        fs::remove_dir_all(src)
    } else {
        fs::remove_file(src)
    };
    if del_result.is_err() {
        // 静默: 目标已确认完整, 删源失败不影响数据正确性。
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

fn count_and_size(path: &Path) -> std::io::Result<(u64, u64)> {
    if path.is_file() {
        return Ok((1, fs::metadata(path)?.len()));
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            let (c, b) = count_and_size(&entry.path())?;
            count += c;
            bytes += b;
        } else {
            count += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((count, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("aidulc_migtest_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn old_dir_missing_is_noop_not_error() {
        let old = std::env::temp_dir().join("aidulc_definitely_does_not_exist_xyz");
        let new = tmp_dir("new_a");
        let report = migrate_directory_contents(&old, &new).unwrap();
        assert!(report.moved.is_empty());
        assert!(report.failed.is_empty());
        let _ = fs::remove_dir_all(&new);
    }

    #[test]
    fn moves_book_directory_tree_same_volume() {
        let old = tmp_dir("old_b");
        let new = tmp_dir("new_b");
        // 模拟一本书: book1/bookpack.json + book1/audio/ch1.opus
        let book_dir = old.join("book1");
        fs::create_dir_all(book_dir.join("audio")).unwrap();
        fs::write(book_dir.join("bookpack.json"), b"{}").unwrap();
        fs::write(book_dir.join("audio").join("ch1.opus"), b"fake audio bytes").unwrap();

        let report = migrate_directory_contents(&old, &new).unwrap();
        assert!(report.all_ok(), "应全部成功: {:?}", report.failed);
        assert_eq!(report.moved, vec!["book1".to_string()]);
        assert!(new.join("book1").join("bookpack.json").exists());
        assert!(new.join("book1").join("audio").join("ch1.opus").exists());
        assert!(!old.join("book1").exists(), "源应已删除(rename 语义)");

        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new);
    }

    #[test]
    fn existing_dest_entry_is_skipped_not_overwritten() {
        let old = tmp_dir("old_c");
        let new = tmp_dir("new_c");
        fs::create_dir_all(old.join("book1")).unwrap();
        fs::write(old.join("book1").join("marker.txt"), b"source").unwrap();
        fs::create_dir_all(new.join("book1")).unwrap();
        fs::write(
            new.join("book1").join("marker.txt"),
            b"already here, do not overwrite",
        )
        .unwrap();

        let report = migrate_directory_contents(&old, &new).unwrap();
        assert!(report.moved.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "book1");
        let kept = fs::read_to_string(new.join("book1").join("marker.txt")).unwrap();
        assert_eq!(
            kept, "already here, do not overwrite",
            "不能覆盖目标已有数据"
        );

        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new);
    }

    #[test]
    fn one_entry_failing_does_not_block_others() {
        let old = tmp_dir("old_d");
        let new = tmp_dir("new_d");
        fs::create_dir_all(old.join("book_ok")).unwrap();
        fs::write(old.join("book_ok").join("f.txt"), b"data").unwrap();
        fs::create_dir_all(old.join("book_conflict")).unwrap();
        fs::create_dir_all(new.join("book_conflict")).unwrap(); // 预置冲突

        let report = migrate_directory_contents(&old, &new).unwrap();
        assert_eq!(report.moved, vec!["book_ok".to_string()]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "book_conflict");
        assert!(new.join("book_ok").join("f.txt").exists());

        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new);
    }

    #[test]
    fn count_and_size_recursive_matches_manual_count() {
        let d = tmp_dir("count_e");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("a.txt"), b"12345").unwrap(); // 5 bytes
        fs::write(d.join("sub").join("b.txt"), b"1234567890").unwrap(); // 10 bytes
        let (count, bytes) = count_and_size(&d).unwrap();
        assert_eq!(count, 2);
        assert_eq!(bytes, 15);
        let _ = fs::remove_dir_all(&d);
    }
}
