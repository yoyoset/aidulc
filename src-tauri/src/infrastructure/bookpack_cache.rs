//! infra/bookpack_cache.rs —— 书包解析缓存 (阶段3, 2026-08-09)
//!
//! 背景 (docs/FORENSIC_P0.md §4, 实测): `load_bookpack` 和 `load_bookpack_chapter`
//! 每次请求都 `std::fs::read_to_string` 读整个 bookpack.json + `serde_json::from_str`
//! 全量解析。真实 Wolf 21 书包(23.88MB)实测: 单次 open 读+解析 ≈ 470ms, 每切一章
//! ≈ 419ms 整文件重读重解析 —— 大书多章切换时明显卡顿甚至像死掉。
//!
//! 修法: 按书包目录(唯一标识)缓存解析后的完整 bookpack, `load_bookpack` 写入、
//! `load_bookpack_chapter` 优先取缓存。edition 独占 pack_dir + 覆盖时原子换新目录,
//! 所以"目录路径"就是稳定的缓存键, 换新包自然换键, 不会读到旧内容。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 按 pack_dir 缓存已解析的 bookpack (完整 JSON, 未 strip)。
#[derive(Default)]
pub struct BookpackCache {
    inner: Mutex<HashMap<String, Arc<serde_json::Value>>>,
}

impl BookpackCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 命中返回 Some(完整 bookpack); 未命中返回 None(调用方读盘解析后 put)。
    pub fn get(&self, key: &str) -> Option<Arc<serde_json::Value>> {
        self.inner.lock().unwrap().get(key).cloned()
    }

    /// 写入缓存 (key = pack_dir 字符串)。
    pub fn put(&self, key: &str, bookpack: serde_json::Value) -> Arc<serde_json::Value> {
        let arc = Arc::new(bookpack);
        self.inner
            .lock()
            .unwrap()
            .insert(key.to_string(), arc.clone());
        arc
    }

    /// 失效某个目录的缓存 (edition 覆盖/删除时调用, 防读到旧内容)。
    pub fn invalidate(&self, key: &str) {
        self.inner.lock().unwrap().remove(key);
    }

    /// 缓存条目数 (测试用)。
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_then_get_roundtrip() {
        let c = BookpackCache::new();
        assert!(c.get("p1").is_none());
        let v = serde_json::json!({"title": "Alice", "chapters": [1, 2]});
        c.put("p1", v.clone());
        let got = c.get("p1").expect("命中");
        assert_eq!(got["title"], "Alice");
        c.invalidate("p1");
        assert!(c.get("p1").is_none(), "invalidate 后应失效");
    }

    #[test]
    fn different_keys_do_not_collide() {
        let c = BookpackCache::new();
        c.put("p1", serde_json::json!({"title": "A"}));
        c.put("p2", serde_json::json!({"title": "B"}));
        assert_eq!(c.get("p1").unwrap()["title"], "A");
        assert_eq!(c.get("p2").unwrap()["title"], "B");
    }
}
