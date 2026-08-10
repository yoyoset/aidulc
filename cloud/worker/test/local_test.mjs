/**
 * local_test.mjs —— 服务端协议 v1 本地实测 (V5 验收)
 *
 * 不用 miniflare/wrangler dev, 直接 import worker 的 fetch handler + 文件 KV 存储,
 * 用真实 Request/Response 对象驱动同一份业务代码。覆盖三种场景:
 *   1. 鉴权失败 (无 token / 坏 token / 错 ROOT_SECRET)
 *   2. 越权读他人 user (token A 读不到 user B 的词)
 *   3. 正常推拉 (首台 ROOT_SECRET 换 token → 推送 → 增量拉取)
 * 输出真实请求/响应, 机械可核对。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { createFileKv } from '../src/storage.js';
import worker from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'aidulc-sync-test-'));
const env = { ROOT_SECRET: 'test-secret-123', KV_DIR: dir };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const req = new Request('http://test.local' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(req, env);
}

// 从结果里取 JSON body
async function j(res) { return await res.json(); }

console.log('== V5 服务端协议本地实测 (文件 KV) ==');

// ---- 场景 1: 鉴权失败 ----
console.log('== 1. 鉴权失败 ==');
{
  let res = await call('GET', '/v1/sync?since=0');
  check('无 token 拉取 → 401', res.status === 401);
  let d = await j(res);
  check('401 响应含 error', !!d.error && d.ok === false);

  res = await call('GET', '/v1/sync?since=0', { token: 'bad-token' });
  check('坏 token 拉取 → 401', res.status === 401);

  res = await call('POST', '/v1/auth/device', { body: { root_secret: 'wrong' } });
  check('错 ROOT_SECRET → 403', res.status === 403);

  res = await call('POST', '/v1/auth/device', { body: { code: '123' } });
  check('非 6 位码 → 400', res.status === 400);

  res = await call('POST', '/v1/auth/device', { body: { code: '000000' } });
  check('不存在的码 → 404', res.status === 404);
}

// ---- 场景 2: 首台换 token + 正常推拉 ----
console.log('== 2. 首台 ROOT_SECRET 换 token ==');
let tokenMe;
{
  const res = await call('POST', '/v1/auth/device', {
    body: { root_secret: 'test-secret-123', device_name: '主电脑' },
  });
  check('首台兑换 → 200', res.status === 200);
  const d = await j(res);
  check('返回 user_id=me', d.ok && d.user_id === 'me', d);
  check('返回 user_name=我', d.user_name === '我');
  check('返回 token 与 device_id', !!d.token && !!d.device_id);
  tokenMe = d.token;

  // 重复兑换 (幂等: 只加设备, user 不变)
  const res2 = await call('POST', '/v1/auth/device', {
    body: { root_secret: 'test-secret-123', device_name: '主电脑2' },
  });
  const d2 = await j(res2);
  check('重复 ROOT_SECRET 兑换 → 新 token 同 user', d2.ok && d2.user_id === 'me' && d2.token !== tokenMe, d2);
}

console.log('== 3. 推送 → 增量拉取 ==');
{
  const now = Date.now();
  const words = {
    bank: { word: 'bank', meaning: '银行', context: 'He went to the bank.', stage: 'new', updated_at: now - 5000 },
    reticent: { word: 'reticent', meaning: '沉默寡言的', context: 'He was reticent.', stage: 'review', interval_ms: 86400000 * 3, updated_at: now - 3000 },
  };
  const pushRes = await call('POST', '/v1/sync', { token: tokenMe, body: { words } });
  check('推送 → 200', pushRes.status === 200);
  const pd = await j(pushRes);
  check('推送返回 rev>0', pd.ok && pd.rev > 0, pd);
  check('推送 wrote=2', pd.wrote === 2, pd);

  const pullRes = await call('GET', '/v1/sync?since=0', { token: tokenMe });
  check('全量拉取 → 200', pullRes.status === 200);
  const d = await j(pullRes);
  check('changed 含 2 词', d.ok && d.changed.length === 2, d.changed.length);
  check('rev 与推送一致', d.rev === pd.rev);
  const bank = d.changed.find((x) => x.word === 'bank');
  check('词条带来源单句', bank && bank.context === 'He went to the bank.', bank);
  check('词条带 stage', bank && bank.stage === 'new');

  // 增量: since=推送后 rev → 无变更
  const incRes = await call('GET', '/v1/sync?since=' + pd.rev, { token: tokenMe });
  const inc = await j(incRes);
  check('增量拉取 changed=0', inc.ok && inc.changed.length === 0, inc.changed.length);

  // 再推一个词, 增量应只返回新词
  await call('POST', '/v1/sync', { token: tokenMe, body: { words: { languid: { word: 'languid', meaning: '倦怠的', updated_at: Date.now() } } } });
  const inc2Res = await call('GET', '/v1/sync?since=' + pd.rev, { token: tokenMe });
  const inc2 = await j(inc2Res);
  check('增量拉取只返回新增词', inc2.ok && inc2.changed.length === 1 && inc2.changed[0].word === 'languid', inc2.changed.map((x) => x.word));
}

console.log('== 4. 新者胜 (updated_at 冲突) ==');
{
  // 本地已推 updated_at=200 的 fresh 词
  await call('POST', '/v1/sync', { token: tokenMe, body: { words: { fresh: { word: 'fresh', meaning: '新值', updated_at: 200 } } } });
  // 远端更旧 (updated_at=50) 的 fresh → 不覆盖
  const pushRes = await call('POST', '/v1/sync', { token: tokenMe, body: { words: { fresh: { word: 'fresh', meaning: '旧值', updated_at: 50 } } } });
  const pd = await j(pushRes);
  const pullRes = await call('GET', '/v1/sync?since=0', { token: tokenMe });
  const d = await j(pullRes);
  const fresh = d.changed.find((x) => x.word === 'fresh');
  check('远端旧值不覆盖新值', fresh && fresh.meaning === '新值', fresh && fresh.meaning);
  // 但更旧值不会 push (wrote=0)
  check('冲突旧值 wrote=0', pd.wrote === 0, pd);
}

console.log('== 5. 越权读他人 user ==');
{
  // 新开一个 user (invite-user 码): 需要已登录 token 生成码
  const codeRes = await call('POST', '/v1/auth/code', {
    token: tokenMe, body: { type: 'invite-user', name: '孩子' },
  });
  const cd = await j(codeRes);
  check('生成 invite-user 码', cd.ok && /^\d{6}$/.test(cd.code), cd);
  const code = cd.code;

  const kidRes = await call('POST', '/v1/auth/device', { body: { code, device_name: '孩子手机' } });
  const kid = await j(kidRes);
  check('孩子换 token 成功且 user_id≠me', kid.ok && kid.user_id !== 'me', kid);
  const tokenKid = kid.token;

  // 孩子推一个词
  await call('POST', '/v1/sync', { token: tokenKid, body: { words: { kids: { word: 'kids', meaning: '孩子的词', updated_at: Date.now() } } } });

  // 用 me 的 token 拉 → 拿不到孩子的词 (deck 按 user 隔离)
  const mePull = await call('GET', '/v1/sync?since=0', { token: tokenMe });
  const md = await j(mePull);
  check('me 看不到孩子的词', md.ok && !md.changed.some((x) => x.word === 'kids'), md.changed.map((x) => x.word));

  const kidPull = await call('GET', '/v1/sync?since=0', { token: tokenKid });
  const kd = await j(kidPull);
  check('孩子自己能看到自己的词', kd.ok && kd.changed.some((x) => x.word === 'kids'), kd.changed.map((x) => x.word));
}

console.log('== 6. 6 位码一次性 + 限速 ==');
{
  const codeRes = await call('POST', '/v1/auth/code', {
    token: tokenMe, body: { type: 'add-device' },
  });
  const cd = await j(codeRes);
  const code = cd.code;
  const r1 = await call('POST', '/v1/auth/device', { body: { code, device_name: 'pad' } });
  check('add-device 码可换 token', r1.status === 200);
  const r2 = await call('POST', '/v1/auth/device', { body: { code, device_name: 'pad2' } });
  check('码一次性: 二次使用被拒', r2.status === 410, r2.status);
  // 复用 code 变量测限速 (用一个不存在但格式合法的码错 5 次)
  const badCode = '999999';
  let locked = false;
  for (let i = 0; i < 6; i++) {
    const rr = await call('POST', '/v1/auth/device', { body: { code: badCode } });
    if (rr.status === 429) locked = true;
  }
  check('5 次错误后锁 (429)', locked === true);
}

console.log('== 7. 踢 token (P0-C: 手机配对收回) ==');
{
  // 未登录不能踢
  let res = await call('POST', '/v1/auth/revoke', { body: { token: 'x' } });
  check('无 token 踢 → 401', res.status === 401);

  // 不能踢自己正在用的 token
  res = await call('POST', '/v1/auth/revoke', { token: tokenMe, body: { token: tokenMe } });
  check('踢自己 → 400', res.status === 400);

  // 为 me 再换一个 device token (模拟"手机"配对拿到的 token)
  const extra = await j(await call('POST', '/v1/auth/device', {
    body: { root_secret: 'test-secret-123', device_name: '手机' },
  }));
  check('多设备 token 可用', !!extra.token);

  // 踢掉"手机"token → revoked:true
  res = await call('POST', '/v1/auth/revoke', { token: tokenMe, body: { token: extra.token } });
  const rv = await j(res);
  check('踢掉同 user 的 token → revoked:true', rv.ok && rv.revoked === true, rv);

  // 被踢 token 再拉取 → 401 (删 auth:{token} 即失效)
  res = await call('GET', '/v1/sync?since=0', { token: extra.token });
  check('被踢 token 已失效 (401)', res.status === 401);

  // 幂等: 再踢一次不存在/已失效的 token → revoked:false 不报错
  res = await call('POST', '/v1/auth/revoke', { token: tokenMe, body: { token: extra.token } });
  const rv2 = await j(res);
  check('重复踢已失效 token → revoked:false 且 ok', rv2.ok && rv2.revoked === false, rv2);

  // 跨 user 不能踢 (孩子 token 踢不掉 me 的 token)
  res = await call('POST', '/v1/auth/code', {
    token: tokenMe, body: { type: 'invite-user', name: '另一个' },
  });
  const cd = await j(res);
  const other = await j(await call('POST', '/v1/auth/device', { body: { code: cd.code, device_name: 'other' } }));
  const cross = await call('POST', '/v1/auth/revoke', { token: other.token, body: { token: tokenMe } });
  const crossD = await j(cross);
  check('跨 user 踢不掉 → revoked:false (me 的 token 仍有效)', crossD.ok && crossD.revoked === false, crossD);
  const stillOk = await call('GET', '/v1/sync?since=0', { token: tokenMe });
  check('me 的 token 仍有效 (200)', stillOk.status === 200);
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
