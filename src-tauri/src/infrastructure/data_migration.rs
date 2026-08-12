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
    /// L1-c (2026-08-11): 删源前核验的目标位置 —— 清单比对的对象是"新位置",
    /// 不是旧位置 (旧位置马上要删, 比它没意义)。
    pub target_out: PathBuf,
    /// L1-b (2026-08-11): 迁移前对 jobs_out 落盘的校验和清单 (每个文件的相对路径 +
    /// 大小 + sha256)。Phase 2 删源前逐条比对; 清单不匹配 → 不删源、报错。
    pub manifest: Vec<ManifestEntry>,
    /// UX5 #4 (2026-08-13): 整根迁移 (书库位置 = 数据根) 时, models/ 也随根走。
    /// 空路径 = 本次迁移没动 models (旧位置没有)。
    #[serde(default)]
    pub legacy_models: PathBuf,
    #[serde(default)]
    pub target_models: PathBuf,
    #[serde(default)]
    pub manifest_models: Vec<ManifestEntry>,
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

/// L1-b (2026-08-11): 校验和清单条目 —— 迁移前逐文件记录 (相对路径 + 大小 + sha256),
/// 迁移后与目标目录逐条比对。**这是 991MB 事故的直接善后**: 此前的自动备份
/// (export_aidu_data) 只导数据库行, 成品文件一个字节都没备; 迁移靠 copy_tree_with_verify
/// 的数数+字节数, 而那次校验通过是因为复制那一刻源已经是空的。清单比对能抓住
/// "源本来就是空的 / 复制漏文件" 这类真实情形。
#[derive(Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// 相对路径 (正斜杠, 不含根)
    pub rel: String,
    /// 文件大小 (字节)
    pub size: u64,
    /// sha256 十六进制小写
    pub sha256: String,
}

