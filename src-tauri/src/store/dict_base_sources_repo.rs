//! store/dict_base_sources_repo.rs —— dict_base_sources 表唯一写者 (2026-09-04)
//!
//! 从 dict_base_repo.rs 拆出来: 记的是"一次自定义词典导入批次"(文件名/标签/词数/
//! 时间), 跟 dict_base 本身(词条数据)是两张不同的表——这张表只在 dict_base_repo.rs
//! 之外单独长出来, 不违反"每张表一个写者"(dict_base 表的删除仍留在 dict_base_repo.rs
//! 里, 见其 delete_source, 不在这里跨写)。拆分只是把"记一批导入" vs "存词条本身"
//! 这两件独立的事分文件, 不改变谁能写 dict_base。

use rusqlite::{params, Connection};

/// 一个"词典源" = 一次成功的自定义导入批次 (用户: "可以加多个词典")。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DictBaseSource {
    pub id: String,
    pub label: String,
    pub file_name: String,
    pub imported_at: i64,
    pub word_count: i64,
}

/// 记一条导入批次(在 dict_base_repo::import_custom_file 导入完成后调用)。
pub fn record(
    conn: &Connection,
    id: &str,
    label: &str,
    file_name: &str,
    imported_at: i64,
    word_count: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO dict_base_sources (id, label, file_name, imported_at, word_count)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, label, file_name, imported_at, word_count],
    )
    .map_err(|e| format!("记词典源失败: {e}"))?;
    Ok(())
}

/// 列出所有自定义词典源(按导入时间倒序), 设置页渲染"我的词典源"列表用。
pub fn list(conn: &Connection) -> Result<Vec<DictBaseSource>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, file_name, imported_at, word_count
             FROM dict_base_sources ORDER BY imported_at DESC",
        )
        .map_err(|e| format!("查词典源列表失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DictBaseSource {
                id: r.get(0)?,
                label: r.get(1)?,
                file_name: r.get(2)?,
                imported_at: r.get(3)?,
                word_count: r.get(4)?,
            })
        })
        .map_err(|e| format!("查词典源列表失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("查词典源列表失败: {e}"))
}

/// 删除一条源记录(调用方已先删完 dict_base 里对应 source_id 的词条)。
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM dict_base_sources WHERE id = ?1", params![id])
        .map_err(|e| format!("删词典源记录失败: {e}"))?;
    Ok(())
}
