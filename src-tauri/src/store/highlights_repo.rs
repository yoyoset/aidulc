//! store/highlights_repo.rs —— 摘录标注唯一写者 (M7 R16, 2026-08-08)
//!
//! 精读时划句留痕 (Kindle/Readwise/微信读书同款)。表结构:
//!   id TEXT PRIMARY KEY (uuid 风格), book_key, chapter, sentence_index (章内句序,
//!   与 reading_state.bookmarks 同语义), selected_text (展示), note (可选备注),
//!   created_at, updated_at。
//! 精确词范围 span 渲染留待前端后续; 本层只保证"存下来、能列出、能删"。

use crate::infrastructure::lock::MutexExt;
use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Highlight {
    pub id: String,
    /// V1 (2026-08-09): 摘录属于哪个 user。旧数据迁移回填 'me'。
    #[serde(default = "default_user_id")]
    pub user_id: String,
    pub book_key: String,
    pub chapter: i64,
    pub sentence_index: i64,
    pub selected_text: String,
    pub note: String,
    // M7 R21: 选区覆盖的 seg 区间 (null = 整句标记, 兼容旧数据)
    #[serde(default)]
    pub start_seg: Option<i64>,
    #[serde(default)]
    pub end_seg: Option<i64>,
    /// 2026-09-05: 摘录分类标记 ('default' | 'review' | 'vocab', 前端定义具体取值
    /// 和文案/配色, 后端只透传存取)。旧数据/未传值一律 'default'。
    #[serde(default = "default_kind")]
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_user_id() -> String {
    crate::store::users_repo::DEFAULT_USER_ID.to_string()
}

fn default_kind() -> String {
    "default".to_string()
}

pub struct HighlightsRepo<'a> {
    db: &'a Db,
}

