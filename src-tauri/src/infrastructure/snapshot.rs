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

// ---------------------------------------------------------------------------
// S2 (2026-11-15): 从快照恢复。
//
// 为什么不在运行中直接替换: 数据库此刻被本进程打开 (WAL 模式, 连接在全局 Mutex 里),
// 在它下面换文件会损坏数据或让所有命令报错。所以分两步: 命令只把选中的快照
// **暂存**成 `restore-pending.db`, 下次启动**开库之前**才真正替换 (见 main.rs)。
// 替换前一定先把当前库另存成 `data-before-restore-<时间>.db`, 恢复错了可以再恢复回来。
// ---------------------------------------------------------------------------

const PENDING_NAME: &str = "restore-pending.db";
const BEFORE_RESTORE_PREFIX: &str = "data-before-restore-";

/// 一份可恢复的快照 (给前端列表用)。
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotInfo {
    pub date: String,
    pub size: u64,
    /// 快照里的生词数; 读不出来 (表不存在 / 文件损坏) 为 None。
    pub vocab_count: Option<i64>,
}

/// 日期只允许 8 位数字 —— 它会拼进文件路径, 必须挡住 `..\` 之类的输入。
pub fn valid_date(s: &str) -> bool {
    s.len() == 8 && s.chars().all(|c| c.is_ascii_digit())
}

pub fn pending_restore_path(default_data_dir: &Path) -> PathBuf {
    default_data_dir.join(PENDING_NAME)
}

fn count_vocab(path: &Path) -> Option<i64> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    conn.query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
        .ok()
}

/// 列出快照, 最新的在前。目录不存在 → 空列表。
pub fn list_snapshots(default_data_dir: &Path) -> Vec<SnapshotInfo> {
    let dir = snapshot_dir(default_data_dir);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<SnapshotInfo> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        if !path.is_file() || !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) {
            continue;
        }
        let date = &name[PREFIX.len()..name.len() - SUFFIX.len()];
        if !valid_date(date) {
            continue;
        }
        out.push(SnapshotInfo {
            date: date.to_string(),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
            vocab_count: count_vocab(&path),
        });
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out
}

/// 暂存一次恢复: 校验快照 → 复制成 restore-pending.db (先写临时文件再改名)。
/// 不动当前数据库; 真正替换发生在下次启动 (`apply_pending_restore`)。
pub fn stage_restore(default_data_dir: &Path, date: &str) -> Result<(), String> {
    if !valid_date(date) {
        return Err(format!("快照日期格式不对: {date}"));
    }
    let src = snapshot_path(default_data_dir, date);
    if !src.is_file() {
        return Err(format!("找不到 {date} 的快照"));
    }
    let mut head = [0u8; 15];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&src).map_err(|e| format!("读快照失败: {e}"))?;
        f.read_exact(&mut head)
            .map_err(|e| format!("快照文件太短, 不是有效数据库: {e}"))?;
    }
    if &head != b"SQLite format 3" {
        return Err("快照不是有效的 SQLite 数据库".into());
    }
    let pending = pending_restore_path(default_data_dir);
    let tmp = default_data_dir.join(format!(".{PENDING_NAME}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    std::fs::copy(&src, &tmp).map_err(|e| format!("复制快照失败: {e}"))?;
    std::fs::rename(&tmp, &pending).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("暂存恢复失败: {e}")
    })?;
    Ok(())
}

