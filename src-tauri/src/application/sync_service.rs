//! application/sync_service.rs —— 同步编排 + 状态机 (I-C)
//!
//! 状态: unconfigured | offline | synced | failed
//! - unconfigured: 无 worker url 或 token
//! - offline: 网络失败 (本地照常用, 不阻塞)
//! - synced: 最近一次成功
//! - failed: 结构性错误 (token 无效/HTTP 4xx)

use crate::infrastructure::aidu_worker_client::{self as sync, WorkerEnvelope};
use crate::store::Db;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncStatus {
    pub status: String,
    pub configured: bool,
    pub worker_url: String, // M7 R7: 已配置的 Worker URL (masked, 前端展示/断开确认用)
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub pending_count: usize,
}

fn mask_url(url: &str) -> String {
    // 保留下划线/域名可辨但藏长串: 前 24 字符 + "..."
    if url.len() > 28 {
        format!("{}…", &url[..24])
    } else {
        url.to_string()
    }
}

fn status(
    configured: bool,
    url: &str,
    last: Option<(i64, Result<(), String>)>,
    pending: usize,
) -> SyncStatus {
    let base = SyncStatus {
        status: String::new(),
        configured,
        worker_url: mask_url(url),
        last_sync_at: None,
        last_error: None,
        pending_count: pending,
    };
    match (configured, last) {
        (false, _) => SyncStatus {
            status: "unconfigured".into(),
            ..base
        },
        (true, None) => SyncStatus {
            status: "offline".into(),
            ..base
        },
        (true, Some((ts, Ok(())))) => SyncStatus {
            status: "synced".into(),
            last_sync_at: Some(ts),
            pending_count: 0,
            ..base
        },
        (true, Some((ts, Err(e)))) => SyncStatus {
            status: "failed".into(),
            last_sync_at: Some(ts),
            last_error: Some(e),
            ..base
        },
    }
}

/// 当前同步状态
pub fn get_status(db: &Db, worker_url: &str, token: &str) -> SyncStatus {
    let configured = !worker_url.is_empty() && !token.is_empty();
    let repo = crate::store::vocab_repo::VocabRepo::new(db);
    // pending = 本地生词数 (简化: 全部本地生词待同步)
    // V1 (2026-08-09): 暂时按默认 user 统计, V6 接线后按当前 user
    let pending = if configured {
        repo.list(crate::store::users_repo::DEFAULT_USER_ID, "default")
            .len()
    } else {
        0
    };
    // 上次结果存内存全局 (进程内足够; 持久化后续)
    let last = get_last_sync();
    status(configured, worker_url, last, pending)
}

use std::sync::Mutex;
use std::sync::OnceLock;
static LAST_SYNC: OnceLock<Mutex<Option<(i64, Result<(), String>)>>> = OnceLock::new();

fn get_last_sync() -> Option<(i64, Result<(), String>)> {
    LAST_SYNC.get().and_then(|m| m.lock().unwrap().clone())
}

/// R2-1 (2026-08-08): 断开同步时清空进程内上次同步结果, 防断开后旧的
/// "synced 时间"残留展示 (status 只认配置态, 但清掉更干净)。
pub fn reset_last_sync() {
    let slot = LAST_SYNC.get_or_init(|| Mutex::new(None));
    *slot.lock().unwrap() = None;
}

fn record_sync(result: Result<(), String>) {
    let now = crate::store::now_ms_for_store();
    let slot = LAST_SYNC.get_or_init(|| Mutex::new(None));
    *slot.lock().unwrap() = Some((now, result));
}

/// 立即同步 (push 当前 profile 生词)
/// V1 (2026-08-09): 暂时按默认 user + 'default' profile, V6 接线后按当前 user
pub fn sync_now(db: &Db, worker_url: &str, token: &str) -> Result<SyncStatus, String> {
    if worker_url.is_empty() || token.is_empty() {
        return Ok(status(false, worker_url, None, 0));
    }
    let repo = crate::store::vocab_repo::VocabRepo::new(db);
    let uid = crate::store::users_repo::DEFAULT_USER_ID;
    let entries = repo.list(uid, "default");
    let pairs: Vec<(String, serde_json::Value)> = entries
        .iter()
        .filter_map(|e| {
            let key = e.lemma.to_lowercase();
            let payload = serde_json::to_value(e).ok()?;
            Some((key, payload))
        })
        .collect();
    let envelope = WorkerEnvelope::from_entries(&pairs);

    let result = sync::push_profile(worker_url, token, "default", &envelope);
    record_sync(result.clone());
    Ok(status(
        true,
        worker_url,
        Some((crate::store::now_ms_for_store(), result)),
        0,
    ))
}

