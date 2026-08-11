//! infrastructure/data_migration.rs —— J0 (2026-08-11): 数据目录迁移
//!
//! 背景 (实测): 书库 (jobs_out, 976 MB) 与数据库 (data.db) 默认落在 `exe_dir` 下,
//! 开发构建的 exe_dir 就是 `target/release` —— 一次 `cargo clean` 全删。
//! 修复: 默认落用户数据目录 (`%APPDATA%/aidulc/`), exe_dir 只在便携模式下使用。
//!
//! 安全纪律 (GOAL_2026-08-11_UX2 数据安全):
//!   1. 迁移前自动备份 (export_aidu_data → 时间戳备份文件, 路径告诉用户);
//!   2. 迁移必须是「复制 → 校验 → 再删原件」, 绝不用 move;
//!   3. 校验不过就保留原件并报错;
//!   4. 先 dry-run (status) 显示"将影响 N 条", 用户确认后才执行。
//!
//! 两阶段设计 (避免"开着数据库删自己"的文件锁问题):
//!   - Phase 1 (本会话, migration_run): 备份 + 复制 jobs_out/data.db/config.toml +
//!     校验, 然后写 `migration_done.json` 标记 (记录旧路径), 返回 restart_required。
//!     旧文件先不删 (data.db 正被本会话持有, Windows 锁着删不掉)。
//!   - Phase 2 (下次启动, cleanup_pending): 数据库还没开, 旧文件解锁 →
//!     按标记删旧 jobs_out / data.db(-wal/-shm) / config.toml → 删标记。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 迁移完成后写下的标记: 记录旧路径, 供下次启动清理旧文件。
#[derive(Serialize, Deserialize)]
pub struct MigrationMarker {
    pub legacy_out: PathBuf,
    pub legacy_db: PathBuf,
    pub legacy_cfg: PathBuf,
}

/// J0: 一次迁移的完整计划 (前端提示 + migration_run 执行用)。
#[derive(Clone, serde::Serialize)]
pub struct MigrationPlan {
    pub legacy_out: PathBuf,
    pub legacy_db: PathBuf,
    pub legacy_cfg: PathBuf,
    pub target_out: PathBuf,
    pub target_db: PathBuf,
    pub target_cfg: PathBuf,
}

pub fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("migration_done.json")
}

/// 下次启动时执行: 旧文件已解锁, 按标记清理。幂等, 不存在即无事可做。
pub fn cleanup_pending(data_dir: &Path) -> Result<(), String> {
    let marker = marker_path(data_dir);
    if !marker.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&marker).map_err(|e| format!("读迁移标记失败: {e}"))?;
    let m: MigrationMarker =
        serde_json::from_str(&text).map_err(|e| format!("解析迁移标记失败: {e}"))?;
    for p in [&m.legacy_out, &m.legacy_db, &m.legacy_cfg] {
        remove_any(p);
    }
    // WAL/SHM 跟着 data.db 走
    remove_any(&with_suffix(&m.legacy_db, "-wal"));
    remove_any(&with_suffix(&m.legacy_db, "-shm"));
    let _ = fs::remove_file(&marker);
    crate::infrastructure::log::info(
        "migration",
        &format!("已清理旧位置: {}", m.legacy_out.to_string_lossy()),
    );
    Ok(())
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

fn remove_any(p: &Path) {
    if p.is_dir() {
        let _ = fs::remove_dir_all(p);
    } else {
        let _ = fs::remove_file(p);
    }
}

/// 递归复制目录树, 复制后按文件数+总字节校验, 校验不过返回错误 (源不受影响)。
pub fn copy_tree_with_verify(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(()); // 旧位置没有 jobs_out = 无事可做
    }
    fs::create_dir_all(dst).map_err(|e| format!("建目标目录失败: {e}"))?;
    copy_tree_recursive(src, dst).map_err(|e| format!("复制失败: {e}"))?;
    let (sc, sb) = count_and_size(src).map_err(|e| format!("统计源失败: {e}"))?;
    let (dc, db) = count_and_size(dst).map_err(|e| format!("统计目标失败: {e}"))?;
    if sc != dc || sb != db {
        return Err(format!(
            "复制后校验不一致 (源: {sc} 文件/{sb} 字节, 目标: {dc} 文件/{db} 字节), 源保持不变"
        ));
    }
    Ok(())
}

