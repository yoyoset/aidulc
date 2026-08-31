//! store/timing_repo.rs —— `timing_offsets` 表唯一写者: 跟读时间轴的人工校准锚点
//!
//! 为什么需要它 (2026-08-31 实测, 见 memory/pipeline.md):
//! 打包阶段 `_chapter_opus_ok` 用"文件大小 ≥ 预期 90%"判定章节 opus 是否完好, ±10% 容差
//! 会把**陈旧 opus** (上一轮跑出来、和当前句子对不上的那份) 判成"完好"直接跳过重编码。
//! 结果是时间轴和音频差出几秒到十几秒, 而且重跑备料永远不会重编那一章 —— 用户侧表现
//! 为"错位且无法修正"。实测 Because of Winn-Dixie ch007/ch016 的误差形状是**阶跃函数**:
//! 跳变点之前恒定 -240ms, 之后恒定 -9500ms, 用单一常量偏移可让该段所有句边界落在真实
//! 静音的 150ms 内 (命中 10/10)。所以"从某句起整体平移一个常量"是能真正修好的校正方式。
//!
//! 三条设计决定:
//! 1. **分段锚点, 不是全章一个值**: 一章里可以有多个跳变点 (ch005 前半 -280ms/后半 -4150ms),
//!    全章单值会把已经对的那半推歪。
//! 2. **锚点存绝对偏移, 不是增量**: `offset_at(i)` = 最后一条 from_sentence <= i 的锚点值。
//!    增量语义在反复微调时会累积浮动、也无法直接显示"当前偏移多少", 绝对值两者都好办。
//! 3. **不带 user_id**: 它修的是成品音频自身的偏差 (谁听都一样偏), 不是个人偏好, 与
//!    `vocab`/`highlights` 那类按人隔离的数据性质不同。
//!
//! 防"无限成长": 复合主键 (edition_id, chapter_index, from_sentence) 让反复微调走 UPSERT,
//! 行数等于**锚点数**而不是**点击次数**; 偏移归零的锚点直接删除; 与前一条锚点等值的冗余
//! 锚点直接删除; 每章锚点数硬上限 `MAX_ANCHORS_PER_CHAPTER`。

use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// 每章锚点数硬上限。正常用法一章 1-2 个跳变点, 64 是"绝不该达到"的护栏而不是预期值;
/// 达到上限说明要么用户在乱点、要么这本书该重新打包了, 两种情况都不应该靠继续堆锚点解决。
pub const MAX_ANCHORS_PER_CHAPTER: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimingAnchor {
    pub chapter_index: i64,
    /// 从这一句起生效 (到下一条锚点为止)
    pub from_sentence: i64,
    pub offset_ms: i64,
}

pub struct TimingRepo<'a> {
    db: &'a Db,
}

