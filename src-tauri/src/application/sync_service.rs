//! application/sync_service.rs —— 同步编排 + 状态机 (I-C, V6 重写)
//!
//! 状态: unconfigured | offline | synced | failed | pending
//! - unconfigured: 无 worker url 或 token
//! - offline: 网络失败 (本地照常用, 不阻塞)
//! - synced: 最近一次成功, 无待推
//! - pending: 最近一次成功但有待推 (N 条待推; 或曾经离线/尚未推过)
//! - failed: 结构性错误 (token 无效/HTTP 4xx)
//!
//! V6 (2026-08-09):
//! - 按当前 user 分账 (user_id 参数, 不再硬编码 profile "default")
//! - 先推后拉: 每次同步先推本地未推的改动, 再拉远端 (任何情况不许先拉覆盖未推本地)
//! - pending 由 sync_state.last_push_at 计算: updated_at > last_push_at 的词条数
//! - 协议 v1 (sync_v1_client), 词条最小集 (词/音标/释义/来源单句)

use crate::infrastructure::sync_v1_client;
use crate::store::sync_state_repo::{SyncState, SyncStateRepo};
use crate::store::Db;
use rusqlite::params;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncStatus {
    pub status: String,
    pub configured: bool,
    pub worker_url: String, // M7 R7: 已配置的 Worker URL (masked, 前端展示/断开确认用)
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub pending_count: usize,
    pub user_id: String,
    // UX A2 (2026-08-11): 最近一次同步实际推/拉条数 + 服务端是否有词库。
    // 前端显示「本次推 N 条 / 拉 M 条」; N=0 且服务端 deck 为空 → 警示, 不许显示"已同步"。
    pub last_wrote: usize,
    pub last_pulled: usize,
    pub deck_exists: bool,
}

/// UX A2: 一次同步动作的结果 (推 N 条 / 拉 M 条 / 服务端是否有词库)。
/// 纯 status() 查询没有动作 → 用 Default (0/0/false), 前端只对"刚同步完"的响应做警示判断。
#[derive(Debug, Clone, Copy, Default)]
pub struct SyncOutcome {
    pub last_wrote: usize,
    pub last_pulled: usize,
    pub deck_exists: bool,
}

fn mask_url(url: &str) -> String {
    if url.len() > 28 {
        format!("{}…", &url[..24])
    } else {
        url.to_string()
    }
}

/// UX A1 (2026-08-11): 同步进度归属键 = worker_url + 服务端 user_id。
/// 换 URL / 换服务端 user → 键变 → 视为从未同步、全量重推 (宁可多推, 不可少推)。
fn endpoint_key_for(worker_url: &str, server_user: &str) -> String {
    format!("{worker_url}|{server_user}")
}

/// 读取同步状态, 按 endpoint_key 是否匹配决定是否全量重推。
/// endpoint_key 为空 (老行/从未同步) 或与当前不匹配 (换 URL/换服务端 user) → 全量重推。
fn resolve_state(
    db: &Db,
    user_id: &str,
    worker_url: &str,
    server_user: &str,
) -> (Option<SyncState>, bool) {
    let state = SyncStateRepo::new(db).get(user_id);
    let matched = state
        .as_ref()
        .map(|s| {
            !s.endpoint_key.is_empty()
                && s.endpoint_key == endpoint_key_for(worker_url, server_user)
        })
        .unwrap_or(false);
    (state, !matched)
}

/// 计算 pending: 该 user 本地词条中 updated_at > last_push_at 的数量
/// (V6: 需要 sync_state.last_push_at; 从没同步过 → 全部待推)。
fn pending_count(db: &Db, user_id: &str) -> usize {
    let last_push = SyncStateRepo::new(db)
        .get(user_id)
        .map(|s| s.last_push_at)
        .unwrap_or(0);
    let conn = db.conn.lock().unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vocab WHERE user_id = ?1 AND updated_at > ?2",
            params![user_id, last_push],
            |r| r.get(0),
        )
        .unwrap_or(0);
    drop(conn);
    n as usize
}