fn copy_tree_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            fs::create_dir_all(&dst_path)?;
            copy_tree_recursive(&entry.path(), &dst_path)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

pub fn count_and_size(path: &Path) -> std::io::Result<(u64, u64)> {
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

/// 顶层条目数 (dry-run 展示"将影响 N 个目录/文件")
pub fn top_level_count(path: &Path) -> u64 {
    if !path.is_dir() {
        return 0;
    }
    fs::read_dir(path)
        .map(|it| it.flatten().count() as u64)
        .unwrap_or(0)
}

pub fn dir_size(path: &Path) -> u64 {
    count_and_size(path).map(|(_, b)| b).unwrap_or(0)
}

/// 执行迁移 (Phase 1): 备份 → 复制 jobs_out → 复制 data.db → 写 config.toml → 写标记。
/// 本函数在应用运行期调用 (数据库已打开), 所以 data.db 用 SQLite 在线备份
/// (`VACUUM INTO`) 拿一致性快照, 而不是裸文件复制 (WAL 模式下裸复制会丢未 checkpoint 数据)。
/// 旧文件不在此删除 (data.db 正被本会话持有, Windows 锁着), 交给下次启动 cleanup_pending。
pub fn run_migration(
    db: &crate::store::Db,
    plan: &MigrationPlan,
) -> Result<MigrationReport, String> {
    use std::io::Write;
    crate::infrastructure::log::info("migration", "开始迁移数据目录");

    // 1. 备份 (数据安全第 1 条: 执行前自动备份, 路径告诉用户)
    fs::create_dir_all(&plan.target_out).map_err(|e| format!("建目标目录失败: {e}"))?;
    let backup_dir = plan
        .target_cfg
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("backups");
    fs::create_dir_all(&backup_dir).map_err(|e| format!("建备份目录失败: {e}"))?;
    let backup_path = backup_dir.join(format!(
        "aidulc-backup-{}.aidu-data",
        crate::store::now_ms_for_store()
    ));
    {
        let data = crate::application::transfer_service::export_aidu_data(db)
            .map_err(|e| format!("备份失败: {e}"))?;
        let mut f =
            std::fs::File::create(&backup_path).map_err(|e| format!("写备份文件失败: {e}"))?;
        f.write_all(
            serde_json::to_string_pretty(&data)
                .unwrap_or_default()
                .as_bytes(),
        )
        .map_err(|e| format!("写备份文件失败: {e}"))?;
    }
    crate::infrastructure::log::info(
        "migration",
        &format!("备份已写入: {}", backup_path.to_string_lossy()),
    );

    // 2. 复制 jobs_out (复制 → 校验 → 源保留, 删除交给 cleanup_pending)
    let out_moved = top_level_count(&plan.legacy_out);
    copy_tree_with_verify(&plan.legacy_out, &plan.target_out)?;

    // 3. 复制 data.db: SQLite 在线备份 VACUUM INTO → 一致性快照
    {
        let conn = db.conn.lock().unwrap();
        let sql = format!(
            "VACUUM INTO '{}'",
            plan.target_db.to_string_lossy().replace('\'', "''")
        );
        conn.execute_batch(&sql)
            .map_err(|e| format!("复制数据库失败: {e}"))?;
        // 校验: 打开新库确认可读
        let check = rusqlite::Connection::open(&plan.target_db)
            .map_err(|e| format!("校验新数据库失败: {e}"))?;
        check
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| format!("校验新数据库失败: {e}"))?;
    }

    // 4. 写新 config.toml (沿用旧配置字段, out_dir 指向新位置)
    {
        let old_cfg_text = fs::read_to_string(&plan.legacy_cfg).unwrap_or_default();
        let mut cfg: crate::services::config::Config =
            toml::from_str(&old_cfg_text).unwrap_or_default();
        cfg.out_dir = plan.target_out.clone();
        if let Some(parent) = plan.target_cfg.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("建配置目录失败: {e}"))?;
        }
        let text = toml::to_string_pretty(&cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
        fs::write(&plan.target_cfg, text).map_err(|e| format!("写新配置失败: {e}"))?;
    }

    // 5. 写迁移完成标记 (Phase 2 清理旧文件用)
    let marker = MigrationMarker {
        legacy_out: plan.legacy_out.clone(),
        legacy_db: plan.legacy_db.clone(),
        legacy_cfg: plan.legacy_cfg.clone(),
    };
    let marker_text = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
    fs::write(
        marker_path(
            plan.target_cfg
                .parent()
                .unwrap_or_else(|| std::path::Path::new(".")),
        ),
        marker_text,
    )
    .map_err(|e| format!("写迁移标记失败: {e}"))?;

    crate::infrastructure::log::info(
        "migration",
        &format!(
            "迁移完成: jobs_out {} 项 → {}, 数据库 → {}, 标记已写, 待重启清理旧文件",
            out_moved,
            plan.target_out.to_string_lossy(),
            plan.target_db.to_string_lossy()
        ),
    );
    Ok(MigrationReport {
        backup_path: backup_path.to_string_lossy().to_string(),
        out_moved,
        target_out: plan.target_out.to_string_lossy().to_string(),
        target_db: plan.target_db.to_string_lossy().to_string(),
    })
}

