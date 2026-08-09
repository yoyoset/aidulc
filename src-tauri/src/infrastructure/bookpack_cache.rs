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
//!
//! 2026-08-09 无限成长修复: 此前是无上限 HashMap —— 每本解析过的书常驻一条完整
//! bookpack(实测 Wolf 21 ≈ 23.88MB/条), 同一会话打开的书越多内存越涨, 只靠重启清。
//! 现在改成 LRU, 超 `DEFAULT_CAP` 条淘汰最久未用的键, 内存有界。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

/// 常驻缓存上限 (条)。取"够开会话内最近读的几本"的量级, 又限制最坏内存:
/// 以 24MB/条 估算最坏 ≈ 6 × 24MB ≈ 144MB, 不会再随开书数无限涨。
const DEFAULT_CAP: usize = 6;

#[derive(Default)]
struct CacheInner {
    map: HashMap<String, Arc<serde_json::Value>>,
    order: VecDeque<String>,
}

/// 按 pack_dir 缓存已解析的 bookpack (完整 JSON, 未 strip)。LRU: 命中移到队尾,
/// 插入超上限淘汰队首 (最久未用)。
pub struct BookpackCache {
    inner: Mutex<CacheInner>,
    cap: usize,
}

impl BookpackCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CacheInner::default()),
            cap: DEFAULT_CAP,
        }
    }

    /// 测试用: 用小上限验证淘汰行为。
    #[cfg(test)]
    fn with_cap(cap: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner::default()),
            cap,
        }
    }

    /// 命中返回 Some(完整 bookpack), 并标记最近使用; 未命中返回 None(调用方读盘解析后 put)。
    pub fn get(&self, key: &str) -> Option<Arc<serde_json::Value>> {
        let mut inner = self.inner.lock().unwrap();
        if inner.map.contains_key(key) {
            if let Some(pos) = inner.order.iter().position(|k| k == key) {
                let k = inner.order.remove(pos).unwrap();
                inner.order.push_back(k);
            }
            return inner.map.get(key).cloned();
        }
        None
    }

    /// 写入缓存 (key = pack_dir 字符串); 超上限淘汰最久未用的键。
    pub fn put(&self, key: &str, bookpack: serde_json::Value) -> Arc<serde_json::Value> {
        let arc = Arc::new(bookpack);
        let mut inner = self.inner.lock().unwrap();
        if !inner.map.contains_key(key) {
            inner.order.push_back(key.to_string());
        }
        inner.map.insert(key.to_string(), arc.clone());
        while inner.order.len() > self.cap {
            if let Some(old) = inner.order.pop_front() {
                inner.map.remove(&old);
            }
        }
        arc
    }

    /// 失效某个目录的缓存 (edition 覆盖/删除时调用, 防读到旧内容)。
    pub fn invalidate(&self, key: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.map.remove(key);
        inner.order.retain(|k| k != key);
    }

    /// 缓存条目数 (测试用)。
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().map.len()
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

    #[test]
    fn evicts_least_recently_used_when_over_cap() {
        // 2026-08-09 无限成长修复回归: 超上限淘汰最久未用的键, 内存有界。
        let c = BookpackCache::with_cap(2);
        c.put("a", serde_json::json!({"n": 1}));
        c.put("b", serde_json::json!({"n": 2}));
        c.get("a"); // a 最近使用
        c.put("c", serde_json::json!({"n": 3})); // 超 2 → 淘汰最久未用的 b
        assert_eq!(c.len(), 2, "超上限必须淘汰一个键");
        assert!(c.get("a").is_some(), "最近用过的 a 应保留");
        assert!(c.get("b").is_none(), "最久未用的 b 应被淘汰");
        assert!(c.get("c").is_some());
    }

    #[test]
    fn overwrite_does_not_grow() {
        // 同一键重复 put 只更新, 不制造第二条 order 记录。
        let c = BookpackCache::with_cap(3);
        c.put("a", serde_json::json!({"n": 1}));
        c.put("a", serde_json::json!({"n": 2}));
        assert_eq!(c.len(), 1);
        assert_eq!(c.get("a").unwrap()["n"], 2);
    }
}