impl<'a> HighlightsRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn upsert(&self, h: &Highlight) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "INSERT INTO highlights (id, user_id, book_key, chapter, sentence_index, selected_text, note, start_seg, end_seg, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                selected_text = excluded.selected_text, note = excluded.note,
                start_seg = excluded.start_seg, end_seg = excluded.end_seg,
                kind = excluded.kind,
                updated_at = excluded.updated_at",
            params![
                h.id, h.user_id, h.book_key, h.chapter, h.sentence_index,
                h.selected_text, h.note, h.start_seg, h.end_seg, h.kind, h.created_at, h.updated_at
            ],
        )
        .map_err(|e| format!("写摘录失败: {e}"))?;
        Ok(())
    }

    pub fn list_by_book(&self, user_id: &str, book_key: &str) -> Vec<Highlight> {
        let conn = self.db.conn.lock_or_recover();
        let mut stmt = conn
            .prepare(
                "SELECT id, user_id, book_key, chapter, sentence_index, selected_text, note, start_seg, end_seg, kind, created_at, updated_at
                 FROM highlights WHERE user_id = ?1 AND book_key = ?2 ORDER BY chapter, sentence_index, created_at",
            )
            .unwrap();
        stmt.query_map(params![user_id, book_key], |r| {
            Ok(Highlight {
                id: r.get(0)?,
                user_id: r.get(1)?,
                book_key: r.get(2)?,
                chapter: r.get(3)?,
                sentence_index: r.get(4)?,
                selected_text: r.get(5)?,
                note: r.get(6)?,
                start_seg: r.get(7)?,
                end_seg: r.get(8)?,
                kind: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// M7 R31: 全部摘录 (导出/备份用; 前端按书查用 list_by_book)
    pub fn list_all(&self) -> Vec<Highlight> {
        let conn = self.db.conn.lock_or_recover();
        let mut stmt = conn
            .prepare(
                "SELECT id, user_id, book_key, chapter, sentence_index, selected_text, note, start_seg, end_seg, kind, created_at, updated_at
                 FROM highlights ORDER BY book_key, chapter, sentence_index",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Highlight {
                id: r.get(0)?,
                user_id: r.get(1)?,
                book_key: r.get(2)?,
                chapter: r.get(3)?,
                sentence_index: r.get(4)?,
                selected_text: r.get(5)?,
                note: r.get(6)?,
                start_seg: r.get(7)?,
                end_seg: r.get(8)?,
                kind: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    /// K4 (2026-08-14): 按 user_id 归属校验后删 —— 之前只按 id 删, 没有对齐
    /// list_by_book 已有的 user_id 隔离粒度(这是本地单机应用, 不构成安全边界,
    /// 但和"每张表读写都按 user 隔离"这个项目自己声明的模型不一致, 补齐)。
    pub fn remove(&self, user_id: &str, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "DELETE FROM highlights WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )
        .map_err(|e| format!("删摘录失败: {e}"))?;
        Ok(())
    }

    /// 2026-09-05: 删自定义标签时把引用它的摘录清成"未打标签", 由
    /// ipc/commands.rs::highlight_tag_delete 在删 highlight_tags 那行之后调用——
    /// 这是跨表写, 按项目约定只能由 highlights 表自己的 repo 方法来改 highlights
    /// 表, 不能让 highlight_tags_repo.rs 直接写这张表。
    pub fn clear_kind_for_tag(&self, user_id: &str, tag_id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "UPDATE highlights SET kind = '' WHERE user_id = ?1 AND kind = ?2",
            params![user_id, tag_id],
        )
        .map_err(|e| format!("清除标签引用失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("aidulc_hl_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn h(id: &str, book: &str, chapter: i64, idx: i64, text: &str) -> Highlight {
        Highlight {
            id: id.into(),
            user_id: "me".into(),
            book_key: book.into(),
            chapter,
            sentence_index: idx,
            selected_text: text.into(),
            note: String::new(),
            start_seg: None,
            end_seg: None,
            kind: default_kind(),
            created_at: 100,
            updated_at: 100,
        }
    }

    #[test]
    fn kind_defaults_and_roundtrips() {
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        // 未显式设置 kind 时用默认值 (default_kind, 反序列化路径走的是这个而不是
        // #[serde(default)] 的空字符串——旧客户端/旧存档不带这个字段也不会写坏数据)。
        let mut x = h("1", "book_a", 0, 0, "plain");
        assert_eq!(x.kind, "default");
        x.kind = "vocab".into();
        repo.upsert(&x).unwrap();
        let got = repo.list_by_book("me", "book_a").pop().unwrap();
        assert_eq!(got.kind, "vocab");
    }

    #[test]
    fn clear_kind_for_tag_only_touches_matching_rows() {
        // 2026-09-05: 删自定义标签的级联清理——只清 kind 等于被删标签 id 的行,
        // 不碰其它标签/未打标签的行, 也不跨 user 误清。
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        let mut tagged = h("1", "book_a", 0, 0, "tagged one");
        tagged.kind = "tag-good-sentence".into();
        let mut other_tag = h("2", "book_a", 0, 1, "tagged other");
        other_tag.kind = "tag-proverb".into();
        let mut untagged = h("3", "book_a", 0, 2, "no tag");
        untagged.kind = "".into();
        repo.upsert(&tagged).unwrap();
        repo.upsert(&other_tag).unwrap();
        repo.upsert(&untagged).unwrap();

        repo.clear_kind_for_tag("me", "tag-good-sentence").unwrap();

        let list = repo.list_by_book("me", "book_a");
        let by_id = |id: &str| list.iter().find(|x| x.id == id).unwrap().kind.clone();
        assert_eq!(by_id("1"), "");
        assert_eq!(by_id("2"), "tag-proverb");
        assert_eq!(by_id("3"), "");
    }

    #[test]
    fn seg_range_roundtrip() {
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        let mut x = h("1", "b", 0, 3, "quick fox");
        x.start_seg = Some(1);
        x.end_seg = Some(2);
        repo.upsert(&x).unwrap();
        let got = repo.list_by_book("me", "b").pop().unwrap();
        assert_eq!(got.start_seg, Some(1));
        assert_eq!(got.end_seg, Some(2));
    }

    #[test]
    fn upsert_list_remove_roundtrip() {
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        repo.upsert(&h("1", "book_a", 0, 3, "The quick fox."))
            .unwrap();
        repo.upsert(&h("2", "book_a", 0, 7, "Another line."))
            .unwrap();
        repo.upsert(&h("3", "book_b", 0, 0, "Other book.")).unwrap();
        let list = repo.list_by_book("me", "book_a");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sentence_index, 3);
        assert!(list.iter().all(|x| x.book_key == "book_a"), "按书隔离");
        repo.remove("me", "2").unwrap();
        assert_eq!(repo.list_by_book("me", "book_a").len(), 1);
    }

    #[test]
    fn remove_checks_user_ownership() {
        // K4 (2026-08-14): 传错 user_id 删不掉别人的摘录 (之前只按 id 删, 任何
        // user 都能删任意一条)。
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        let mut kids = h("1", "book_a", 0, 3, "kids");
        kids.user_id = "u-kid".into();
        repo.upsert(&kids).unwrap();
        repo.remove("me", "1").unwrap(); // 用别人的身份删, 应无效
        assert_eq!(
            repo.list_by_book("u-kid", "book_a").len(),
            1,
            "不属于 me, 删不掉"
        );
        repo.remove("u-kid", "1").unwrap(); // 用自己的身份删, 应生效
        assert_eq!(repo.list_by_book("u-kid", "book_a").len(), 0);
    }

    #[test]
    fn user_isolation_same_book() {
        // V1 (2026-08-09): 同一本书不同 user 的摘录互不可见
        let db = temp_db();
        let repo = HighlightsRepo::new(&db);
        let mut mine = h("1", "book_a", 0, 3, "mine");
        mine.user_id = "me".into();
        let mut kids = h("2", "book_a", 0, 5, "kids");
        kids.user_id = "u-kid".into();
        repo.upsert(&mine).unwrap();
        repo.upsert(&kids).unwrap();
        let mine_list = repo.list_by_book("me", "book_a");
        assert_eq!(mine_list.len(), 1);
        assert_eq!(mine_list[0].selected_text, "mine");
        let kids_list = repo.list_by_book("u-kid", "book_a");
        assert_eq!(kids_list.len(), 1);
        assert_eq!(kids_list[0].selected_text, "kids");
    }
}