/// 迁移执行结果 (返回给前端展示 + 提示重启)。
#[derive(serde::Serialize)]
pub struct MigrationReport {
    pub backup_path: String,
    pub out_moved: u64,
    pub target_out: String,
    pub target_db: String,
}

/// dry-run: 将影响多少项 (前端确认文案用, 不实际改动)。
pub fn dry_run(plan: &MigrationPlan) -> serde_json::Value {
    serde_json::json!({
        "out_items": top_level_count(&plan.legacy_out),
        "out_bytes": dir_size(&plan.legacy_out),
        "db_exists": plan.legacy_db.exists(),
        "db_bytes": std::fs::metadata(&plan.legacy_db).map(|m| m.len()).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aidulc_dm_{}_{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copy_tree_roundtrip_with_verify() {
        let src = tmp("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"bbbb").unwrap();
        let dst = tmp("dst");
        copy_tree_with_verify(&src, &dst).unwrap();
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"aaa");
        assert_eq!(fs::read(dst.join("sub").join("b.txt")).unwrap(), b"bbbb");
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn missing_source_is_noop() {
        let src = std::env::temp_dir().join("aidulc_definitely_missing_xyz");
        // dst 不能预先存在 (否则断言"未创建"失效), 用全新路径
        let dst = std::env::temp_dir().join(format!(
            "aidulc_dm_dst2_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dst);
        copy_tree_with_verify(&src, &dst).unwrap();
        assert!(!dst.exists(), "源不存在时不应创建目标");
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn cleanup_pending_idempotent_and_deletes() {
        let data = tmp("data");
        let old = tmp("old");
        fs::create_dir_all(old.join("sub")).unwrap();
        fs::write(old.join("old.db"), b"db").unwrap();
        let m = MigrationMarker {
            legacy_out: old.clone(),
            legacy_db: old.join("old.db"),
            legacy_cfg: old.join("config.toml"),
        };
        fs::write(marker_path(&data), serde_json::to_string(&m).unwrap()).unwrap();
        cleanup_pending(&data).unwrap();
        assert!(!old.join("old.db").exists(), "旧 db 应删除");
        assert!(!marker_path(&data).exists(), "标记应删除");
        cleanup_pending(&data).unwrap(); // 幂等, 不 panic
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&old);
    }

    #[test]
    fn count_matches() {
        let d = tmp("cnt");
        fs::create_dir_all(d.join("x")).unwrap();
        fs::write(d.join("x").join("f"), b"12345").unwrap();
        assert_eq!(count_and_size(&d).unwrap(), (1, 5));
        let _ = fs::remove_dir_all(&d);
    }
}