/// 拉取合并 (AIDU 远端 → 本地)
/// M 系列: 复用 domain::merge_envelopes (新者胜) + WorkerEnvelope::to_envelopes,
/// 不再内联 updatedAt 比较 (历史: 三套重复实现之一)。
pub fn sync_pull(db: &Db, worker_url: &str, token: &str) -> Result<SyncStatus, String> {
    if worker_url.is_empty() || token.is_empty() {
        return Ok(status(false, worker_url, None, 0));
    }
    let remote = sync::pull_profile(worker_url, token, "default");
    let uid = crate::store::users_repo::DEFAULT_USER_ID;
    match remote {
        Ok(Some(env)) => {
            let repo = crate::store::vocab_repo::VocabRepo::new(db);
            // 本地 → Envelope; 远端 → Envelope; 合并 (新者胜, domain 规则)
            let local_envs: Vec<crate::domain::sync::Envelope> = repo
                .list(uid, "default")
                .iter()
                .map(|e| crate::domain::sync::Envelope {
                    key: e.lemma.to_lowercase(),
                    updated_at: e.updated_at,
                    payload: serde_json::to_value(e).unwrap_or(serde_json::Value::Null),
                })
                .collect();
            let remote_envs = env.to_envelopes();
            let merged = crate::domain::sync::merge_envelopes(&local_envs, &remote_envs);
            // 远端赢的条目 (本地无 / 远端 updatedAt 更大) → 写回本地
            for m in &merged {
                let local_has = local_envs.iter().any(|le| le.key == m.key);
                let local_newer = local_envs
                    .iter()
                    .any(|le| le.key == m.key && le.updated_at >= m.updated_at);
                if local_has && local_newer {
                    continue; // 本地较新, 不覆盖
                }
                if let Some(payload) = remote_envs
                    .iter()
                    .find(|re| re.key == m.key)
                    .map(|re| re.payload.clone())
                {
                    if let Ok(entry) =
                        serde_json::from_value::<crate::domain::vocab::VocabEntry>(payload)
                    {
                        let _ = repo.upsert_sync(entry, uid, "default");
                    }
                }
            }
            record_sync(Ok(()));
            Ok(get_status(db, worker_url, token))
        }
        Ok(None) => {
            // 404 新 profile: 推送本地
            let s = sync_now(db, worker_url, token)?;
            Ok(s)
        }
        Err(e) => {
            record_sync(Err(e.clone()));
            Ok(status(
                true,
                worker_url,
                Some((crate::store::now_ms_for_store(), Err(e))),
                0,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_when_no_url() {
        let s = status(false, "", None, 0);
        assert_eq!(s.status, "unconfigured");
        assert!(!s.configured);
        assert!(s.worker_url.is_empty());
    }

    #[test]
    fn synced_when_success() {
        let s = status(true, "https://me.workers.dev", Some((100, Ok(()))), 5);
        assert_eq!(s.status, "synced");
        assert_eq!(s.pending_count, 0);
        assert!(s.configured);
        assert!(s.worker_url.contains("https://me"), "URL 应透传供前端展示");
    }

    #[test]
    fn failed_when_error() {
        let s = status(true, "", Some((100, Err("网络错误".into()))), 3);
        assert_eq!(s.status, "failed");
        assert!(s.last_error.is_some());
    }

    #[test]
    fn url_masked_when_long() {
        assert!(mask_url("https://very-long-name-abc-def-ghi.workers.dev/path").ends_with('…'));
        assert_eq!(mask_url("https://me.workers.dev"), "https://me.workers.dev");
    }
}
