/**
 * scripts/verify_cf_free_tier.mjs —— L11 (2026-08-11) CF 免费档真实链路验证
 *
 * 打在干净的测试 namespace (aidulc-sync-test-kv id=05e6499e..., 非生产 aidulc-sync-kv)。
 * 与桌面端 sync_v1_client 同一协议:
 *   1. 桌面连接: ROOT_SECRET → POST /v1/auth/device 换 token (user=me)
 *   2. 从 0 词加 20 词: POST /v1/sync 推 20 条
 *   3. 手机拉到: 再换 token (模拟手机扫码) → GET /v1/sync?since=0 拉全量
 *   4. 写次数 ≤ 25: 从 0 开始推 20 词, KV 键数 = 实际写次数
 *      (每条词一个键 + user 索引/rev 等元数据键, 详见 index.js 的键布局)。
 *
 * 用法 (必须显式给测试 worker URL + 测试 namespace id, 仓库不含真实域名 —— F3 纪律):
 *   CF_TEST_URL=https://<你的测试worker域名> \
 *   CF_TEST_SECRET=<测试ROOT_SECRET> \
 *   node scripts/verify_cf_free_tier.mjs --namespace-id <测试namespace id>
 * 只允许打测试 worker / 测试 namespace, 绝不打生产 (F3 纪律; 脚本内置防呆拒绝生产 namespace)。
 */
import { execSync } from 'child_process';

const BASE = process.env.CF_TEST_URL || '';
const ROOT_SECRET = process.env.CF_TEST_SECRET || '';
const NAMESPACE_ID = process.argv.includes('--namespace-id')
  ? process.argv[process.argv.indexOf('--namespace-id') + 1]
  : '';

if (!BASE || !ROOT_SECRET) {
  console.error('必须给 CF_TEST_URL 和 CF_TEST_SECRET 环境变量 (指向测试 worker, 绝不打生产)');
  process.exit(2);
}
if (!NAMESPACE_ID) {
  console.error('必须给 --namespace-id (测试 KV namespace id, 绝不打生产 aidulc-sync-kv)');
  process.exit(2);
}
// 防呆: 生产 namespace id 直接拒绝
if (NAMESPACE_ID === '9a914017364c43ec943edb6443834c4d') {
  console.error('拒绝: 这是生产 namespace (aidulc-sync-kv)。CF 免费档验证必须用干净测试 namespace。');
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function kvKeys() {
  const out = execSync(`wrangler kv key list --namespace-id ${NAMESPACE_ID} --remote`, {
    encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const arr = JSON.parse(out || '[]');
    if (Array.isArray(arr)) return arr.map((k) => k.name).filter(Boolean);
  } catch (e) { /* 老版本 wrangler 输出 `{ name: 'key' }` 行 */ }
  const keys = (out.match(/\{ name: '([^']+)'/g) || [])
    .map((s) => s.replace(/\{ name: '/, '').replace(/'$/, ''));
  return keys;
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = {}; }
  return { status: res.status, j };
}

console.log('== L11 CF 免费档真实链路 (测试 namespace, 非生产) ==');
console.log('BASE =', BASE);
console.log('namespace =', NAMESPACE_ID);

// 0. 前置: 从 0 开始 (干净测试 namespace)
const keys0 = kvKeys();
check('0. 测试 namespace 从 0 开始 (干净)', keys0.length === 0, `keys=${keys0.length}`);

// 1. 桌面连接: ROOT_SECRET 换 token
const auth = await call('POST', '/v1/auth/device', {
  body: { root_secret: ROOT_SECRET, device_name: 'L11-verify-desktop' },
});
check('① 桌面连接: auth/device → 200 + token', auth.status === 200 && auth.j.token, `${auth.status}`);
const token = auth.j.token;
check('  token 非空', !!token);

// 2. 从 0 词加 20 词
const words = {};
for (let i = 0; i < 20; i++) {
  const key = 'cfverify' + i;
  words[key] = {
    word: key, lemma: key, phonetic: '',
    meaning: '测试词 ' + i, context: 'sentence for ' + key,
    stage: 'new', interval_ms: 0, ease_factor: 2.5, next_review: null,
    reviews: 0, updated_at: Date.now() + i, edition_id: 'e-test', chapter_index: 0, sentence_index: i,
  };
}
const push = await call('POST', '/v1/sync', { token, body: { words } });
check('② 桌面推 20 词 → 200', push.status === 200, `${push.status}`);
check('  服务端确认 wrote=20', push.j.wrote === 20, `wrote=${push.j.wrote}`);

// 3. 手机拉到: 新 device token (模拟扫码) 拉全量
const phoneAuth = await call('POST', '/v1/auth/device', {
  body: { root_secret: ROOT_SECRET, device_name: 'L11-verify-phone' },
});
const phoneToken = phoneAuth.j.token;
const pull = await call('GET', '/v1/sync?since=0', { token: phoneToken });
const pulled = (pull.j.changed || pull.j.words || []).length;
check('③ 手机拉到 ≥20 词', pull.status === 200 && pulled >= 20, `pulled=${pulled}`);

// 4. 写次数 = KV 键数 (从 0 开始, 一次推 20 词, 没有旧数据混入)
const keysAfter = kvKeys();
check('④ 全程写次数 (KV 键数) ≤ 25', keysAfter.length > 0 && keysAfter.length <= 25, `keys=${keysAfter.length}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
