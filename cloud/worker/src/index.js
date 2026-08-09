/**
 * index.js —— aidulc 同步服务端 (协议 v1, V5, 2026-08-09)
 *
 * worker 实例 = 一个"家"的空间 (设计裁决: 不另造 family_id)。
 * 接口 (全部带 /v1/ 前缀):
 *   POST /v1/auth/device     首台用 ROOT_SECRET 换第一个 user + token; 或 6 位码换 token
 *   POST /v1/auth/code       已登录设备生成 6 位一次性码 (add-device / invite-user)
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
      if (request.method === 'GET' && p === '/v1/sync') {
        return await syncPull(request, storage);
      }
      if (request.method === 'POST' && p === '/v1/sync') {
        return await syncPush(request, storage);
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
 */
async function syncPush(request, storage) {
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

  const deckRaw = await storage.get(`deck:${user_id}:index`);
  let deck = deckRaw
    ? JSON.parse(deckRaw)
    : { rev: 0, updated_at: 0, words: {} };

  // 逐条新者胜 (镜像不是真相源: 本地/远端冲突取 updated_at 大者)
  let wrote = 0;
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
    await storage.put(`srs:${user_id}:${wkey}`, JSON.stringify(saved));
    deck.words[wkey] = { rev: nextRev, updated_at: saved.updated_at };
    deck.rev = nextRev;
    deck.updated_at = now;
    wrote++;
  }

  await storage.put(`deck:${user_id}:index`, JSON.stringify(deck));
  await storage.put(
    `meta:${user_id}:device:${identity.device_id}`,
    JSON.stringify({ name: identity.device_id, last_push_at: nowMs(), last_pull_rev: deck.rev })
  );

  return json({ ok: true, rev: deck.rev, wrote });
}
