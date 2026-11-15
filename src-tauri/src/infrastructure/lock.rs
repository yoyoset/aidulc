//! infrastructure/lock.rs —— S4 (2026-11-15): 中毒可恢复的取锁
//!
//! 背景: 全库有 200+ 处 `mutex.lock().unwrap()`。`Mutex` 的"中毒"是指某个线程持锁时
//! panic —— 之后任何线程再 `lock()` 都返回 `Err`, `unwrap()` 就跟着 panic。数据库连接
//! 是整个应用唯一的一把 `Mutex<Connection>`, 所以一个命令线程在持库锁时出一次 panic,
//! 之后**每一个**命令 (查词/保存进度/列书库…) 都会在取锁处连环 panic, 用户只能重启。
//!
//! 对本项目的锁, 中毒后继续用是安全的:
//!
//! - `Connection`: panic 展开时事务对象的 Drop 会回滚, 连接本身仍然可用;
//! - 队列 / 子进程句柄 / 进度 / URL 之类: 都是简单值, 最坏是停在上一次写入的状态。
//!
//! 所以这里把 `PoisonError` 里的 guard 取出来继续用, 同时记一条错误日志留证据。
//!
//! 只替换了非测试代码里的 `.lock().unwrap()`; 测试里中毒就该让测试失败, 不需要恢复。

use std::sync::{Mutex, MutexGuard};

pub trait MutexExt<T> {
    /// 取锁; 锁已中毒时恢复并继续 (记日志), 不 panic。
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| {
            crate::infrastructure::log::error(
                "lock",
                "互斥锁已中毒 (曾有线程持锁时 panic), 已恢复并继续使用",
            );
            poisoned.into_inner()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_or_recover_survives_panicked_holder() {
        let m = std::sync::Arc::new(Mutex::new(5i32));
        let m2 = m.clone();
        let r = std::thread::spawn(move || {
            let mut g = m2.lock().unwrap();
            *g = 6;
            panic!("模拟持锁时崩溃");
        })
        .join();
        assert!(r.is_err(), "前置: 线程确实 panic 了");
        assert!(m.is_poisoned(), "前置: 锁确实中毒了");
        assert!(m.lock().is_err(), "前置: 普通 lock() 此时会返回 Err");
        assert_eq!(*m.lock_or_recover(), 6, "恢复后应能读到 panic 前写入的值");
    }

    #[test]
    fn db_lock_survives_panicked_holder() {
        // S4 验收: 一个线程持库锁时 panic 后, 主线程仍能正常查询 (此前每个命令都会连环 panic)。
        let path = std::env::temp_dir().join(format!("aidulc_lock_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = std::sync::Arc::new(crate::store::Db::open(path.to_str().unwrap()).unwrap());
        let db2 = db.clone();
        let r = std::thread::spawn(move || {
            let _g = db2.conn.lock_or_recover();
            panic!("模拟持库锁时崩溃");
        })
        .join();
        assert!(r.is_err());
        assert!(db.conn.is_poisoned(), "前置: 库锁确实中毒了");
        let n: i64 = db
            .conn
            .lock_or_recover()
            .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
