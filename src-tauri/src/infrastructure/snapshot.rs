//! infrastructure/snapshot.rs —— P0-2 (2026-11-09): 数据库每日快照
//!
//! 事故背景: 数据根目录被永久删除时, `backups/` 和 `logs/` 都在根目录里面, 一起丢了,
//! 事后既没有可恢复的备份也没有日志。这里把**数据库快照放到数据根外面**
//! (`%APPDATA%/aidulc/snapshots/`), 数据根换到 E: 盘、移动硬盘没插都不影响它。
//!
//! 策略:
//! - 每天第一次启动时 `VACUUM INTO` 一份一致性快照 (WAL 下裸复制会丢未 checkpoint 数据)
//! - 命名 `data-YYYYMMDD.db`, 只保留最新 7 份
//! - 失败只记日志, 绝不阻断启动 (快照是保护措施, 不是启动前提)

use std::path::{Path, PathBuf};

pub const KEEP_SNAPSHOTS: usize = 7;
const PREFIX: &str = "data-";
const SUFFIX: &str = ".db";

/// 快照目录: 固定在默认数据目录下, 与当前数据根无关。
pub fn snapshot_dir(default_data_dir: &Path) -> PathBuf {
    default_data_dir.join("snapshots")
}

/// 某个日期的快照路径 (date 形如 20261109)。
pub fn snapshot_path(default_data_dir: &Path, date: &str) -> PathBuf {
    snapshot_dir(default_data_dir).join(format!("{PREFIX}{date}{SUFFIX}"))
}

/// 轮转快照: 只保留最新的 `keep` 份 (按文件名里的日期排序)。
/// 返回删除的份数。只处理 `data-YYYYMMDD.db`, 不碰目录里的其它文件。
pub fn rotate_snapshots(dir: &Path, keep: usize) -> std::io::Result<usize> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        if !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) {
            continue;
        }
        let date = &name[PREFIX.len()..name.len() - SUFFIX.len()];
        if date.len() != 8 || !date.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        files.push((date.to_string(), path));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut removed = 0usize;
    while files.len() > keep {
        let (_, path) = files.remove(0);
        std::fs::remove_file(path)?;
        removed += 1;
    }
    Ok(removed)
}

/// 每天第一次启动时创建快照。今天已有快照则什么都不做 (但仍会顺手轮转)。
/// 返回新快照路径; 今天已有 / 失败 → Err 或 Ok(None)。
pub fn ensure_daily_snapshot(
    db: &crate::store::Db,
    default_data_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    ensure_daily_snapshot_for(db, default_data_dir, &today_ymd())
}

/// 可注入日期的版本 (单测用)。
pub fn ensure_daily_snapshot_for(
    db: &crate::store::Db,
    default_data_dir: &Path,
    date: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = snapshot_dir(default_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建快照目录失败: {e}"))?;
    let final_path = snapshot_path(default_data_dir, date);
    if final_path.is_file() {
        let _ = rotate_snapshots(&dir, KEEP_SNAPSHOTS);
        return Ok(None);
    }

    // 先 VACUUM 到临时文件, 成功后再改名: 中间崩了不会留下一个看似完整的半份快照。
    let tmp_path = dir.join(format!(".{PREFIX}{date}{SUFFIX}.tmp"));
    let _ = std::fs::remove_file(&tmp_path);
    let sql_path = tmp_path.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{}'", sql_path);
    {
        let conn = db.conn.lock().map_err(|_| "数据库锁已损坏".to_string())?;
        if let Err(e) = conn.execute_batch(&sql) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("数据库快照失败: {e}"));
        }
    }
    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("快照改名失败: {e}"));
    }
    rotate_snapshots(&dir, KEEP_SNAPSHOTS).map_err(|e| format!("快照轮转失败: {e}"))?;
    Ok(Some(final_path))
}

/// 当前本地日期 YYYYMMDD (不引入 chrono, 用 civil-from-days 标准算法)。
fn today_ymd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    ymd_from_unix_days(secs.div_euclid(86_400))
}

/// 1970-01-01 起的天数 → YYYYMMDD (Howard Hinnant 的 civil_from_days)。
fn ymd_from_unix_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}{m:02}{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aidulc_snap_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn snapshot_rotates_keeps_7() {
        // P0-2 验收: 造 9 份 → 只剩最新 7 份, 最老的 2 份被删。
        let dir = tmp("rotate");
        for day in 1..=9 {
            std::fs::write(dir.join(format!("data-2026110{day}.db")), b"x").unwrap();
        }
        // 混一个非快照文件, 轮转不能动它。
        std::fs::write(dir.join("keep-me.txt"), b"x").unwrap();
        let removed = rotate_snapshots(&dir, KEEP_SNAPSHOTS).unwrap();
        assert_eq!(removed, 2, "应删掉最老的 2 份");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names.len(), 8, "7 份快照 + keep-me.txt");
        assert!(!names.contains(&"data-20261101.db".to_string()));
        assert!(!names.contains(&"data-20261102.db".to_string()));
        assert!(names.contains(&"data-20261109.db".to_string()));
        assert!(names.contains(&"keep-me.txt".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_outside_data_root() {
        // P0-2 验收: 快照落在默认数据目录下, 而不是当前数据根里面
        // (数据根被整个删掉时, 快照仍然在)。
        let base = tmp("outside");
        let default_dir = base.join("appdata");
        let data_root = base.join("data_root");
        std::fs::create_dir_all(&default_dir).unwrap();
        std::fs::create_dir_all(&data_root).unwrap();
        let db_file = data_root.join("data.db");
        let db = crate::store::Db::open(db_file.to_str().unwrap()).unwrap();
        let path = ensure_daily_snapshot_for(&db, &default_dir, "20261109")
            .unwrap()
            .expect("今天第一次应生成快照");
        assert!(path.starts_with(snapshot_dir(&default_dir)), "{path:?}");
        assert!(!path.starts_with(&data_root), "快照不能放在数据根里");
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            bytes.starts_with(b"SQLite format 3"),
            "快照应是有效 SQLite 文件"
        );
        // 同一天第二次调用不重复生成
        assert!(ensure_daily_snapshot_for(&db, &default_dir, "20261109")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&base);
    }
}