/// 启动时 (开库**之前**) 调用。没有暂存的恢复 → Ok(None)。
/// 有 → 先把当前库另存成 `data-before-restore-<时间>.db`, 再用暂存快照替换, 返回另存路径。
/// 另存失败就**不替换** (宁可不恢复, 也不能在没有退路时覆盖现有数据)。
pub fn apply_pending_restore(
    default_data_dir: &Path,
    db_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let pending = pending_restore_path(default_data_dir);
    if !pending.is_file() {
        return Ok(None);
    }
    let mut saved: Option<PathBuf> = None;
    if db_path.is_file() {
        let dir = snapshot_dir(default_data_dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("建快照目录失败: {e}"))?;
        let backup = dir.join(format!("{BEFORE_RESTORE_PREFIX}{}{SUFFIX}", now_stamp()));
        // 优先 VACUUM INTO (会带上 WAL 里还没落盘的内容); 当前库已损坏则退回裸复制。
        let sql_path = backup.to_string_lossy().replace('\'', "''");
        let vacuumed = rusqlite::Connection::open(db_path)
            .and_then(|c| c.execute_batch(&format!("VACUUM INTO '{sql_path}'")))
            .is_ok();
        if !vacuumed {
            let _ = std::fs::remove_file(&backup);
            std::fs::copy(db_path, &backup)
                .map_err(|e| format!("另存当前数据库失败, 未恢复: {e}"))?;
        }
        saved = Some(backup);
    }
    for suffix in ["-wal", "-shm"] {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
    if db_path.exists() {
        std::fs::remove_file(db_path).map_err(|e| format!("移除当前数据库失败: {e}"))?;
    }
    std::fs::copy(&pending, db_path).map_err(|e| format!("写入恢复的数据库失败: {e}"))?;
    let _ = std::fs::remove_file(&pending);
    Ok(saved)
}

/// 当前时间 (UTC) YYYYMMDD-HHMMSS, 用于另存文件名。
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let day = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    format!(
        "{}-{:02}{:02}{:02}",
        ymd_from_unix_days(day),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count_rows(db_file: &Path) -> i64 {
        let c = rusqlite::Connection::open(db_file).unwrap();
        c.query_row("SELECT COUNT(*) FROM restore_probe", [], |r| r.get(0))
            .unwrap()
    }

    /// 造一个带 restore_probe 表的库, 返回 (default_dir, db 文件路径, db)。
    fn seeded(name: &str, rows: i64) -> (PathBuf, PathBuf, crate::store::Db) {
        let base = tmp(name);
        let default_dir = base.join("appdata");
        std::fs::create_dir_all(&default_dir).unwrap();
        let db_file = base.join("data.db");
        let db = crate::store::Db::open(db_file.to_str().unwrap()).unwrap();
        {
            let c = db.conn.lock().unwrap();
            c.execute_batch("CREATE TABLE restore_probe(x INTEGER)")
                .unwrap();
            for i in 0..rows {
                c.execute("INSERT INTO restore_probe VALUES (?1)", [i])
                    .unwrap();
            }
        }
        (default_dir, db_file, db)
    }

    #[test]
    fn snapshot_restore_roundtrip() {
        // S2 验收: 写入 1 行 → 快照 → 再写 1 行 → 暂存并应用恢复 → 读回快照时的 1 行。
        let (default_dir, db_file, db) = seeded("roundtrip", 1);
        ensure_daily_snapshot_for(&db, &default_dir, "20261101").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO restore_probe VALUES (99)", [])
            .unwrap();
        drop(db); // 恢复发生在开库之前, 这里模拟"重启"
        stage_restore(&default_dir, "20261101").unwrap();
        assert!(pending_restore_path(&default_dir).is_file());
        let saved = apply_pending_restore(&default_dir, &db_file).unwrap();
        assert!(saved.is_some());
        assert_eq!(count_rows(&db_file), 1, "应回到快照时的 1 行");
        assert!(
            !pending_restore_path(&default_dir).exists(),
            "应用后暂存文件应被清掉, 否则每次启动都会再恢复一遍"
        );
        let _ = std::fs::remove_dir_all(db_file.parent().unwrap());
    }

    #[test]
    fn snapshot_restore_keeps_pre_restore_copy() {
        // S2 验收: 恢复前的当前库(2 行)另存在快照目录, 恢复错了还能找回。
        let (default_dir, db_file, db) = seeded("keepcopy", 1);
        ensure_daily_snapshot_for(&db, &default_dir, "20261101").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO restore_probe VALUES (99)", [])
            .unwrap();
        drop(db);
        stage_restore(&default_dir, "20261101").unwrap();
        let saved = apply_pending_restore(&default_dir, &db_file)
            .unwrap()
            .expect("应返回另存路径");
        assert!(saved.starts_with(snapshot_dir(&default_dir)));
        assert!(saved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("data-before-restore-"));
        assert_eq!(count_rows(&saved), 2, "另存的是恢复前的 2 行");
        // 另存文件不能被轮转当成普通快照删掉, 也不能出现在可恢复列表里
        rotate_snapshots(&snapshot_dir(&default_dir), 1).unwrap();
        assert!(saved.is_file());
        assert!(list_snapshots(&default_dir)
            .iter()
            .all(|s| valid_date(&s.date)));
        let _ = std::fs::remove_dir_all(db_file.parent().unwrap());
    }

    #[test]
    fn stage_restore_rejects_bad_input() {
        let base = tmp("badinput");
        let dir = snapshot_dir(&base);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            stage_restore(&base, "..\\..\\x").is_err(),
            "路径穿越必须拒绝"
        );
        assert!(stage_restore(&base, "2026110").is_err(), "位数不对");
        assert!(stage_restore(&base, "20261101").is_err(), "快照不存在");
        std::fs::write(dir.join("data-20261101.db"), b"not a database at all").unwrap();
        assert!(
            stage_restore(&base, "20261101").is_err(),
            "不是 SQLite 文件"
        );
        assert!(
            !pending_restore_path(&base).exists(),
            "失败不能留下暂存文件"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn apply_without_pending_is_noop() {
        let base = tmp("nopending");
        let db_file = base.join("data.db");
        std::fs::write(&db_file, b"x").unwrap();
        assert!(apply_pending_restore(&base, &db_file).unwrap().is_none());
        assert_eq!(std::fs::read(&db_file).unwrap(), b"x");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn list_snapshots_newest_first_with_vocab_count() {
        let (default_dir, db_file, db) = seeded("list", 0);
        ensure_daily_snapshot_for(&db, &default_dir, "20261101").unwrap();
        ensure_daily_snapshot_for(&db, &default_dir, "20261103").unwrap();
        let list = list_snapshots(&default_dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].date, "20261103");
        assert_eq!(list[1].date, "20261101");
        assert_eq!(list[0].vocab_count, Some(0), "真实库里有 vocab 表");
        assert!(list[0].size > 0);
        drop(db);
        let _ = std::fs::remove_dir_all(db_file.parent().unwrap());
    }

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
