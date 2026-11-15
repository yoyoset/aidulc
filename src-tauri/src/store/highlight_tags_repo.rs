//! store/highlight_tags_repo.rs —— 摘录自定义标签唯一写者 (2026-09-05)
//!
//! v36 上线的固定三分类(默认/待复习/生词相关)当天就被用户反馈"不够用、也不知道
//! 去哪加标签"。改成用户自己定义标签(比如"好句子"/"谚语"/"情感强烈"), 这张表
//! 只存标签定义本身(id/label), 不存"哪条摘录打了哪个标签"——那部分仍然是
//! highlights.kind 字段(自由文本, 存这里某条标签的 id, 空串 = 未打标签),
//! 唯一写者仍是 highlights_repo.rs, 这里不碰 highlights 表。
//! 删标签时需要把 highlights.kind 里等于这个 id 的行清空, 这是跨表写, 按项目
//! 约定不能在这个 repo 里直接写 highlights 表——由调用方(ipc/commands.rs 的
//! highlight_tag_delete 命令)依次调用两个 repo 各自的方法完成, 不是原子事务,
//! 但两步操作都是幂等/无害的(先删标签行还是先清引用, 谁先谁后都不会留脏数据):
//! 就算中途崩溃, 最坏情况是残留一个不存在的 tag_id 引用, 前端按"找不到就当未
//! 打标签"处理, 不会展示错误标签。

use crate::infrastructure::lock::MutexExt;
use crate::store::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightTag {
    pub id: String,
    pub user_id: String,
    pub label: String,
    pub created_at: i64,
}

pub struct HighlightTagsRepo<'a> {
    db: &'a Db,
}

impl<'a> HighlightTagsRepo<'a> {
    pub fn new(db: &'a Db) -> Self {
        Self { db }
    }

    pub fn create(&self, tag: &HighlightTag) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "INSERT INTO highlight_tags (id, user_id, label, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![tag.id, tag.user_id, tag.label, tag.created_at],
        )
        .map_err(|e| format!("新建标签失败: {e}"))?;
        Ok(())
    }

    pub fn rename(&self, user_id: &str, id: &str, label: &str) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "UPDATE highlight_tags SET label = ?1 WHERE id = ?2 AND user_id = ?3",
            params![label, id, user_id],
        )
        .map_err(|e| format!("改标签名失败: {e}"))?;
        Ok(())
    }

    pub fn list_by_user(&self, user_id: &str) -> Vec<HighlightTag> {
        let conn = self.db.conn.lock_or_recover();
        let mut stmt = conn
            .prepare(
                "SELECT id, user_id, label, created_at FROM highlight_tags
                 WHERE user_id = ?1 ORDER BY created_at",
            )
            .unwrap();
        stmt.query_map(params![user_id], |r| {
            Ok(HighlightTag {
                id: r.get(0)?,
                user_id: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn remove(&self, user_id: &str, id: &str) -> Result<(), String> {
        let conn = self.db.conn.lock_or_recover();
        conn.execute(
            "DELETE FROM highlight_tags WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )
        .map_err(|e| format!("删标签失败: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path =
            std::env::temp_dir().join(format!("aidulc_hltag_test_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    fn tag(id: &str, user: &str, label: &str) -> HighlightTag {
        HighlightTag {
            id: id.into(),
            user_id: user.into(),
            label: label.into(),
            created_at: 100,
        }
    }

    #[test]
    fn create_list_remove_roundtrip() {
        let db = temp_db();
        let repo = HighlightTagsRepo::new(&db);
        repo.create(&tag("t1", "me", "好句子")).unwrap();
        repo.create(&tag("t2", "me", "谚语")).unwrap();
        let list = repo.list_by_user("me");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].label, "好句子");
        repo.remove("me", "t1").unwrap();
        assert_eq!(repo.list_by_user("me").len(), 1);
    }

    #[test]
    fn rename_updates_label_only() {
        let db = temp_db();
        let repo = HighlightTagsRepo::new(&db);
        repo.create(&tag("t1", "me", "旧名")).unwrap();
        repo.rename("me", "t1", "新名").unwrap();
        assert_eq!(repo.list_by_user("me")[0].label, "新名");
    }

    #[test]
    fn user_isolation() {
        let db = temp_db();
        let repo = HighlightTagsRepo::new(&db);
        repo.create(&tag("t1", "me", "我的标签")).unwrap();
        repo.create(&tag("t2", "u-kid", "小孩的标签")).unwrap();
        assert_eq!(repo.list_by_user("me").len(), 1);
        assert_eq!(repo.list_by_user("u-kid").len(), 1);
        // 用别人的身份删不掉
        repo.remove("me", "t2").unwrap();
        assert_eq!(repo.list_by_user("u-kid").len(), 1, "不属于 me, 删不掉");
    }
}
