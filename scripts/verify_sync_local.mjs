#!/usr/bin/env node
/**
 * verify_sync_local.mjs —— 一次性验证脚本 (F3, 2026-08-11) 入库版
 *
 * 背景 (实测): 08-11 清服务端前, 有人拿临时验收脚本**用真实域名**对生产 VPS 跑了
 * 1424 词 fixture, 污染了用户生产库 (`word='w0'…'w1423'`, stage=new)。生成它的脚本
 * 不在仓库里 → 没人能复现、也没有门禁能管到它。本脚本是那次的**安全复刻**:
 * 同样的 1424 词 fixture, 但**只打本地 KV_DIR** (worker 源码直跑, 不经网络),
 * 验证"推 1424 词 → 拉回 1424 词、零丢失、零串词"。门禁 test:no-prod-endpoint
 * 保证这类脚本永远不能引用真实域名。
 *
 * 用法 (必须是临时 KV_DIR, 用完即删):
 *   node scripts/verify_sync_local.mjs [KV_DIR]
 * 默认用系统临时目录, 跑完自动删除。任何情况下都不访问网络。
 */
'use strict';

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import worker from '../cloud/worker/src/index.js';

const ROOT_SECRET = 'verify-local-secret';
const N_WORDS = 1424; // 与 S7 存量数一致, 也覆盖"同源 fixture"场景

async function run(dir) {
  // 用 KV_DIR (文件存储) = VPS/自建后端, 无 1000/天 配额限制 —— 这样才能跑 1424 词全量
  const env = { ROOT_SECRET, KV_DIR: dir };
  const base = 'http://verify.local';
  const j = (r) => r.json();

  // 1. 换 token
  const auth = await j(await worker.fetch(new Request(base + '/v1/auth/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_secret: ROOT_SECRET, device_name: 'verifier' }),
  }), env));
  if (!auth.ok || !auth.token) throw new Error('换 token 失败: ' + JSON.stringify(auth));
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token };

  // 2. 推 1424 词 (与生产被污染的那批同规模同命名)
  const words = {};
  const now = Date.now();
  for (let i = 0; i < N_WORDS; i++) {
    words['w' + i] = { word: 'w' + i, lemma: 'w' + i, meaning: '含义' + i, stage: 'new', updated_at: now - i };
  }
  const push = await j(await worker.fetch(new Request(base + '/v1/sync', {
    method: 'POST', headers: H, body: JSON.stringify({ words }),
  }), env));
  if (!push.ok) throw new Error('推送失败: ' + JSON.stringify(push));

  // 3. 拉回全量 (since=0) 核对
  const pull = await j(await worker.fetch(new Request(base + '/v1/sync?since=0', { headers: H }), env));
  if (!pull.ok) throw new Error('拉取失败: ' + JSON.stringify(pull));
  const changed = pull.changed || [];
  const lemmas = new Set(changed.map((w) => w.lemma));

  const missing = [];
  for (let i = 0; i < N_WORDS; i++) if (!lemmas.has('w' + i)) missing.push('w' + i);
  const mixed = changed.filter((w) => w.lemma.startsWith('w') && !/^w\d+$/.test(w.lemma));

  console.log('推 1424 → 拉回 ' + changed.length + ' 条');
  console.log('缺失: ' + missing.length + (missing.length ? ' (' + missing.slice(0, 5).join(',') + '…)' : ''));
  console.log('串词/杂项: ' + mixed.length);
  console.log('零丢失: ' + (missing.length === 0));
  console.log('零串词: ' + (mixed.length === 0));

  if (missing.length !== 0 || mixed.length !== 0 || changed.length !== N_WORDS) {
    process.exitCode = 1;
  }
}

const dir = process.argv[2] || mkdtempSync(join(tmpdir(), 'aidulc-verify-sync-'));
const absolute = resolve(dir);
const exists = existsSync(absolute);
console.log('KV_DIR: ' + absolute + (exists ? ' (已存在, 跑完不删)' : ' (临时, 跑完删除)'));
try {
  await run(absolute);
} catch (e) {
  console.error('失败: ' + e.message);
  process.exitCode = 1;
} finally {
  if (!exists) { try { rmSync(absolute, { recursive: true, force: true }); } catch (e) {} }
}
