/**
 * index.js —— aidulc 同步服务端 (协议 v1, V5, 2026-08-09)
 *
 * worker 实例 = 一个"家"的空间 (设计裁决: 不另造 family_id)。
 * 接口 (全部带 /v1/ 前缀):
 *   POST /v1/auth/device     首台用 ROOT_SECRET 换第一个 user + token; 或 6 位码换 token
 *   POST /v1/auth/code       已登录设备生成 6 位一次性码 (add-device / invite-user)
 *   POST /v1/auth/revoke     已登录设备踢掉一个 token (P0-C: 手机配对后想收回, 删 auth:{token} 即失效)
 *   GET  /v1/sync?since={rev} 拉取该版本后变更的 SRS 状态
 *   POST /v1/sync            整批推送本地队列, 返回新 rev
 *
 * KV 键:
 *   auth:{token}              → {user_id, device_id, created_at}
 *   srs:{user}:{word_key}     → { ...SRS 最小集, updated_at, rev }
 *   deck:{user}:index         → { rev, updated_at, words: {word_key: {rev, updated_at}} }
 *   meta:{user}:device:{id}   → { name, last_pull_rev, last_push_at }
 *   code:{6位码}              → { type, user_id, name, expires_at, used }
 *   codefail:{6位码}          → { count, lock_until }
 *
 * 规则:
 *   - user 由服务端从 token 解析 (客户端不自报, 公网安全边界)
 *   - 先推后拉由客户端执行; 服务端只做"新者胜"合并 (updated_at)
 *   - 服务端只存 SRS 状态 + 词条最小集 (含来源单句), 绝不收书文件/整章正文
 *   - 6 位码 10 分钟有效、一次性; 5 次错锁 15 分钟
 *
 * 存储抽象: 业务代码只依赖 storage.js 的 get/put/delete/list 接口,
 * CF KV 和文件存储 (VPS) 是同一份代码的两个实现。
 */
'use strict';

import { createCloudflareKv, createFileKv } from './storage.js';

// ---- 常量 ----
const CODE_TTL_MS = 10 * 60 * 1000;      // 6 位码 10 分钟有效
const MAX_CODE_FAILS = 5;                 // 5 次错误
const LOCK_MS = 15 * 60 * 1000;           // 锁 15 分钟
const MAX_PUSH_WORDS = 2000;              // 单次推送词条数上限 (防滥用)
const MIN_INTERVAL = 60_000;              // 调度器最小步长兜底

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function error(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function nowMs() {
  return Date.now();
}

/** crypto.randomUUID (CF + Node 都有) */
function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function tokenFor() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 6 位数字码 */
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

/** word_key = 词头小写 (与书无关, 设计稿 §03) */
function wordKey(word) {
  return String(word || '').trim().toLowerCase();
}

export default {
  async fetch(request, env) {
    // 存储选择: CF KV 绑定 → 文件存储 (本地/VPS)
    const storage = env.DB
      ? createCloudflareKv(env.DB)
      : createFileKv(env.KV_DIR || '/tmp/aidulc-kv');

    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' },
      });
    }

    try {
      const p = url.pathname;

      if (request.method === 'POST' && p === '/v1/auth/device') {
        return await authDevice(request, storage, env);
      }
      if (request.method === 'POST' && p === '/v1/auth/code') {
        return await authCode(request, storage, env);
      }
      if (request.method === 'POST' && p === '/v1/auth/revoke') {
        return await authRevoke(request, storage);
      }
      if (request.method === 'GET' && p === '/v1/sync') {
        return await syncPull(request, storage);
      }
      if (request.method === 'POST' && p === '/v1/sync') {
        return await syncPush(request, storage, env);
      }
      // S2 (2026-08-10): 能力自述 —— 客户端推送前估算写次数用 (CF KV 有 1000/天配额,
      // 文件存储无配额; 前端据此决定是否前置拒绝, 而不是推一半撞配额)
      if (request.method === 'GET' && p === '/') {
        // UX A4 (2026-08-11): 首页返回一行纯文本 —— 浏览器/手机直接打开不再得到
        // "未找到路由: /" 这种对用户零信息的 JSON。手机请用桌面端生成的二维码链接。
        return new Response(
          'aidulc 同步服务端 v1\n这是 API, 不是网页。手机请用桌面端生成的二维码链接 (设置 → 手机扫码连接)。',
          { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        );
      }
      if (request.method === 'GET' && p === '/v1/capabilities') {
        return json({
          ok: true,
          storage: env.DB ? 'cf' : 'file',
          // CF 免费档"写不同键 1000/天" (实测 + 官方页), 见 docs/DESIGN_NOTES_SRS.md V0②
          max_writes_per_day: env.DB ? 1000 : null,
          max_push_words: MAX_PUSH_WORDS,
        });
      }

      return error('未找到路由: ' + p, 404);
    } catch (e) {
      return error('服务端异常: ' + (e && e.message), 500);
    }
  },
};