impl<'a> TimingRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    /// 一本成品的全部锚点, 按 (章, 起始句) 升序。
    ///
    /// 性能: 前端在打开书时**一次性**取回整本 (通常 0 行, 有校准也就几行), 之后切章
    /// 零 IO。复合主键的最左前缀就是 edition_id, 这条查询走主键索引。
    pub fn list_for_edition(&self, edition_id: &str) -> Result<Vec<TimingAnchor>, String> {
        let conn = self.db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT chapter_index, from_sentence, offset_ms FROM timing_offsets
                 WHERE edition_id = ?1 ORDER BY chapter_index, from_sentence",
            )
            .map_err(|e| format!("读校准锚点失败: {e}"))?;
        let rows = stmt
            .query_map(params![edition_id], |r| {
                Ok(TimingAnchor {
                    chapter_index: r.get(0)?,
                    from_sentence: r.get(1)?,
                    offset_ms: r.get(2)?,
                })
            })
            .map_err(|e| format!("读校准锚点失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读校准锚点失败: {e}"))
    }

    /// 单章锚点 (按起始句升序)
    pub fn list_for_chapter(
        &self,
        edition_id: &str,
        chapter_index: i64,
    ) -> Result<Vec<TimingAnchor>, String> {
        Ok(self
            .list_for_edition(edition_id)?
            .into_iter()
            .filter(|a| a.chapter_index == chapter_index)
            .collect())
    }

    /// 落一条锚点。`offset_ms == 0` 或与前一条锚点等值 → 删除该行 (不留冗余行)。
    ///
    /// 返回该章落定后的锚点列表, 供前端直接刷新, 免一次额外往返。
    pub fn set(
        &self,
        edition_id: &str,
        chapter_index: i64,
        from_sentence: i64,
        offset_ms: i64,
    ) -> Result<Vec<TimingAnchor>, String> {
        if from_sentence < 0 {
            return Err("起始句下标不能为负".into());
        }
        let existing = self.list_for_chapter(edition_id, chapter_index)?;
        // 这一句在"不含本锚点"的前提下会继承到的偏移 —— 相等就没必要存这一行
        let inherited = existing
            .iter()
            .rfind(|a| a.from_sentence < from_sentence)
            .map(|a| a.offset_ms)
            .unwrap_or(0);
        let redundant = offset_ms == inherited;

        if redundant {
            self.delete_anchor(edition_id, chapter_index, from_sentence)?;
            return self.list_for_chapter(edition_id, chapter_index);
        }

        let is_new = !existing.iter().any(|a| a.from_sentence == from_sentence);
        if is_new && existing.len() >= MAX_ANCHORS_PER_CHAPTER {
            return Err(format!(
                "本章校准锚点已达上限 {MAX_ANCHORS_PER_CHAPTER} 个。\
                 锚点这么多通常说明音频本身和时间轴对不上 (章节 opus 陈旧), \
                 建议重新打包这本书, 而不是继续加锚点"
            ));
        }

        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO timing_offsets
                (edition_id, chapter_index, from_sentence, offset_ms, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(edition_id, chapter_index, from_sentence) DO UPDATE SET
                offset_ms = excluded.offset_ms, updated_at = excluded.updated_at",
            params![
                edition_id,
                chapter_index,
                from_sentence,
                offset_ms,
                crate::store::now_ms_for_store()
            ],
        )
        .map_err(|e| format!("写校准锚点失败: {e}"))?;
        drop(conn);
        self.prune_redundant(edition_id, chapter_index)?;
        self.list_for_chapter(edition_id, chapter_index)
    }

    /// 复位一章 (删掉该章全部锚点)
    pub fn reset_chapter(&self, edition_id: &str, chapter_index: i64) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM timing_offsets WHERE edition_id = ?1 AND chapter_index = ?2",
            params![edition_id, chapter_index],
        )
        .map_err(|e| format!("复位校准失败: {e}"))?;
        Ok(())
    }

    // 注: 删成品时清理本表走 `application/library_asset_service.rs` 的级联删除
    // (直连 SQL, 单事务原子完成 —— 见 CLAUDE.md 记的第二处例外: 各 repo 各自锁
    // db.conn, 在 service 已持锁的事务里调 repo 会死锁)。这里不再重复提供 repo 方法,
    // 否则就是一段永远没人调的死代码。

    fn delete_anchor(
        &self,
        edition_id: &str,
        chapter_index: i64,
        from_sentence: i64,
    ) -> Result<(), String> {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM timing_offsets
             WHERE edition_id = ?1 AND chapter_index = ?2 AND from_sentence = ?3",
            params![edition_id, chapter_index, from_sentence],
        )
        .map_err(|e| format!("删除校准锚点失败: {e}"))?;
        Ok(())
    }

    /// 删掉"和前一条等值"的冗余锚点 —— 反复微调后可能出现相邻两条值相同, 留着只会
    /// 让行数单调增长却不改变任何行为。
    fn prune_redundant(&self, edition_id: &str, chapter_index: i64) -> Result<(), String> {
        let anchors = self.list_for_chapter(edition_id, chapter_index)?;
        let mut prev = 0i64;
        for a in &anchors {
            if a.offset_ms == prev {
                self.delete_anchor(edition_id, chapter_index, a.from_sentence)?;
            } else {
                prev = a.offset_ms;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let p = std::env::temp_dir().join(format!(
            "aidulc_timing_{}_{}.db",
            std::process::id(),
            crate::store::now_ms_for_store()
        ));
        let _ = std::fs::remove_file(&p);
        Db::open(p.to_str().unwrap()).unwrap()
    }

    #[test]
    fn set_then_list_roundtrip() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 44, -4150).unwrap();
        let got = r.list_for_chapter("ed1", 5).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].from_sentence, 44);
        assert_eq!(got[0].offset_ms, -4150);
    }

    #[test]
    fn repeated_nudge_upserts_instead_of_growing() {
        // 防"无限成长": 同一锚点点 20 次微调, 仍然只有 1 行
        let db = db();
        let r = TimingRepo::new(&db);
        for k in 1..=20 {
            r.set("ed1", 5, 44, -100 * k).unwrap();
        }
        let got = r.list_for_chapter("ed1", 5).unwrap();
        assert_eq!(got.len(), 1, "反复微调必须 UPSERT 同一行");
        assert_eq!(got[0].offset_ms, -2000);
    }

    #[test]
    fn zero_offset_removes_row() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 44, -4150).unwrap();
        let after = r.set("ed1", 5, 44, 0).unwrap();
        assert!(after.is_empty(), "偏移归零应删掉锚点而不是留一行 0");
    }

    #[test]
    fn anchor_equal_to_inherited_is_not_stored() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 10, -300).unwrap();
        // 句 44 继承到的就是 -300, 再存一条 -300 是冗余
        let after = r.set("ed1", 5, 44, -300).unwrap();
        assert_eq!(after.len(), 1, "与继承值相同的锚点不该落库");
        assert_eq!(after[0].from_sentence, 10);
    }

    #[test]
    fn reset_chapter_clears_only_that_chapter() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 44, -4150).unwrap();
        r.set("ed1", 7, 50, -9500).unwrap();
        r.reset_chapter("ed1", 5).unwrap();
        assert!(r.list_for_chapter("ed1", 5).unwrap().is_empty());
        assert_eq!(r.list_for_chapter("ed1", 7).unwrap().len(), 1);
    }

    #[test]
    fn anchor_cap_rejects_runaway_growth() {
        let db = db();
        let r = TimingRepo::new(&db);
        // 每条锚点值都不同, 才不会被冗余剪枝吃掉
        for i in 0..MAX_ANCHORS_PER_CHAPTER {
            r.set("ed1", 5, i as i64, -(i as i64 + 1) * 10).unwrap();
        }
        let err = r.set("ed1", 5, 9999, -999_999).unwrap_err();
        assert!(err.contains("上限"), "超出上限应给人话提示, 实得: {err}");
    }

    #[test]
    fn anchors_are_scoped_per_edition() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 44, -4150).unwrap();
        r.set("ed2", 5, 44, -1000).unwrap();
        assert_eq!(r.list_for_edition("ed1").unwrap()[0].offset_ms, -4150);
        assert_eq!(r.list_for_edition("ed2").unwrap()[0].offset_ms, -1000);
    }

    /// 删成品必须一并删掉校准锚点, 否则孤儿行会永久堆积 (无限成长)。
    /// 级联删除在 application/library_asset_service.rs 里走单事务直连 SQL, 这里锁定
    /// 那条 SQL 的行为 —— 表名/列名改了而级联没跟着改, 这个测试会红。
    #[test]
    fn edition_cascade_delete_removes_anchors() {
        let db = db();
        let r = TimingRepo::new(&db);
        r.set("ed1", 5, 44, -4150).unwrap();
        r.set("ed2", 5, 44, -1000).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM timing_offsets WHERE edition_id=?1", ["ed1"])
                .unwrap();
        }
        assert!(r.list_for_edition("ed1").unwrap().is_empty());
        assert_eq!(
            r.list_for_edition("ed2").unwrap().len(),
            1,
            "不得误删别的成品"
        );
    }
}