/// 递归构建目录校验和清单 (相对路径 + 大小 + sha256)。
/// 目录本身不进清单 (清单只量文件; 空目录的存在与否由 copy_tree_with_verify 的数数兜底)。
pub fn build_manifest(root: &Path) -> Result<Vec<ManifestEntry>, String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<ManifestEntry>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("读目录失败 {dir:?}: {e}"))? {
            let entry = entry.map_err(|e| format!("读目录项失败 {dir:?}: {e}"))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|_| format!("路径越界: {path:?}"))?;
            if path.is_dir() {
                walk(&path, root, out)?;
            } else {
                let size = std::fs::metadata(&path)
                    .map_err(|e| format!("读元数据失败 {path:?}: {e}"))?
                    .len();
                let sha = file_sha256(&path)?;
                out.push(ManifestEntry {
                    rel: rel.to_string_lossy().replace('\\', "/"),
                    size,
                    sha256: sha,
                });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开 {path:?} 失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读 {path:?} 失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

/// 逐条比对目录与清单: 每个文件在、大小一致、sha256 一致。任何一条不满足 → Err
/// (返回第一条不匹配的详情)。目录为空或清单为空 = 一致 (各自都是空)。
pub fn verify_manifest(root: &Path, manifest: &[ManifestEntry]) -> Result<(), String> {
    for m in manifest {
        let p = root.join(m.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !p.is_file() {
            return Err(format!(
                "清单条目不匹配: {} 不存在于 {}",
                m.rel,
                root.to_string_lossy()
            ));
        }
        let size = std::fs::metadata(&p)
            .map_err(|e| format!("读元数据失败 {p:?}: {e}"))?
            .len();
        if size != m.size {
            return Err(format!(
                "清单条目不匹配: {} 大小 {}≠{}",
                m.rel, size, m.size
            ));
        }
        let sha = file_sha256(&p)?;
        if sha != m.sha256 {
            return Err(format!("清单条目不匹配: {} sha256 不一致", m.rel));
        }
    }
    Ok(())
}

pub fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("migration_done.json")
}

/// 下次启动时执行: 旧文件已解锁, 按标记清理。幂等, 不存在即无事可做。
///
/// L1-c (2026-08-11): 删源前的最后一道闸 —— 先核对新位置文件数与清单条数一致
/// (清单在迁移时落盘在 marker 里)。**任何一步不确定, 宁可留着旧目录让用户手删。**
/// 判断依据: 目标是"新位置确实有清单里全部文件", 而不是"复制时数数对上了"。
pub fn cleanup_pending(data_dir: &Path) -> Result<(), String> {
    let marker = marker_path(data_dir);
    if !marker.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&marker).map_err(|e| format!("读迁移标记失败: {e}"))?;
    let m: MigrationMarker =
        serde_json::from_str(&text).map_err(|e| format!("解析迁移标记失败: {e}"))?;
    // L1-c: 新位置必须通过清单核验才允许删源。
    if !m.manifest.is_empty() {
        match verify_manifest(&m.target_out, &m.manifest) {
            Ok(()) => {}
            Err(e) => {
                // 不清除 marker, 下次启动再核 (幂等); 但绝不删源。
                crate::infrastructure::log::warn(
                    "migration",
                    &format!(
                        "删源前核验失败, 保留旧目录: {e} (源: {}; 请人工确认后再手动清理)",
                        m.legacy_out.to_string_lossy()
                    ),
                );
                return Err(format!("删源前清单核验失败, 保留旧目录: {e}"));
            }
        }
    }
    // UX5 #4: models 也随根走 —— 删源前同样核验目标 models
    if !m.manifest_models.is_empty() {
        match verify_manifest(&m.target_models, &m.manifest_models) {
            Ok(()) => {}
            Err(e) => {
                crate::infrastructure::log::warn(
                    "migration",
                    &format!(
                        "删源前 models 核验失败, 保留旧目录: {e} (源: {}; 请人工确认后再手动清理)",
                        m.legacy_models.to_string_lossy()
                    ),
                );
                return Err(format!("删源前 models 清单核验失败, 保留旧目录: {e}"));
            }
        }
    }
    for p in [&m.legacy_out, &m.legacy_db, &m.legacy_cfg] {
        if !p.as_os_str().is_empty() {
            remove_any(p);
        }
    }
    // WAL/SHM 跟着 data.db 走
    remove_any(&with_suffix(&m.legacy_db, "-wal"));
    remove_any(&with_suffix(&m.legacy_db, "-shm"));
    if !m.legacy_models.as_os_str().is_empty() {
        remove_any(&m.legacy_models);
    }
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

    // L1-b: 迁移前先对 jobs_out 落校验和清单 (相对路径 + 大小 + sha256) ——
    // 991MB 事故教训: 复制校验通过 ≠ 源真的有东西, 那次是"复制那一刻源已经是空的"
    // 也能通过数数比对。清单在复制前建 (从源), 迁移后比对目标, 并随 marker 落盘
    // 供 Phase 2 删源前再核一遍。
    let manifest = if plan.legacy_out.exists() {
        build_manifest(&plan.legacy_out)?
    } else {
        Vec::new()
    };
    crate::infrastructure::log::info(
        "migration",
        &format!(
            "已生成校验和清单: {} 个文件 (sha256 逐文件)",
            manifest.len()
        ),
    );

    // 2. 复制 jobs_out (复制 → 校验 → 源保留, 删除交给 cleanup_pending)
    let out_moved = top_level_count(&plan.legacy_out);
    copy_tree_with_verify(&plan.legacy_out, &plan.target_out)?;
    // L1-b: 复制后逐条比对目标与清单 (文件在 / 大小 / sha256)。不匹配 → 报错, 源不动。
    verify_manifest(&plan.target_out, &manifest)?;
    crate::infrastructure::log::info(
        "migration",
        &format!(
            "校验和清单核验通过: 目标 {} 与清单 {} 个文件一致",
            plan.target_out.to_string_lossy(),
            manifest.len()
        ),
    );
    // UX5 修正 (2026-08-13): 迁移后重写 DB 里的成品路径 (books/editions.pack_dir,
    // jobs.output_dir) —— 旧路径前缀 → 新路径前缀。此前只搬文件不改 DB, 迁移完成
    // Phase 2 删旧后书卡会全变「成品文件缺失」(pack_dir 指向已删目录)。
    rewrite_db_paths(db, &plan.legacy_out, &plan.target_out)?;

    // UX5 #4 (2026-08-13): 整根迁移时 models/ 也随根走 (模型下载目录)。
    // legacy_out.parent() = 旧数据根, target_out.parent() = 新数据根 (jobs_out 直接挂在根下)。
    let legacy_models = plan
        .legacy_out
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("models");
    let target_models = plan
        .target_out
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("models");
    let manifest_models = if legacy_models.is_dir() {
        let mm = build_manifest(&legacy_models)?;
        copy_tree_with_verify(&legacy_models, &target_models)?;
        verify_manifest(&target_models, &mm)?;
        crate::infrastructure::log::info(
            "migration",
            &format!(
                "models 校验和清单核验通过: 目标 {} 与清单 {} 个文件一致",
                target_models.to_string_lossy(),
                mm.len()
            ),
        );
        mm
    } else {
        Vec::new()
    };

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

    // 5. 写迁移完成标记 (Phase 2 清理旧文件用; 含 L1-b 清单 + L1-c 目标位置)
    let marker = MigrationMarker {
        legacy_out: plan.legacy_out.clone(),
        legacy_db: plan.legacy_db.clone(),
        legacy_cfg: plan.legacy_cfg.clone(),
        target_out: plan.target_out.clone(),
        manifest,
        legacy_models,
        target_models,
        manifest_models,
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

/// UX5 修正 (2026-08-13): 迁移后重写 DB 里的成品路径前缀 (books/editions.pack_dir,
/// jobs.output_dir)。用 `instr(pack_dir, ?)=1` 判前缀 (LIKE 的 `_`/`%` 会被路径里的
/// 下划线误当通配符, 不用 LIKE)。DB 里存的是 Windows 反斜杠路径, 直接用原样字符串。
pub fn rewrite_db_paths(db: &crate::store::Db, old: &Path, new: &Path) -> Result<(), String> {
    let old_s = old.to_string_lossy().to_string();
    let new_s = new.to_string_lossy().to_string();
    if old_s.is_empty() || new_s.is_empty() {
        return Ok(());
    }
    let conn = db.conn.lock().unwrap();
    for table in ["books", "editions"] {
        conn.execute(
            &format!(
                "UPDATE {table} SET pack_dir = replace(pack_dir, ?1, ?2) WHERE instr(pack_dir, ?1) = 1"
            ),
            rusqlite::params![old_s, new_s],
        )
        .map_err(|e| format!("迁移后重写 {table}.pack_dir 失败: {e}"))?;
    }
    conn.execute(
        "UPDATE jobs SET output_dir = replace(output_dir, ?1, ?2) WHERE instr(output_dir, ?1) = 1",
        rusqlite::params![old_s, new_s],
    )
    .map_err(|e| format!("迁移后重写 jobs.output_dir 失败: {e}"))?;
    drop(conn);
    Ok(())
}

/// UX5 修正 (2026-08-13): 书库(jobs_out)不在数据根下时, 收拢进数据根 —— 解决用户看到的
/// "数据根 C:\...\Roaming\aidulc, 书库 E:\aidulc_data" 两处打架。典型成因: config.out_dir
/// 是历史绝对路径, 与数据根解耦。
///
/// 流程 (安全纪律与整根迁移一致): 备份 → 清单 → 复制 old_out → new_out (数据根/jobs_out)
/// → 校验 → 重写 DB 路径 → 改 config.out_dir → 写迁移标记。旧 out 由下次启动
/// cleanup_pending 按清单核验通过后才删。数据根本身不动 (config/db/backups/logs 已在其下)。
pub fn consolidate_out_into_root(
    db: &crate::store::Db,
    old_out: &Path,
    new_out: &Path,
    data_dir: &Path,
) -> Result<MigrationReport, String> {
    use std::io::Write;
    if !old_out.is_dir() {
        return Err(format!("书库位置不存在: {}", old_out.to_string_lossy()));
    }
    if new_out == old_out {
        return Err("书库已在数据根下 (jobs_out/), 无需收拢".into());
    }

    // 1. 备份 (数据安全第 1 条: 执行前自动备份, 路径告诉用户)
    let backup_dir = data_dir.join("backups");
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

    // 2. 清单 + 复制 + 校验 (L1: 源一个没少才允许 Phase 2 删旧)
    let manifest = build_manifest(old_out)?;
    copy_tree_with_verify(old_out, new_out)?;
    verify_manifest(new_out, &manifest)?;
    crate::infrastructure::log::info(
        "migration",
        &format!(
            "书库收拢: 复制 {} → {} 核验通过 ({} 个文件)",
            old_out.to_string_lossy(),
            new_out.to_string_lossy(),
            manifest.len()
        ),
    );

    // 3. 重写 DB 路径 (旧前缀 → 新前缀)
    rewrite_db_paths(db, old_out, new_out)?;

    // 4. 改 config.out_dir (数据根下的 config.toml)
    {
        let mut cfg = crate::services::config::Config::load(data_dir);
        cfg.out_dir = new_out.to_path_buf();
        cfg.save(data_dir)?;
    }

    // 5. 写迁移标记 (Phase 2 清理旧 out; legacy_db/cfg 置空 = 不删, 数据根本身不动)
    let marker = MigrationMarker {
        legacy_out: old_out.to_path_buf(),
        legacy_db: PathBuf::new(),
        legacy_cfg: PathBuf::new(),
        target_out: new_out.to_path_buf(),
        manifest,
        legacy_models: PathBuf::new(),
        target_models: PathBuf::new(),
        manifest_models: vec![],
    };
    let marker_text = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
    fs::write(marker_path(data_dir), marker_text).map_err(|e| format!("写迁移标记失败: {e}"))?;

    let out_moved = top_level_count(old_out);
    crate::infrastructure::log::info(
        "migration",
        &format!(
            "书库收拢完成: {} 项 → {}, 标记已写, 待重启清理旧位置",
            out_moved,
            new_out.to_string_lossy()
        ),
    );
    Ok(MigrationReport {
        backup_path: backup_path.to_string_lossy().to_string(),
        out_moved,
        target_out: new_out.to_string_lossy().to_string(),
        target_db: data_dir.join("data.db").to_string_lossy().to_string(),
    })
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

/// UX5 #4 (2026-08-13): 书库位置 = 数据根 —— 整根迁移 (config + db + jobs_out + models 一起)。
/// 构建整根迁移计划 → 复用 run_migration (备份/复制/校验/写标记) → 写数据根指针。
/// 返回 report; 旧文件由下次启动 cleanup_pending 按清单核验后清理。
pub fn migrate_data_root(
    db: &crate::store::Db,
    old_root: &Path,
    new_root: &Path,
    default_data_dir: &Path,
) -> Result<MigrationReport, String> {
    if !old_root.is_dir() {
        return Err(format!(
            "当前书库位置不存在: {}",
            old_root.to_string_lossy()
        ));
    }
    let plan = MigrationPlan {
        legacy_out: old_root.join("jobs_out"),
        legacy_db: old_root.join("data.db"),
        legacy_cfg: old_root.join("config.toml"),
        target_out: new_root.join("jobs_out"),
        target_db: new_root.join("data.db"),
        target_cfg: new_root.join("config.toml"),
    };
    let report = run_migration(db, &plan)?;
    // 写数据根指针 → 下次启动从新根读 (config/db/logs/models/backups 都随根走)
    crate::services::config::write_data_root(default_data_dir, new_root)?;
    Ok(report)
}

/// UX5 #4: 新书库位置可用性检查 (L1 清单前置): 目标必须为空/不存在且可写, 且不能
/// 在当前根内部 (避免把根迁进自己的子目录造成递归)。返回 Ok(()) 或 Err(人话原因)。
pub fn check_new_root(old_root: &Path, new_root: &Path) -> Result<(), String> {
    let canonical_old = old_root
        .canonicalize()
        .unwrap_or_else(|_| old_root.to_path_buf());
    let new_str = new_root.to_string_lossy().to_lowercase();
    let old_str = canonical_old.to_string_lossy().to_lowercase();
    if old_str == new_str {
        return Err("选择的位置和当前书库位置一致, 无需迁移".into());
    }
    // 新位置不能在当前根内部 (或反过来, 当前根在新位置内部 —— 也会循环迁移)
    if old_str.starts_with(&new_str) || new_str.starts_with(&old_str) {
        return Err("新位置不能是当前书库位置的子目录或父目录 (会循环迁移)".into());
    }
    if new_root.exists() {
        let (count, _) = count_and_size(new_root).map_err(|e| format!("检查新位置失败: {e}"))?;
        if count > 0 {
            return Err(format!(
                "新位置不是空目录 (里面有 {} 个文件/目录)。整根迁移需要目标为空, 请另选一个空目录或先清空",
                count
            ));
        }
    } else if let Some(parent) = new_root.parent() {
        if !parent.is_dir() {
            return Err(format!(
                "新位置的父目录不存在: {}",
                parent.to_string_lossy()
            ));
        }
        // 父目录可写测试
        let probe = parent.join(format!(".aidulc-write-test-{}", std::process::id()));
        match std::fs::write(&probe, b"x") {
            Ok(()) => {
                let _ = std::fs::remove_file(&probe);
            }
            Err(e) => {
                return Err(format!("新位置的父目录不可写: {e}"));
            }
        }
    }
    Ok(())
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
            target_out: old.join("moved"),
            manifest: vec![],
            legacy_models: PathBuf::new(),
            target_models: PathBuf::new(),
            manifest_models: vec![],
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
    fn l1b_build_and_verify_manifest_roundtrip() {
        // L1-b: 迁移前落盘清单 → 迁移后逐条比对 (相对路径+大小+sha256)。
        let src = tmp("m_src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        fs::write(src.join("sub").join("b.bin"), vec![0u8, 1, 2, 3, 255]).unwrap();
        let manifest = build_manifest(&src).unwrap();
        assert_eq!(manifest.len(), 2);
        let rels: Vec<&str> = manifest.iter().map(|m| m.rel.as_str()).collect();
        assert!(rels.contains(&"a.txt"), "rel 应为相对路径: {rels:?}");
        assert!(
            rels.contains(&"sub/b.bin"),
            "rel 应为正斜杠相对路径: {rels:?}"
        );
        // 复制到目标 → 比对通过
        let dst = tmp("m_dst");
        copy_tree_with_verify(&src, &dst).unwrap();
        verify_manifest(&dst, &manifest).unwrap();
        // 改动一个字节 → 必须报错
        fs::write(dst.join("a.txt"), b"aab").unwrap();
        assert!(
            verify_manifest(&dst, &manifest).is_err(),
            "大小不同必须报错"
        );
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn l1c_cleanup_pending_refuses_to_delete_when_target_missing_files() {
        // L1-c 安全边界: 目标缺文件时, 旧目录绝不能被删 (991MB 事故场景的直接回归)。
        let data = tmp("data");
        let old = tmp("old");
        let moved = tmp("moved");
        fs::write(old.join("bookpack.json"), b"x").unwrap();
        fs::write(moved.join("bookpack.json"), b"x").unwrap();
        let manifest = build_manifest(&old).unwrap();
        assert_eq!(manifest.len(), 1);
        // 目标少一个文件 (模拟迁移后目标不完整)
        fs::remove_file(moved.join("bookpack.json")).unwrap();
        let m = MigrationMarker {
            legacy_out: old.clone(),
            legacy_db: old.join("old.db"),
            legacy_cfg: old.join("config.toml"),
            target_out: moved.clone(),
            manifest,
            legacy_models: PathBuf::new(),
            target_models: PathBuf::new(),
            manifest_models: vec![],
        };
        fs::write(marker_path(&data), serde_json::to_string(&m).unwrap()).unwrap();
        assert!(cleanup_pending(&data).is_err(), "目标缺文件时必须拒绝删源");
        assert!(
            old.join("bookpack.json").exists(),
            "核验失败时旧目录必须保留"
        );
        assert!(
            marker_path(&data).exists(),
            "核验失败时标记不清除 (下次启动再核)"
        );
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&moved);
    }

    #[test]
    fn count_matches() {
        let d = tmp("cnt");
        fs::create_dir_all(d.join("x")).unwrap();
        fs::write(d.join("x").join("f"), b"12345").unwrap();
        assert_eq!(count_and_size(&d).unwrap(), (1, 5));
        let _ = fs::remove_dir_all(&d);
    }

    /// UX5 #4 (2026-08-13): 书库位置 = 数据根 —— 整根迁移 (config+db+jobs_out+models),
    /// 指针写入后 read_data_root 指向新根; 源计数==目标计数 (一个没少); Phase 2 删旧。
    #[test]
    fn ux5_migrate_data_root_moves_config_db_out_models() {
        use crate::services::config;
        let root = tmp("ux5");
        let old_root = root.join("old-root");
        let new_root = root.join("new-root");
        let default_dir = root.join("default");
        fs::create_dir_all(old_root.join("jobs_out")).unwrap();
        fs::create_dir_all(old_root.join("models")).unwrap();
        fs::write(old_root.join("jobs_out").join("bookpack.json"), b"{}").unwrap();
        fs::write(old_root.join("models").join("Qwen.gguf"), b"model").unwrap();
        fs::write(old_root.join("config.toml"), b"out_dir='jobs_out'\n").unwrap();
        let db_path = old_root.join("data.db");
        let db = crate::store::Db::open(db_path.to_str().unwrap()).unwrap();
        // 登记一本书 (pack_dir 指向旧根 jobs_out) —— 迁移后 DB 路径必须重写
        {
            use crate::store::books_repo::Book;
            let books = crate::store::books_repo::BooksRepo::new(&db);
            books
                .upsert(&Book {
                    id: "b1".into(),
                    title: "Book".into(),
                    source_path: String::new(),
                    pack_dir: old_root
                        .join("jobs_out")
                        .join("bookpack.json")
                        .to_string_lossy()
                        .to_string(),
                    profile_id: "default".into(),
                    status: "ready".into(),
                    kind: "product".into(),
                    source_book_id: None,
                    chapter_count: 0,
                    failed_count: 0,
                    last_opened_at: None,
                    source_language: "en".into(),
                    target_language: "zh-CN".into(),
                    llm_id: None,
                    tts_id: None,
                    nlp_id: None,
                    created_at: 1,
                    updated_at: 1,
                })
                .unwrap();
        }

        // L1 前置检查
        assert!(
            check_new_root(&old_root, &new_root).is_ok(),
            "空目标应通过 L1 前置"
        );
        assert!(
            check_new_root(&old_root, &old_root.join("jobs_out")).is_err(),
            "子目录应拒绝 (循环迁移)"
        );
        assert!(
            check_new_root(&old_root, &old_root).is_err(),
            "同位置应拒绝"
        );

        // 整根迁移
        let report = migrate_data_root(&db, &old_root, &new_root, &default_dir).unwrap();
        assert!(
            report.target_out.contains("new-root"),
            "jobs_out 应落在新根: {}",
            report.target_out
        );
        // 新根子项齐全: config/db/jobs_out/models/backups
        assert!(new_root.join("config.toml").exists());
        assert!(new_root.join("data.db").exists());
        assert!(new_root.join("jobs_out").join("bookpack.json").exists());
        assert!(new_root.join("models").join("Qwen.gguf").exists());
        // UX5 修正: 新库 (VACUUM 复制) 里的 pack_dir 必须重写到新根 (否则删旧后书变红卡)
        {
            let check = rusqlite::Connection::open(new_root.join("data.db")).unwrap();
            let pd: String = check
                .query_row("SELECT pack_dir FROM books WHERE id='b1'", [], |r| r.get(0))
                .unwrap();
            assert!(
                pd.starts_with(&new_root.join("jobs_out").to_string_lossy().to_string()),
                "迁移后 DB pack_dir 应指向新根: {pd}"
            );
            assert!(!pd.contains("old-root"), "pack_dir 不应残留旧根: {pd}");
        }
        assert!(new_root.join("backups").is_dir(), "应有备份目录");
        // 数据根指针 → 下次启动从新根读
        assert_eq!(
            config::read_data_root(&default_dir).unwrap(),
            new_root,
            "指针应指向新根"
        );
        // 原位置文件一个没少: 源计数 == 目标计数 (迁移期)
        let (sc, _) = count_and_size(&old_root.join("jobs_out")).unwrap();
        let (tc, _) = count_and_size(&new_root.join("jobs_out")).unwrap();
        assert_eq!(sc, tc, "jobs_out 源/目标文件数一致: {sc}/{tc}");
        let (sm, _) = count_and_size(&old_root.join("models")).unwrap();
        let (tm, _) = count_and_size(&new_root.join("models")).unwrap();
        assert_eq!(sm, tm, "models 源/目标文件数一致: {sm}/{tm}");

        // Phase 2: 新根读标记 → 清单核验通过 → 删旧 (db 被本测试持有锁, remove_any 静默忽略)
        cleanup_pending(&new_root).unwrap();
        assert!(!old_root.join("jobs_out").exists(), "旧 jobs_out 应被清理");
        assert!(!old_root.join("models").exists(), "旧 models 应被清理");
        assert!(new_root.join("jobs_out").join("bookpack.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// UX5 修正 (2026-08-13): 书库不在数据根下 → 收拢进数据根。
    /// 用户场景: config.out_dir = 历史绝对路径 (E:\aidulc_data), 与数据根解耦。
    /// 收拢后: 成品进数据根/jobs_out, DB pack_dir/output_dir 前缀重写, config.out_dir 更新,
    /// 备份存在, 标记已写 (Phase 2 清理旧位置)。
    #[test]
    fn ux5_consolidate_out_into_root_moves_books_into_root() {
        use crate::services::config;
        use crate::store::books_repo::Book;
        let root = tmp("consolidate");
        let data_dir = root.join("data-root");
        let old_out = root.join("old-out");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(old_out.join("jobs").join("job-1")).unwrap();
        fs::write(
            old_out.join("jobs").join("job-1").join("bookpack.json"),
            b"{}",
        )
        .unwrap();
        fs::write(
            data_dir.join("config.toml"),
            format!("out_dir='{}'\n", old_out.to_string_lossy()).as_bytes(),
        )
        .unwrap();
        let db_path = data_dir.join("data.db");
        let db = crate::store::Db::open(db_path.to_str().unwrap()).unwrap();
        let old_pack = old_out
            .join("jobs")
            .join("job-1")
            .to_string_lossy()
            .to_string();
        let books = crate::store::books_repo::BooksRepo::new(&db);
        books
            .upsert(&Book {
                id: "b1".into(),
                title: "Book".into(),
                source_path: String::new(),
                pack_dir: old_pack.clone(),
                profile_id: "default".into(),
                status: "ready".into(),
                kind: "product".into(),
                source_book_id: None,
                chapter_count: 0,
                failed_count: 0,
                last_opened_at: None,
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                llm_id: None,
                tts_id: None,
                nlp_id: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        // 任务 output_dir 也指向旧位置
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO jobs (id, book_path, profile_id, output_dir, status, created_at, updated_at)
                 VALUES ('j1', 'x', 'default', ?1, 'done', 1, 1)",
                [old_pack.as_str()],
            )
            .unwrap();
            drop(conn);
        }

        let new_out = data_dir.join("jobs_out");
        let report = consolidate_out_into_root(&db, &old_out, &new_out, &data_dir).unwrap();
        assert!(
            report.target_out.contains("jobs_out"),
            "成品应落在数据根/jobs_out: {}",
            report.target_out
        );
        // 成品已复制 (一个没少)
        assert!(new_out
            .join("jobs")
            .join("job-1")
            .join("bookpack.json")
            .is_file());
        let (sc, _) = count_and_size(&old_out).unwrap();
        let (tc, _) = count_and_size(&new_out).unwrap();
        assert_eq!(sc, tc, "旧/新位置文件数一致 (一个没少): {sc}/{tc}");
        // DB pack_dir 前缀重写 (旧前缀 → 新前缀)
        let b = books.get("b1").unwrap();
        assert!(
            b.pack_dir
                .starts_with(&new_out.to_string_lossy().to_string()),
            "pack_dir 应重写到新位置: {}",
            b.pack_dir
        );
        assert!(!b.pack_dir.contains("old-out"), "pack_dir 不应残留旧前缀");
        // jobs.output_dir 重写
        let out: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT output_dir FROM jobs WHERE id='j1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            out.starts_with(&new_out.to_string_lossy().to_string()),
            "output_dir 应重写: {out}"
        );
        // config.out_dir 更新 + 备份存在 + 标记已写
        let cfg = config::Config::load(&data_dir);
        assert_eq!(cfg.out_dir, new_out, "config.out_dir 应指向数据根/jobs_out");
        assert!(data_dir.join("backups").is_dir(), "应有备份目录");
        assert!(
            marker_path(&data_dir).exists(),
            "应写迁移标记 (Phase 2 清理旧位置)"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn l1_full_migration_roundtrip_with_counts() {
        // L1 (2026-08-11) 验收: 真实数据副本上跑一次完整迁移 (run_migration →
        // cleanup_pending), 报告前后文件数与字节数; 目标缺文件时 Phase 2 拒绝删源。
        let root = tmp("full");
        // 源: 真实形状的 jobs_out (job 目录 + 嵌套子目录)
        let legacy_out = root.join("exe").join("jobs_out");
        let src_job = legacy_out.join("jobs").join("job-1786205609337-11852-1");
        fs::create_dir_all(src_job.join("checkpoints")).unwrap();
        fs::write(src_job.join("bookpack.json"), br#"{"ok":true}"#).unwrap();
        fs::write(src_job.join("checkpoints").join("c0.json"), b"{}").unwrap();
        fs::write(src_job.join("run.log"), b"x").unwrap();
        let src_db = root.join("exe").join("data.db");
        let target_out = root.join("data").join("jobs_out");
        let target_db = root.join("data").join("data.db");
        let target_cfg = root.join("data").join("config.toml");
        let legacy_cfg = root.join("exe").join("config.toml");

        let db_path = src_db.to_str().unwrap();
        let _ = fs::remove_file(db_path);
        let db = crate::store::Db::open(db_path).unwrap();
        let plan = MigrationPlan {
            legacy_out: legacy_out.clone(),
            legacy_db: src_db.clone(),
            legacy_cfg: legacy_cfg.clone(),
            target_out: target_out.clone(),
            target_db: target_db.clone(),
            target_cfg: target_cfg.clone(),
        };
        let report = run_migration(&db, &plan).unwrap();
        // 前后计数与字节数
        let (sc, sb) = count_and_size(&legacy_out).unwrap();
        let (tc, tb) = count_and_size(&target_out).unwrap();
        assert_eq!(
            report.out_moved, 1,
            "top_level_count(jobs_out)=1 (只有 jobs 目录)"
        );
        assert_eq!(sc, tc, "迁移后源与目标文件数一致: 源 {sc} 目标 {tc}");
        assert_eq!(sb, tb, "迁移后源与目标字节数一致: 源 {sb} 目标 {tb}");

        // Phase 2: 目标完整 → cleanup_pending 删除源
        let data_dir = root.join("data");
        cleanup_pending(&data_dir).unwrap();
        assert!(!legacy_out.exists(), "清单核验通过后旧目录才被删");
        assert!(target_out
            .join("jobs")
            .join("job-1786205609337-11852-1")
            .join("bookpack.json")
            .exists());
        let _ = fs::remove_dir_all(&root);
    }
}