fn status_for(
    configured: bool,
    url: &str,
    user_id: &str,
    last: Option<(i64, Result<(), String>)>,
    pending: usize,
    outcome: SyncOutcome,
) -> SyncStatus {
    let base = SyncStatus {
        status: String::new(),
        configured,
        worker_url: mask_url(url),
        last_sync_at: None,
        last_error: None,
        pending_count: pending,
        user_id: user_id.to_string(),
        last_wrote: outcome.last_wrote,
        last_pulled: outcome.last_pulled,
        deck_exists: outcome.deck_exists,
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
        (true, Some((ts, Ok(())))) if pending == 0 => SyncStatus {
            status: "synced".into(),
            last_sync_at: Some(ts),
            ..base
        },
        (true, Some((ts, Ok(())))) => SyncStatus {
            status: "pending".into(),
            last_sync_at: Some(ts),
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

use std::sync::Mutex;
use std::sync::OnceLock;
static LAST_SYNC: OnceLock<Mutex<std::collections::HashMap<String, (i64, Result<(), String>)>>> =
    OnceLock::new();

fn last_sync_for(user_id: &str) -> Option<(i64, Result<(), String>)> {
    LAST_SYNC
        .get()
        .and_then(|m| m.lock().unwrap().get(user_id).cloned())
}

pub fn reset_last_sync(user_id: &str) {
    let m = LAST_SYNC.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    m.lock().unwrap().remove(user_id);
}

/// F4 (2026-08-11): 强制全量重推 —— 清掉该 user 的 sync_state 行 (last_push_at 归 0,
/// endpoint_key 清空), 下次同步按"从未同步"全量重推。用于: 服务端数据被清/损坏后,
/// endpoint 没变 (endpoint_key 匹配) 所以 A1 不会触发全量重推的场景。
pub fn force_full_reset(db: &Db, user_id: &str) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM sync_state WHERE user_id = ?1", [user_id])
        .map_err(|e| format!("清同步状态失败: {e}"))?;
    drop(conn);
    reset_last_sync(user_id);
    Ok(())
}

fn record_sync(user_id: &str, result: Result<(), String>) {
    let now = crate::store::now_ms_for_store();
    let m = LAST_SYNC.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    m.lock().unwrap().insert(user_id.to_string(), (now, result));
}

/// 当前同步状态 (某 user)
pub fn get_status(db: &Db, worker_url: &str, token: &str, user_id: &str) -> SyncStatus {
    let configured = !worker_url.is_empty() && !token.is_empty();
    let pending = if configured {
        pending_count(db, user_id)
    } else {
        0
    };
    let last = last_sync_for(user_id);
    status_for(
        configured,
        worker_url,
        user_id,
        last,
        pending,
        SyncOutcome::default(),
    )
}

/// 词条 → 协议 v1 的最小集 (服务端只存这些, 不含书正文)
fn to_minimal_payload(e: &crate::domain::vocab::VocabEntry) -> serde_json::Value {
    serde_json::json!({
        "word": e.word,
        "lemma": e.lemma,
        "phonetic": e.phonetic,
        "meaning": e.meaning,
        "context": e.context,
        "stage": e.stage,
        "interval_ms": e.interval_ms,
        "ease_factor": e.ease_factor,
        "next_review": e.next_review,
        "reviews": e.reviews,
        "updated_at": e.updated_at,
        "edition_id": e.edition_id,
        "chapter_index": e.chapter_index,
        "sentence_index": e.sentence_index,
    })
}

/// 立即同步 (某 user): **先推后拉**。
/// 1. 推: 本地未推的词条 (updated_at > last_push_at) 整批 POST /v1/sync
/// 2. 拉: 增量 GET /v1/sync?since={last_pull_rev}, 远端更新的词条按新者胜写回本地
/// 3. 成功后更新 sync_state (last_push_at / last_pull_rev)
///
/// UX A1 (2026-08-11): 换 URL 或换服务端 user 后 endpoint_key 不匹配 → 视为从未同步
/// 全量重推, 杜绝"last_push_at 还是旧服务端的值 → 选出空集 → 显示已同步但服务端是空的"。
pub fn sync_now(
    db: &Db,
    worker_url: &str,
    token: &str,
    server_user: &str,
    user_id: &str,
) -> Result<SyncStatus, String> {
    if worker_url.is_empty() || token.is_empty() {
        return Ok(status_for(
            false,
            worker_url,
            user_id,
            None,
            0,
            SyncOutcome::default(),
        ));
    }
    let (state, force_full) = resolve_state(db, user_id, worker_url, server_user);
    let current_key = endpoint_key_for(worker_url, server_user);
    let last_push_at = if force_full {
        0
    } else {
        state.as_ref().map(|s| s.last_push_at).unwrap_or(0)
    };
    let last_pull_rev = if force_full {
        0
    } else {
        state.as_ref().map(|s| s.last_pull_rev).unwrap_or(0)
    };

    // 1. 先推: 本地未推词条 (任何 profile, 归该 user)
    // P0 修复 (2026-08-10): 同一 lemma 在多个 profile 里时, 按 lemma 打包会互相覆盖且
    // 顺序不确定 —— 改为每 lemma 取 updated_at 最新一条 (确定性), 避免推送不确定行为。
    let repo = crate::store::vocab_repo::VocabRepo::new(db);
    let entries = repo.list_all_for_user(user_id);
    let mut to_push: Vec<(String, serde_json::Value)> = Vec::new();
    for e in &entries {
        let key = e.lemma.to_lowercase();
        // 该 lemma 是否已有更高 updated_at 的待推条目 (跨 profile 取最新)
        let already_newer = to_push.iter().any(|(k, v)| {
            k == &key && v.get("updated_at").and_then(|x| x.as_i64()).unwrap_or(0) >= e.updated_at
        });
        if already_newer {
            continue;
        }
        // 更旧的同 lemma 条目要移除 (让最新那条占位)
        to_push.retain(|(k, _)| k != &key);
        if e.updated_at > last_push_at {
            to_push.push((key, to_minimal_payload(e)));
        }
    }

    let push_result = if to_push.is_empty() {
        Ok(sync_v1_client::PushResult {
            ok: true,
            rev: last_pull_rev,
            wrote: 0,
            code: None,
            error: None,
            written_keys: vec![],
        })
    } else {
        // S2 (2026-08-10) 前置护栏: 先查 worker 能力 (写配额)。CF KV 免费档每天 1000 次
        // 写不同键, 推送是一词一个键 → 待推 N 词 + 1 (deck index) 超限则**发之前就拒绝**,
        // 不推一半撞配额。VPS 文件存储无配额 (max_writes_per_day=null) → 跳过检查。
        // 旧版 worker 无 /v1/capabilities → 跳过 (靠 worker 侧护栏兜底, 不强拒)。
        if let Ok(cap) = sync_v1_client::capabilities(worker_url) {
            if let Some(limit) = cap.max_writes_per_day {
                let estimate = to_push.len() as i64 + 1;
                if estimate > limit {
                    let msg = format!(
                        "本次需 {estimate} 次写 (待推 {} 词 + deck index), 免费档每天 {limit} —— 请分批或改用自建后端",
                        to_push.len()
                    );
                    record_sync(user_id, Err(msg.clone()));
                    let last = last_sync_for(user_id);
                    return Ok(status_for(
                        true,
                        worker_url,
                        user_id,
                        last,
                        pending_count(db, user_id),
                        SyncOutcome::default(),
                    ));
                }
            }
        }
        sync_v1_client::push(worker_url, token, &to_push)
    };

    // S2: worker 侧护栏兜底 —— 中途写失败 (配额/限流) 返回部分结果。客户端只把**真正
    // 写成功**的词条算作已推 (last_push_at 推进到"最靠前的未写词条"之下), 未写的一律
    // 保持待推, 不把失败当成功。
    let push_result = match push_result {
        Ok(p) if !p.ok => {
            let written: std::collections::HashSet<&str> =
                p.written_keys.iter().map(|k| k.as_str()).collect();
            let unwritten_min_updated: Option<i64> = to_push
                .iter()
                .filter(|(k, _)| !written.contains(k.as_str()))
                .filter_map(|(_, v)| v.get("updated_at").and_then(|x| x.as_i64()))
                .min();
            // UX A1: 全量重推时, 旧 last_push_at 属于别的服务端, 不得参与 max() —— 否则
            // 部分失败后仍会沿用旧值, 换服务端的"宁可多推"语义被打破。
            let state_now = SyncStateRepo::new(db).get(user_id);
            let old_last_push = if force_full {
                0
            } else {
                state_now.as_ref().map(|s| s.last_push_at).unwrap_or(0)
            };
            // 全部写成功 (deck 落盘失败这种边角) → 按全量推进; 否则停在最靠前未写词之前
            let new_last_push = match unwritten_min_updated {
                None => crate::store::now_ms_for_store(),
                Some(min) => (min - 1).max(old_last_push),
            };
            let _ = SyncStateRepo::new(db).upsert(&SyncState {
                user_id: user_id.to_string(),
                last_push_at: new_last_push,
                last_pull_rev: p.rev,
                updated_at: crate::store::now_ms_for_store(),
                endpoint_key: current_key.clone(),
            });
            let msg = p
                .error
                .clone()
                .unwrap_or_else(|| format!("同步部分失败: 已写入 {} 条", p.wrote));
            record_sync(user_id, Err(msg.clone()));
            let last = last_sync_for(user_id);
            return Ok(status_for(
                true,
                worker_url,
                user_id,
                last,
                pending_count(db, user_id),
                SyncOutcome {
                    last_wrote: p.wrote as usize,
                    last_pulled: 0,
                    deck_exists: false,
                },
            ));
        }
        other => other,
    };

    let wrote_this_push = match &push_result {
        Ok(p) => p.wrote as usize,
        Err(_) => 0,
    };
    let push_result = match push_result {
        Ok(p) => p,
        Err(e) => {
            record_sync(user_id, Err(e.clone()));
            let last = last_sync_for(user_id);
            return Ok(status_for(
                true,
                worker_url,
                user_id,
                last,
                pending_count(db, user_id),
                SyncOutcome {
                    last_wrote: 0,
                    last_pulled: 0,
                    deck_exists: false,
                },
            ));
        }
    };

    // 2. 再拉: 增量
    let pull_result = sync_v1_client::pull(worker_url, token, push_result.rev);
    match pull_result {
        Ok(pr) => {
            // 远端更新的词条 → 本地 (复用 domain/sync.rs 新者胜合并)
            let _ = merge_remote_into_local(db, user_id, &pr.changed);
            // 3. 更新 sync_state (成功)
            let now = crate::store::now_ms_for_store();
            let _ = SyncStateRepo::new(db).upsert(&SyncState {
                user_id: user_id.to_string(),
                last_push_at: now,
                last_pull_rev: pr.rev,
                updated_at: now,
                endpoint_key: current_key,
            });
            record_sync(user_id, Ok(()));
            let last = last_sync_for(user_id);
            Ok(status_for(
                true,
                worker_url,
                user_id,
                last,
                pending_count(db, user_id),
                SyncOutcome {
                    last_wrote: wrote_this_push,
                    last_pulled: pr.changed.len(),
                    deck_exists: pr.deck_exists,
                },
            ))
        }
        Err(e) => {
            record_sync(user_id, Err(e.clone()));
            let last = last_sync_for(user_id);
            Ok(status_for(
                true,
                worker_url,
                user_id,
                last,
                pending_count(db, user_id),
                SyncOutcome {
                    last_wrote: wrote_this_push,
                    last_pulled: 0,
                    deck_exists: false,
                },
            ))
        }
    }
}

/// UX A1 实测修正 (2026-08-11): 服务端词条是 snake_case 最小集 (`updated_at`/
/// `interval_ms`/`ease_factor`/`next_review`), 而 VocabEntry 的 serde 只认 camelCase
/// (`updatedAt`/`intervalMs`/`easeFactor`/`nextReview`)。直接 `from_value` 会把它们
/// 全解成默认值 —— 拉回写盘时丢 SRS 状态 + 把 updated_at 打成 0, 破坏"新者胜"判据。
/// 这里补读 snake_case 字段, 与 camelCase 并存 (服务端两种都可能给)。
fn remote_to_entry(r: &serde_json::Value) -> Option<crate::domain::vocab::VocabEntry> {
    let mut e: crate::domain::vocab::VocabEntry = serde_json::from_value(r.clone()).ok()?;
    if let Some(v) = r.get("updated_at").and_then(|x| x.as_i64()) {
        e.updated_at = v;
    }
    if let Some(v) = r.get("interval_ms").and_then(|x| x.as_i64()) {
        e.interval_ms = v;
        e.interval = v as f64 / 86_400_000.0;
    }
    if let Some(v) = r.get("ease_factor").and_then(|x| x.as_f64()) {
        e.ease_factor = v;
    }
    if let Some(v) = r.get("next_review").and_then(|x| x.as_i64()) {
        e.next_review = Some(v);
    }
    Some(e)
}

/// 远端 changed 词条 → 本地, 复用 domain/sync.rs 的 merge_envelopes (新者胜)。
/// P0 修复 (2026-08-10): 写回**原 profile** (get_any_profile 返回 profile_id),
/// 只有本地真没有该 lemma 时才落 "default"。此前写死 default → me:kid:reticent
/// 的远端更新会新建 me:default:reticent 重复行, 同一词分裂成两行两套复习状态。
/// UX A1 实测修正 (2026-08-11): 只有**远端严格更新** (远端 updated_at > 本地) 才写回。
/// 此前按 `r.updated_at == m.updated_at` 找合并结果, 而"本地新 / 同时间戳"时合并结果
/// 就是本地 envelope —— 照样命中并把远端最小集 (snake_case) 写回来, 等于每次拉取都拿
/// 解析成 0 的 SRS 状态覆盖本地 (updated_at 打 0、interval/ease/next_review 清零)。
/// 返回写回条数 (测试断言用)。
fn merge_remote_into_local(db: &Db, user_id: &str, changed: &[serde_json::Value]) -> usize {
    use crate::domain::sync::{merge_envelopes, Envelope};
    let repo = crate::store::vocab_repo::VocabRepo::new(db);
    let mut local_envs: Vec<Envelope> = Vec::new();
    let mut remote_envs: Vec<Envelope> = Vec::new();
    let mut local_profile: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for item in changed {
        let Ok(remote) = serde_json::from_value::<serde_json::Value>(item.clone()) else {
            continue;
        };
        let lemma = remote
            .get("lemma")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| remote.get("word").and_then(|v| v.as_str()).unwrap_or(""))
            .to_lowercase();
        let updated_at = remote
            .get("updated_at")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if let Some((profile, l)) = repo.get_any_profile(user_id, &lemma) {
            local_envs.push(Envelope {
                key: lemma.clone(),
                updated_at: l.updated_at,
                payload: serde_json::to_value(&l).unwrap_or(serde_json::Value::Null),
            });
            local_profile.insert(lemma.clone(), profile);
        }
        remote_envs.push(Envelope {
            key: lemma,
            updated_at,
            payload: remote,
        });
    }
    let merged = merge_envelopes(&local_envs, &remote_envs);
    let mut wrote = 0usize;
    for m in &merged {
        // 远端严格更新 (本地无该词, 或远端 updated_at 更大) → 写回。
        // 相等时间戳 = 本地就是源头 → 不写 (此前这里会拿远端最小集覆盖本地, 见函数注释)。
        let remote_won = match local_envs.iter().find(|l| l.key == m.key) {
            Some(l) => m.updated_at > l.updated_at,
            None => true,
        };
        if remote_won {
            if let Some(r) = remote_envs.iter().find(|r| r.key == m.key) {
                if let Some(entry) = remote_to_entry(&r.payload) {
                    // 写回原 profile (该 lemma 本地在哪个 profile 就写哪); 真新词落 default
                    let target_profile = local_profile
                        .get(&m.key)
                        .cloned()
                        .unwrap_or_else(|| "default".to_string());
                    if repo.upsert_sync(entry, user_id, &target_profile).is_ok() {
                        wrote += 1;
                    }
                }
            }
        }
    }
    wrote
}

/// 仅拉取合并 (前端"拉取"按钮; 正常流程用 sync_now 的先推后拉)
/// UX A1: 换服务端后 last_pull_rev 属于旧服务端, 必须按 0 处理 (全量拉) 并记新 endpoint_key。
pub fn sync_pull(
    db: &Db,
    worker_url: &str,
    token: &str,
    server_user: &str,
    user_id: &str,
) -> Result<SyncStatus, String> {
    if worker_url.is_empty() || token.is_empty() {
        return Ok(status_for(
            false,
            worker_url,
            user_id,
            None,
            0,
            SyncOutcome::default(),
        ));
    }
    let (state, force_full) = resolve_state(db, user_id, worker_url, server_user);
    let current_key = endpoint_key_for(worker_url, server_user);
    let last_pull_rev = if force_full {
        0
    } else {
        state.as_ref().map(|s| s.last_pull_rev).unwrap_or(0)
    };
    let pr = sync_v1_client::pull(worker_url, token, last_pull_rev)?;
    let _ = merge_remote_into_local(db, user_id, &pr.changed);
    let now = crate::store::now_ms_for_store();
    // UX A1: 换服务端后旧 last_push_at 作废 → 0 (下次 sync_now 全量重推)。
    // 全新本地 (state 不存在) 是首次拉取, 拉回的词本就在这个服务端 → 不算待推 (用 now)。
    let last_push_at = if force_full && state.is_some() {
        0
    } else {
        state.as_ref().map(|s| s.last_push_at).unwrap_or(now)
    };
    let _ = SyncStateRepo::new(db).upsert(&SyncState {
        user_id: user_id.to_string(),
        last_push_at,
        last_pull_rev: pr.rev,
        updated_at: now,
        endpoint_key: current_key,
    });
    record_sync(user_id, Ok(()));
    let last = last_sync_for(user_id);
    Ok(status_for(
        true,
        worker_url,
        user_id,
        last,
        pending_count(db, user_id),
        SyncOutcome {
            last_wrote: 0,
            last_pulled: pr.changed.len(),
            deck_exists: pr.deck_exists,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 极简 v1 worker mock: 真实 HTTP 请求, 内存字典按 token 隔离。
    /// POST /v1/sync → 记录 push; GET /v1/sync?since= → 记录 pull + 返回该 token 的词。
    /// 记录请求顺序供"先推后拉"断言。
    fn start_mock_worker() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let order2 = order.clone();

        std::thread::spawn(move || {
            let mut store: std::collections::HashMap<String, serde_json::Value> =
                std::collections::HashMap::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut req_line = String::new();
                if reader.read_line(&mut req_line).is_err() {
                    continue;
                }
                let mut headers = std::collections::HashMap::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    } else if let Some(v) = lower.strip_prefix("authorization:") {
                        headers.insert("authorization".to_string(), v.trim().to_string());
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let token = headers.get("authorization").cloned().unwrap_or_default();
                let parts: Vec<&str> = req_line.split(' ').collect();
                let method = parts[0].to_string();
                let path = parts.get(1).cloned().unwrap_or("/").to_string();

                let resp = if method == "POST" && path == "/v1/sync" {
                    order2.lock().unwrap().push(format!("push:{token}"));
                    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                    let words = v.get("words").cloned().unwrap_or(serde_json::json!({}));
                    let n = words.as_object().map(|m| m.len()).unwrap_or(0);
                    // 合并进已有 store (worker 是逐词写 srs key, 推新词不丢旧词)
                    let mut existing = store.get(&token).cloned().unwrap_or(serde_json::json!({}));
                    if let (Some(ex), Some(incoming)) =
                        (existing.as_object_mut(), words.as_object())
                    {
                        for (k, val) in incoming {
                            ex.insert(k.clone(), val.clone());
                        }
                    }
                    store.insert(token.clone(), existing);
                    let rev = 1 + store.keys().len() as i64;
                    serde_json::json!({ "ok": true, "rev": rev, "wrote": n })
                } else if method == "GET" && path.starts_with("/v1/sync") {
                    order2.lock().unwrap().push(format!("pull:{token}"));
                    let words = store.get(&token).cloned().unwrap_or(serde_json::json!({}));
                    let changed: Vec<serde_json::Value> = words
                        .as_object()
                        .map(|m| m.values().cloned().collect())
                        .unwrap_or_default();
                    serde_json::json!({ "ok": true, "rev": 7, "changed": changed })
                } else {
                    serde_json::json!({ "ok": false, "error": "not found" })
                };
                let payload = serde_json::to_vec(&resp).unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
        });
        (format!("http://{addr}"), order)
    }

    fn entry(word: &str, updated_at: i64) -> crate::domain::vocab::VocabEntry {
        crate::domain::vocab::VocabEntry {
            word: word.into(),
            lemma: word.to_lowercase(),
            pos: "NOUN".into(),
            meaning: "含义".into(),
            sense_id: None,
            phonetic: String::new(),
            context: String::new(),
            level: String::new(),
            collocations: vec![],
            deep_data: serde_json::Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: 1,
            updated_at,
            edition_id: None,
            chapter_index: None,
            sentence_index: None,
        }
    }

    fn temp_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("aidulc_syncs_test_{}_{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn sync_now_push_then_pull_per_user() {
        // V6 验收: 先推后拉 + 按 user 分账 + 远端条数对上
        let (url, order) = start_mock_worker();
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        repo.upsert_content(entry("bank", 100), "me", "default")
            .unwrap();
        repo.upsert_content(entry("languid", 200), "me", "default")
            .unwrap();

        let s = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s.status, "synced", "推拉成功应 synced (待推 0): {s:?}");
        assert_eq!(s.pending_count, 0, "同步后无待推");
        assert_eq!(s.last_wrote, 2, "本次应推 2 条 (UX A2): {s:?}");

        // 先推后拉: 两次 push 在 pull 之前
        let log = order.lock().unwrap().clone();
        let push_positions: Vec<usize> = log
            .iter()
            .enumerate()
            .filter(|(_, x)| x.starts_with("push:"))
            .map(|(i, _)| i)
            .collect();
        let pull_pos = log.iter().position(|x| x.starts_with("pull:"));
        assert!(!push_positions.is_empty(), "应发生 push: {log:?}");
        if let Some(pp) = pull_pos {
            assert!(
                push_positions.last().unwrap() < &pp,
                "push 必须在 pull 之前 (先推后拉): {log:?}"
            );
        }
    }

    #[test]
    fn endpoint_change_triggers_full_repush() {
        // UX A1 验收 (2026-08-11): 换服务端 (URL 或服务端 user 变) → endpoint_key 不匹配
        // → 视为从未同步、全量重推。此前 last_push_at 沿用旧服务端的值 → 选出空集 → 显示
        // "已同步"但服务端是空的 (后台没做事, 用户以为成功) —— 这是本文档要修的最差情况。
        let (url, order) = start_mock_worker();
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        repo.upsert_content(entry("bank", 100), "me", "default")
            .unwrap();
        repo.upsert_content(entry("languid", 200), "me", "default")
            .unwrap();

        // 首轮: 同步到服务端 user "me" → 推 2 条
        let s1 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s1.status, "synced", "{s1:?}");
        assert_eq!(s1.last_wrote, 2, "首轮应推 2 条: {s1:?}");
        let pushes1 = order
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("push:"))
            .count();
        assert_eq!(pushes1, 1, "首轮 1 次 push");

        // 换服务端 (同一 URL 但服务端 user 变 —— 与换 URL 等价): 第二次必须全量重推
        let s2 = sync_now(&db, &url, "token-b", "another-server-user", "me").unwrap();
        assert_eq!(s2.status, "synced", "{s2:?}");
        assert_eq!(s2.last_wrote, 2, "换端点后应全量重推 2 条: {s2:?}");
        let pushes2 = order
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("push:"))
            .count();
        assert_eq!(
            pushes2, 2,
            "换端点后应发生第二次 push (全量重推): {pushes2}"
        );

        // 同端点再同步 → 无新词 → 不再 push (增量路径, 不重复全量)
        let s3 = sync_now(&db, &url, "token-b", "another-server-user", "me").unwrap();
        assert_eq!(s3.status, "synced", "{s3:?}");
        assert_eq!(s3.last_wrote, 0, "同端点无新词 → 推 0 条: {s3:?}");
        let pushes3 = order
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("push:"))
            .count();
        assert_eq!(pushes3, 2, "同端点第三次同步不应再 push: {pushes3}");
    }

    #[test]
    fn force_full_reset_triggers_repush_on_same_endpoint() {
        // F4 验收 (2026-08-11): 服务端数据被清后, endpoint 没变 (endpoint_key 匹配) → A1
        // 不会自动全量重推。force_full_reset 清 sync_state → 下次同步即使同端点也全量重推。
        let (url, order) = start_mock_worker();
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        repo.upsert_content(entry("bank", 100), "me", "default")
            .unwrap();

        // 首轮同步成功 (推 1 条, 同端点下次不推)
        let s1 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s1.last_wrote, 1, "首轮推 1 条: {s1:?}");
        let pushes1 = order
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("push:"))
            .count();
        assert_eq!(pushes1, 1, "首轮 1 次 push");

        // 同端点无新词 → 推 0
        let s2 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s2.last_wrote, 0, "同端点无新词推 0: {s2:?}");

        // 强制全量重推: 清 sync_state
        force_full_reset(&db, "me").unwrap();

        // 同端点再同步 → 必须全量重推 1 条 (A1 不会触发, 是 force_full 兜底的场景)
        let s3 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s3.last_wrote, 1, "强制重推后应再推 1 条: {s3:?}");
        let pushes3 = order
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("push:"))
            .count();
        assert_eq!(
            pushes3, 2,
            "同端点 force_full 后应发生第二次 push: {pushes3}"
        );
    }

    #[test]
    fn two_tokens_do_not_cross() {
        // V6 验收: 两个 token 数据不串 (服务端按 token 隔离)
        let (url, _order) = start_mock_worker();
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        // 我 (token-a) 和 孩子 (token-b) 各推各的
        repo.upsert_content(entry("bank", 100), "me", "default")
            .unwrap();
        sync_now(&db, &url, "token-a", "me", "me").unwrap();
        repo.upsert_content(entry("kids", 100), "u-kid", "default")
            .unwrap();
        sync_now(&db, &url, "token-b", "u-kid", "u-kid").unwrap();

        // 重新造一个干净本地, 用 token-a 拉 → 只该拿到 bank, 拿不到 kids
        let db2 = temp_db();
        let repo2 = crate::store::vocab_repo::VocabRepo::new(&db2);
        // 清空本地后 sync_pull (token-a): mock 的 GET 只返回 token-a 的词
        let st = sync_pull(&db2, &url, "token-a", "me", "me").unwrap();
        assert_eq!(st.status, "synced", "{st:?}");
        let got = repo2.list_all_for_user("me");
        let words: Vec<&str> = got.iter().map(|e| e.word.as_str()).collect();
        assert!(words.contains(&"bank"), "token-a 应拉到 bank: {words:?}");
        assert!(
            !words.contains(&"kids"),
            "token-a 不应拿到孩子的词 (数据不串): {words:?}"
        );
    }

    #[test]
    fn offline_grading_then_reconnect_recovers_synced() {
        // V6 验收: 离线评分 → 重连 → 回"已同步"且远端条数对上
        let (url, _order) = start_mock_worker();
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        let t0 = crate::store::now_ms_for_store();
        repo.upsert_content(entry("bank", t0 - 5000), "me", "default")
            .unwrap();

        // 第一次同步成功
        let s1 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s1.status, "synced");
        assert_eq!(s1.pending_count, 0);

        // 确保 austere 的 updated_at 严格晚于 last_push_at (毫秒级时间戳, 防同 ms)
        std::thread::sleep(std::time::Duration::from_millis(30));
        // 离线评分: 本地加了新词 (updated_at 更新), 但 worker 不可达 → failed/offline
        repo.upsert_content(
            entry("austere", crate::store::now_ms_for_store()),
            "me",
            "default",
        )
        .unwrap();
        let offline = sync_now(&db, "http://127.0.0.1:1", "token-a", "me", "me").unwrap();
        assert_eq!(offline.status, "failed", "连不上 → failed: {offline:?}");
        // pending 应 > 0 (新词未推)
        assert!(offline.pending_count >= 1, "离线后应有待推: {offline:?}");

        // 重连 → 回已同步
        let s2 = sync_now(&db, &url, "token-a", "me", "me").unwrap();
        assert_eq!(s2.status, "synced", "重连后回 synced: {s2:?}");
        assert_eq!(s2.pending_count, 0);
        // 远端条数对上: mock 服务端现在存了 token-a 的 bank+austere
        let pr = crate::infrastructure::sync_v1_client::pull(&url, "token-a", 0).unwrap();
        assert_eq!(pr.changed.len(), 2, "远端应有 2 条 (bank+austere): {pr:?}");
    }

    #[test]
    fn unconfigured_when_no_url() {
        let s = status_for(false, "", "me", None, 0, SyncOutcome::default());
        assert_eq!(s.status, "unconfigured");
        assert!(!s.configured);
        assert!(s.worker_url.is_empty());
    }

    #[test]
    fn synced_when_success_no_pending() {
        let s = status_for(
            true,
            "https://me.workers.dev",
            "me",
            Some((100, Ok(()))),
            0,
            SyncOutcome::default(),
        );
        assert_eq!(s.status, "synced");
        assert_eq!(s.pending_count, 0);
        assert_eq!(s.user_id, "me");
        assert_eq!(
            s.last_wrote, 0,
            "纯 status 查询没有动作 → last_wrote 默认 0"
        );
    }

    #[test]
    fn pending_when_success_but_unsynced() {
        let s = status_for(
            true,
            "https://me.workers.dev",
            "me",
            Some((100, Ok(()))),
            5,
            SyncOutcome::default(),
        );
        assert_eq!(s.status, "pending", "成功后仍有待推 → pending");
        assert_eq!(s.pending_count, 5);
    }

    #[test]
    fn failed_when_error() {
        let s = status_for(
            true,
            "",
            "me",
            Some((100, Err("网络错误".into()))),
            3,
            SyncOutcome::default(),
        );
        assert_eq!(s.status, "failed");
        assert!(s.last_error.is_some());
    }

    #[test]
    fn url_masked_when_long() {
        assert!(mask_url("https://very-long-name-abc-def-ghi.workers.dev/path").ends_with('…'));
        assert_eq!(mask_url("https://me.workers.dev"), "https://me.workers.dev");
    }

    #[test]
    fn minimal_payload_only_has_srs_and_minimal_set() {
        let e = crate::domain::vocab::VocabEntry {
            word: "bank".into(),
            lemma: "bank".into(),
            pos: "NOUN".into(),
            meaning: "银行".into(),
            sense_id: None,
            phonetic: "/bæŋk/".into(),
            context: "He went to the bank.".into(),
            level: String::new(),
            collocations: vec![],
            deep_data: serde_json::Value::Null,
            stage: "new".into(),
            interval: 0.0,
            interval_ms: 0,
            ease_factor: 2.5,
            next_review: None,
            reviews: 0,
            last_review: None,
            last_grade: None,
            added_at: 1,
            updated_at: 2,
            edition_id: Some("e1".into()),
            chapter_index: Some(3),
            sentence_index: Some(4),
        };
        let p = to_minimal_payload(&e);
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"word\":\"bank\""));
        assert!(s.contains("\"meaning\":\"银行\""));
        assert!(s.contains("\"context\":\"He went to the bank.\""));
        assert!(!s.contains("collocations"), "不传词典/书正文: {s}");
        assert!(!s.contains("deepData"), "不传 deepData: {s}");
        assert!(
            s.contains("\"edition_id\":\"e1\""),
            "来源定位应随最小集: {s}"
        );
    }

    #[test]
    fn pull_writes_back_to_original_profile_not_default_duplicate() {
        // P0 回归 (2026-08-10): 本地 kid 有词 → 远端更新拉回 → 必须写回 kid 行,
        // 不产生 me:default:reticent 重复行; SRS 落在 kid 行上。
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        let t0 = crate::store::now_ms_for_store();
        let mut e = entry("reticent", t0);
        e.meaning = "本地释义".into();
        // upsert_sync 保留 entry.updated_at (upsert_content 会覆盖为 now, 导致本地恒新)
        repo.upsert_sync(e, "me", "kid").unwrap();
        assert!(
            repo.get("me", "kid", "reticent").is_some(),
            "本地 kid 应有词"
        );
        assert!(
            repo.get("me", "default", "reticent").is_none(),
            "初始 default 不应有"
        );

        // 远端更新 (updated_at 更大), 模拟另一台设备改了这个词。
        // 用 to_minimal_payload 构造 (worker 返回的是 snake_case updated_at, 不是 VocabEntry 的 camelCase)
        let mut remote = entry("reticent", t0 + 1000);
        remote.meaning = "远端新释义".into();
        remote.stage = "review".into();
        remote.interval_ms = 3 * 86_400_000;
        remote.ease_factor = 3.0;
        remote.next_review = Some(t0 + 3000);
        let changed = vec![to_minimal_payload(&remote)];

        let wrote = merge_remote_into_local(&db, "me", &changed);
        assert_eq!(wrote, 1, "远端新 → 应写回 1 条");

        // 关键断言: 不产生 default 重复行
        assert!(
            repo.get("me", "default", "reticent").is_none(),
            "P0 bug: 远端更新不得在 default 新建重复行"
        );
        // SRS 落在 kid 行
        let kid = repo.get("me", "kid", "reticent").expect("kid 行应在");
        assert_eq!(kid.meaning, "远端新释义", "SRS/内容应落在 kid 行");
        assert_eq!(kid.stage, "review");
        // UX A1 实测修正: 服务端最小集是 snake_case, 拉回解析不能把 SRS 状态丢成默认值
        assert_eq!(
            kid.updated_at,
            t0 + 1000,
            "updated_at 应随 snake_case 字段保留: {kid:?}"
        );
        assert_eq!(
            kid.interval_ms,
            3 * 86_400_000,
            "interval_ms 应保留: {kid:?}"
        );
        assert_eq!(kid.ease_factor, 3.0, "ease_factor 应保留: {kid:?}");
        assert_eq!(
            kid.next_review,
            Some(t0 + 3000),
            "next_review 应保留: {kid:?}"
        );
        // 全表只有 1 行该 lemma
        assert_eq!(repo.list_all_for_user("me").len(), 1, "不应分裂成两行");
    }

    #[test]
    fn pull_equal_timestamp_does_not_overwrite_local() {
        // UX A1 实测修正 (2026-08-11): 本地就是该词源头 (updated_at 相等) → 拉回不得
        // 用远端最小集覆盖本地。此前按 `r.updated_at == m.updated_at` 命中合并结果,
        // 把 snake_case 最小集解析成 0 的 SRS 写回 → updated_at 打成 0, interval/ease 清零。
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        let t0 = crate::store::now_ms_for_store();
        let mut local = entry("same", t0);
        local.meaning = "本地释义".into();
        local.interval_ms = 8 * 86_400_000;
        local.ease_factor = 3.5;
        local.next_review = Some(t0 + 9000);
        repo.upsert_sync(local, "me", "default").unwrap();

        // 远端是最小集, 时间戳与本地相同 (就是本地推上去的) → 不得写回
        let remote = entry("same", t0);
        let changed = vec![to_minimal_payload(&remote)];
        let wrote = merge_remote_into_local(&db, "me", &changed);
        assert_eq!(wrote, 0, "相等时间戳不得写回 (本地是源头)");

        let got = repo.get("me", "default", "same").expect("本地行应在");
        assert_eq!(got.meaning, "本地释义", "本地内容不得被远端覆盖");
        assert_eq!(got.updated_at, t0, "本地 updated_at 不得被打成 0: {got:?}");
        assert_eq!(
            got.interval_ms,
            8 * 86_400_000,
            "本地 SRS 不得清零: {got:?}"
        );
        assert_eq!(got.ease_factor, 3.5, "本地 ease_factor 不得清零: {got:?}");
    }

    #[test]
    fn pull_new_word_lands_on_default() {
        // 真新词 (本地完全没有该 lemma) → 落 default (保留原行为)
        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        let remote = entry("brandnew", crate::store::now_ms_for_store());
        let changed = vec![to_minimal_payload(&remote)];
        let wrote = merge_remote_into_local(&db, "me", &changed);
        assert_eq!(wrote, 1);
        assert!(
            repo.get("me", "default", "brandnew").is_some(),
            "真新词落 default"
        );
    }

    /// S2 (2026-08-10) 回归: 中途写失败 → 部分结果 → 客户端只把真正写成功的词标记为已推。
    /// mock 只写 2 个词 (bank/languid), 第 3 个 (austere) 失败 → 断言 austere 仍在待推,
    /// 不会因为"同步跑过"就被当成已推。
    #[test]
    fn partial_push_failure_does_not_mark_unsynced_as_synced() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut store: std::collections::HashMap<String, serde_json::Value> =
                std::collections::HashMap::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut req_line = String::new();
                if reader.read_line(&mut req_line).is_err() {
                    continue;
                }
                let mut headers = std::collections::HashMap::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    } else if let Some(v) = lower.strip_prefix("authorization:") {
                        headers.insert("authorization".to_string(), v.trim().to_string());
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let token = headers.get("authorization").cloned().unwrap_or_default();
                let parts: Vec<&str> = req_line.split(' ').collect();
                let method = parts[0].to_string();
                let path = parts.get(1).cloned().unwrap_or("/").to_string();

                let resp = if method == "GET" && path.starts_with("/v1/capabilities") {
                    // S2: 声明 CF KV (max_writes_per_day=1000) 之外还要声明 max_push_words
                    serde_json::json!({
                        "ok": true, "storage": "cf",
                        "max_writes_per_day": 1000, "max_push_words": 2000,
                    })
                } else if method == "POST" && path == "/v1/sync" {
                    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                    let words = v.get("words").cloned().unwrap_or(serde_json::json!({}));
                    let mut existing = store.get(&token).cloned().unwrap_or(serde_json::json!({}));
                    let written: Vec<String> = words
                        .as_object()
                        .map(|m| m.keys().filter(|k| *k != "austere").cloned().collect())
                        .unwrap_or_default();
                    // 只写成功 2 条, 模拟第 3 条 (austere) 写失败
                    let mut wrote = 0;
                    if let (Some(ex), Some(incoming)) =
                        (existing.as_object_mut(), words.as_object())
                    {
                        for (k, val) in incoming {
                            if k == "austere" {
                                continue; // 模拟写失败
                            }
                            ex.insert(k.clone(), val.clone());
                            wrote += 1;
                        }
                    }
                    store.insert(token.clone(), existing);
                    let rev = 1 + store.keys().len() as i64;
                    serde_json::json!({
                        "ok": false, "code": "kv_write_failed", "rev": rev, "wrote": wrote,
                        "written_keys": written,
                        "error": "写失败: 已写入 2 条, 其余 1 条未写入",
                    })
                } else if method == "GET" && path.starts_with("/v1/sync") {
                    let words = store.get(&token).cloned().unwrap_or(serde_json::json!({}));
                    let changed: Vec<serde_json::Value> = words
                        .as_object()
                        .map(|m| m.values().cloned().collect())
                        .unwrap_or_default();
                    serde_json::json!({ "ok": true, "rev": 7, "changed": changed })
                } else {
                    serde_json::json!({ "ok": false, "error": "not found" })
                };
                let payload = serde_json::to_vec(&resp).unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
        });
        let url = format!("http://{addr}");

        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        repo.upsert_content(entry("bank", 100), "me", "default")
            .unwrap();
        repo.upsert_content(entry("languid", 200), "me", "default")
            .unwrap();
        repo.upsert_content(entry("austere", 300), "me", "default")
            .unwrap();

        let s = sync_now(&db, &url, "token-p", "me", "me").unwrap();
        // 关键断言: austere 没写成功 → 仍在待推 (不会因 sync 跑过就被标记已推)
        assert!(
            s.pending_count >= 1,
            "部分失败后 austere 应仍待推 (pending_count={}) : {s:?}",
            s.pending_count
        );
        assert_eq!(s.status, "failed", "部分失败应为 failed: {s:?}");
        let last_err = s.last_error.clone().unwrap_or_default();
        assert!(
            last_err.contains("已写入 2 条"),
            "错误信息应含真实进度: {last_err}"
        );
        // bank/languid 已写成功 → 不再待推; 本地仍 3 条 (数据不丢)
        assert_eq!(repo.list_all_for_user("me").len(), 3, "本地词条不丢");
    }

    /// S2 (2026-08-10) 回归: 前置配额拒绝 —— worker 声明 max_writes_per_day=1000,
    /// 本地待推远超阈值 → 在发出 push 之前就拒绝并给人话提示。
    #[test]
    fn pre_push_quota_rejects_large_batch() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let pushed = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        let pushed2 = pushed.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut req_line = String::new();
                if reader.read_line(&mut req_line).is_err() {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let parts: Vec<&str> = req_line.split(' ').collect();
                let method = parts[0].to_string();
                let path = parts.get(1).cloned().unwrap_or("/").to_string();
                let resp = if method == "GET" && path.starts_with("/v1/capabilities") {
                    serde_json::json!({ "ok": true, "storage": "cf", "max_writes_per_day": 1000, "max_push_words": 2000 })
                } else if method == "POST" && path == "/v1/sync" {
                    *pushed2.lock().unwrap() += 1;
                    serde_json::json!({ "ok": true, "rev": 1, "wrote": 0 })
                } else {
                    serde_json::json!({ "ok": false, "error": "not found" })
                };
                let payload = serde_json::to_vec(&resp).unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&payload);
            }
        });
        let url = format!("http://{addr}");

        let db = temp_db();
        let repo = crate::store::vocab_repo::VocabRepo::new(&db);
        // 构造 1424 个待推词 (> 免费档 1000 阈值 + deck index; S7 验收用 1424 存量)
        for i in 0..1424 {
            let mut e = entry(&format!("word_{i}"), 100 + i as i64);
            e.word = format!("word_{i}");
            repo.upsert_content(e, "me", "default").unwrap();
        }

        let s = sync_now(&db, &url, "token-q", "me", "me").unwrap();
        assert_eq!(s.status, "failed", "超配额应被前置拒绝: {s:?}");
        let last_err = s.last_error.clone().unwrap_or_default();
        assert!(
            last_err.contains("请分批或改用自建后端"),
            "拒绝信息应是人话提示: {last_err}"
        );
        // 关键: push 请求根本没发出去
        assert_eq!(*pushed.lock().unwrap(), 0, "超配额应在发出 push 前拒绝");
    }
}