async function readJson(request) {
  const text = await request.text();
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    throw new Error('JSON 解析失败');
  }
}

/** 从 Authorization: Bearer <token> 解析 user (服务端签发, 客户端不自报) */
async function authFromToken(storage, token) {
  const raw = await storage.get('auth:' + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function requireToken(identity) {
  if (!identity) {
    return error('未授权: token 无效或缺失', 401);
  }
  return null;
}

/**
 * POST /v1/auth/device
 *   { root_secret, device_name }  → 首台 (ROOT_SECRET) 换第一个 user "me" + token
 *   { code, device_name }         → 6 位码换 token (add-device 绑现有 user / invite-user 建新 user)
 */
async function authDevice(request, storage, env) {
  const body = await readJson(request);
  const deviceName = String(body.device_name || '').trim() || 'device';

  // 路径 A: ROOT_SECRET (首台)
  if (body.root_secret !== undefined && body.root_secret !== null) {
    if (!env.ROOT_SECRET) return error('服务端未配置 ROOT_SECRET', 500);
    if (body.root_secret !== env.ROOT_SECRET) {
      return error('ROOT_SECRET 不正确', 403);
    }
    const user_id = 'me'; // 第一个 user 固定叫 me (迁移回填同名)
    // 幂等: 同一 ROOT_SECRET 重复兑换只新增设备, 不换 user
    const device_id = newId();
    const token = tokenFor();
    await storage.put(
      'auth:' + token,
      JSON.stringify({ user_id, device_id, created_at: nowMs() })
    );
    await storage.put(
      `meta:${user_id}:device:${device_id}`,
      JSON.stringify({ name: deviceName, last_pull_rev: 0, last_push_at: 0 })
    );
    return json({ ok: true, user_id, user_name: '我', device_id, token });
  }

  // 路径 B: 6 位码
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return error('请输入 6 位数字码', 400);
  }
  // 限速: 5 次错误锁 15 分钟
  const failRaw = await storage.get('codefail:' + code);
  const fail = failRaw ? JSON.parse(failRaw) : null;
  if (fail && fail.lock_until && nowMs() < fail.lock_until) {
    const mins = Math.ceil((fail.lock_until - nowMs()) / 60000);
    return error(`尝试次数过多, 已锁定 ${mins} 分钟`, 429);
  }
  const codeRaw = await storage.get('code:' + code);
  if (!codeRaw) {
    await recordFail(storage, code, fail);
    return error('验证码不存在或已过期', 404);
  }
  const rec = JSON.parse(codeRaw);
  if (rec.used) {
    await recordFail(storage, code, fail);
    return error('验证码已被使用 (一次性)', 410);
  }
  if (rec.expires_at && nowMs() > rec.expires_at) {
    await recordFail(storage, code, fail);
    return error('验证码已过期', 410);
  }
  // 一次性: 立即标记 (防并发重复兑换)
  rec.used = true;
  await storage.put('code:' + code, JSON.stringify(rec));

  // 确认 user
  let user_id = rec.user_id;
  let user_name = rec.name || '我';
  if (rec.type === 'invite-user') {
    // 服务端新建 user (uuid, 稳定; 将来账号体系只换发 token)
    user_id = newId();
    user_name = rec.name || '新成员';
  }
  const device_id = newId();
  const token = tokenFor();
  await storage.put(
    'auth:' + token,
    JSON.stringify({ user_id, device_id, created_at: nowMs() })
  );
  await storage.put(
    `meta:${user_id}:device:${device_id}`,
    JSON.stringify({ name: deviceName, last_pull_rev: 0, last_push_at: 0 })
  );
  return json({ ok: true, user_id, user_name, device_id, token });
}

async function recordFail(storage, code, fail) {
  const f = fail || { count: 0, lock_until: 0 };
  f.count = (f.count || 0) + 1;
  if (f.count >= MAX_CODE_FAILS) {
    f.lock_until = nowMs() + LOCK_MS;
    f.count = 0; // 锁期间不累计
  }
  await storage.put('codefail:' + code, JSON.stringify(f));
}

/**
 * POST /v1/auth/code   (需已登录 token)
 *   { type: 'add-device'|'invite-user', name? } → { code, expires_at }
 */
async function authCode(request, storage, env) {
  const token = bearer(request);
  const identity = token ? await authFromToken(storage, token) : null;
  const authErr = requireToken(identity);
  if (authErr) return authErr;

  const body = await readJson(request);
  const type = body.type === 'invite-user' ? 'invite-user' : 'add-device';
  const name = String(body.name || '').trim();
  if (type === 'invite-user' && !name) {
    return error('invite-user 需要填名字', 400);
  }
  const code = newCode();
  const rec = {
    type,
    user_id: identity.user_id,
    name,
    expires_at: nowMs() + CODE_TTL_MS,
    used: false,
  };
  await storage.put('code:' + code, JSON.stringify(rec));
  return json({ ok: true, code, expires_in_ms: CODE_TTL_MS });
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * POST /v1/auth/revoke   (需已登录 token)
 *   { token } → 踢掉该 token (P0-C, 2026-08-10)
 * 安全边界: 只能踢**同一 user** 的 token (本 worker 一个实例 = 一个家, 仍防跨 user 误伤)。
 * 踢掉 = 删 `auth:{token}` (删后该 token 请求全部 401) + 清对应设备 meta。
 * 返回 { ok, revoked: true|false } —— token 不存在/不属于自己时 revoked:false (不报错,
 * 幂等: 目标已失效即视为已达目的, 前端不用区分"从没配过"和"已踢掉")。
 */
async function authRevoke(request, storage) {
  const token = bearer(request);
  const caller = token ? await authFromToken(storage, token) : null;
  const authErr = requireToken(caller);
  if (authErr) return authErr;

  const body = await readJson(request);
  const target = String(body.token || '').trim();
  if (!target) {
    return error('需要 token 字段', 400);
  }
  if (target === token) {
    return error('不能踢掉当前正在使用的 token (会把自己锁在外面)', 400);
  }
  const targetAuth = await authFromToken(storage, target);
  if (!targetAuth || targetAuth.user_id !== caller.user_id) {
    // 不存在或不属于当前 user → 幂等视为已踢
    return json({ ok: true, revoked: false });
  }
  await storage.delete('auth:' + target);
  await storage.delete(`meta:${targetAuth.user_id}:device:${targetAuth.device_id}`);
  return json({ ok: true, revoked: true });
}

/**
 * GET /v1/sync?since={rev}
 * 返回该版本后变更的词条 (词条最小集, 含来源单句), 服务端按 user 隔离。
 */
async function syncPull(request, storage) {
  const token = bearer(request);
  const identity = token ? await authFromToken(storage, token) : null;
  const authErr = requireToken(identity);
  if (authErr) return authErr;
  const user_id = identity.user_id;

  const since = Math.max(0, Number(new URL(request.url).searchParams.get('since') || 0) || 0);
  const deckRaw = await storage.get(`deck:${user_id}:index`);
  let deck = deckRaw ? JSON.parse(deckRaw) : null;
  if (!deck) {
    return json({ ok: true, rev: 0, changed: [], deck_exists: false });
  }
  // 拉取 changed 词条 (rev > since); 逐词读 (镜像非真相源, 词量级小)
  const changed = [];
  for (const [key, meta] of Object.entries(deck.words || {})) {
    if (meta && meta.rev > since) {
      const raw = await storage.get(`srs:${user_id}:${key}`);
      if (raw) {
        try { changed.push(JSON.parse(raw)); } catch (e) { /* 损坏条目跳过 */ }
      }
    }
  }
  changed.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  return json({ ok: true, rev: deck.rev, changed, deck_exists: true });
}

/**
 * POST /v1/sync  body: { base_rev?, words: {word_key: entry} }
 * 整批推送: 逐条按 updated_at 新者胜写入 srs:{user}:{word}, 更新 deck index rev。
 * 返回新 rev + 远端更新的条目 (客户端随后拉取会合并)。
 *
 * S2 (2026-08-10) 写配额护栏:
 *  - CF KV 免费档"写不同键 1000/天" (docs/DESIGN_NOTES_SRS.md V0②)。推送是一词一个
 *    KV 键, 首次全量写次数 = 词条数 + 1 (deck index)。词条数超 1000 直接前置拒绝
 *    (code=kv_write_quota), 不写一半。
 *  - 中途任何 KV 写失败 (配额/限流/瞬时故障) → 返回部分结果 { ok:false,
 *    code:"kv_write_failed", wrote:M, rev, error, written_keys:[...] },
 *    客户端据此把 last_push_at 推进到真实进度, 不把失败当成功。
 */
async function syncPush(request, storage, env) {
  const token = bearer(request);
  const identity = token ? await authFromToken(storage, token) : null;
  const authErr = requireToken(identity);
  if (authErr) return authErr;
  const user_id = identity.user_id;

  const body = await readJson(request);
  const incoming = body.words && typeof body.words === 'object' ? body.words : {};
  const keys = Object.keys(incoming);
  if (keys.length > MAX_PUSH_WORDS) {
    return error(`单次推送词条数超限 (${MAX_PUSH_WORDS})`, 413);
  }
  if (!keys.length) {
    return json({ ok: true, rev: 0, wrote: 0 });
  }

  // S2 前置护栏: CF KV 每次推送的写次数 = 词条数 + 1 (deck index)。免费档 1000/天,
  // 超限直接拒绝 (VPS 文件存储 env.KV_DIR 无配额, 不受限)。
  const freeTierWriteBudget = env.DB ? 1000 : null;
  if (freeTierWriteBudget && keys.length + 1 > freeTierWriteBudget) {
    return json({
      ok: false,
      code: 'kv_write_quota',
      wrote: 0,
      rev: 0,
      error: `本次需 ${keys.length} 次写 (词条各 1 次 + deck index), 免费档每天 ${freeTierWriteBudget} —— 请分批或改用自建后端`,
    });
  }

  const deckRaw = await storage.get(`deck:${user_id}:index`);
  let deck = deckRaw
    ? JSON.parse(deckRaw)
    : { rev: 0, updated_at: 0, words: {} };

  // 逐条新者胜 (镜像不是真相源: 本地/远端冲突取 updated_at 大者)
  let wrote = 0;
  const writtenKeys = [];
  let lastError = null;
  for (const key of keys) {
    const entry = incoming[key];
    if (!entry || typeof entry !== 'object') continue;
    const wkey = wordKey(entry.word || key);
    const existingRaw = await storage.get(`srs:${user_id}:${wkey}`);
    let existing = existingRaw ? JSON.parse(existingRaw) : null;
    const incomingUpdatedAt = Number(entry.updated_at || entry.updatedAt || 0);
    if (existing && existing.updated_at > incomingUpdatedAt) {
      continue; // 本地(远端已存)较新, 不覆盖
    }
    const now = nowMs();
    const nextRev = deck.rev + 1;
    const saved = {
      word: entry.word || wkey,
      lemma: wordKey(entry.lemma || entry.word || wkey),
      phonetic: entry.phonetic || '',
      meaning: entry.meaning || '',
      context: entry.context || '',
      stage: entry.stage || 'new',
      interval_ms: Math.max(0, Number(entry.interval_ms || 0)),
      ease_factor: entry.ease_factor || 2.5,
      next_review: entry.next_review != null ? entry.next_review : null,
      reviews: Number(entry.reviews || 0),
      updated_at: incomingUpdatedAt || now,
      // 来源定位最小集 (来源单句, 不传整章正文)
      edition_id: entry.edition_id || null,
      chapter_index: entry.chapter_index != null ? entry.chapter_index : null,
      sentence_index: entry.sentence_index != null ? entry.sentence_index : null,
      rev: nextRev,
    };
    try {
      await storage.put(`srs:${user_id}:${wkey}`, JSON.stringify(saved));
    } catch (e) {
      // S2: 中途写失败 (配额/限流) → 记录已写部分, 停止, 返回部分结果
      lastError = String((e && e.message) || e);
      break;
    }
    deck.words[wkey] = { rev: nextRev, updated_at: saved.updated_at };
    deck.rev = nextRev;
    deck.updated_at = now;
    wrote++;
    writtenKeys.push(wkey);
  }

  if (lastError) {
    // 已写部分也要落盘 deck index (让 rev 只覆盖真正写成功的), 避免"未写也标记已推"
    try {
      await storage.put(`deck:${user_id}:index`, JSON.stringify(deck));
    } catch (_) {
      // deck 写不进也没关系 —— rev 仍推进到已写部分, 客户端下次按 wrote 对账
    }
    return json({
      ok: false,
      code: 'kv_write_failed',
      wrote,
      rev: deck.rev,
      error: `写失败 (${lastError}): 已写入 ${wrote} 条, 其余 ${keys.length - wrote} 条未写入`,
      written_keys: writtenKeys,
    });
  }

  await storage.put(`deck:${user_id}:index`, JSON.stringify(deck));
  await storage.put(
    `meta:${user_id}:device:${identity.device_id}`,
    JSON.stringify({ name: identity.device_id, last_push_at: nowMs(), last_pull_rev: deck.rev })
  );

  return json({ ok: true, rev: deck.rev, wrote });
}
