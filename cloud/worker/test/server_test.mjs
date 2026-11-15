/**
 * server_test.mjs —— server.mjs (Node HTTP 入口) 冒烟 (S3, 2026-08-10)
 *
 * 验证: server.mjs 把 Node http 请求适配成 Request 交给同一份 worker 业务代码,
 * 业务逻辑 (鉴权/推拉) 走网络层走通 —— 证明"同一份代码两端跑"成立。
 * 进程内启动 (startServer/stop), 不用子进程, 避免 Windows 下 kill 子进程的 libuv 断言。
 *
 * 覆盖:
 *   1. 启动 (ROOT_SECRET 生效, 首台换 token 成功)
 *   2. 无 token 拉取 → 401
 *   3. 推送 → 拉取 → 条数对上
 *   4. capabilities 自述文件存储 (无配额)
 * 输出真实请求/响应, 机械可核对。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { startServer } from '../src/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const kvDir = mkdtempSync(join(tmpdir(), 'aidulc-server-test-'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

// 找空闲端口
function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

console.log('== server.mjs Node HTTP 入口冒烟 ==');

const port = await freePort();
const { stop } = await startServer({
  port,
  kvDir,
  rootSecret: 'server-test-secret',
  log: () => {},
});
const base = 'http://127.0.0.1:' + port;

try {
  // 1. 首台换 token (走真实 HTTP 网络层)
  const authRes = await fetch(base + '/v1/auth/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_secret: 'server-test-secret', device_name: '冒烟' }),
  });
  const auth = await authRes.json();
  check('首台 ROOT_SECRET 换 token → 200', authRes.status === 200 && auth.ok && !!auth.token, auth);
  const token = auth.token;

  // 2. 无 token 拉取 → 401
  const noToken = await fetch(base + '/v1/sync?since=0');
  check('无 token 拉取 → 401', noToken.status === 401);

  // 3. 推送 → 拉取 → 条数对上
  const pushRes = await fetch(base + '/v1/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ words: { bank: { word: 'bank', meaning: '银行', updated_at: Date.now() } } }),
  });
  const push = await pushRes.json();
  check('推送 → 200 + wrote=1', pushRes.status === 200 && push.ok && push.wrote === 1, push);

  const pullRes = await fetch(base + '/v1/sync?since=0', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const pull = await pullRes.json();
  check('拉取 → changed=1', pullRes.status === 200 && pull.ok && pull.changed.length === 1, pull);

  // 4. capabilities 自述文件存储 (无配额)
  const capRes = await fetch(base + '/v1/capabilities');
  const cap = await capRes.json();
  check('capabilities 自述 file + 无配额', cap.ok && cap.storage === 'file' && cap.max_writes_per_day === null, cap);

  // 5. E5: 兑换限流的"来源"由本层按 TCP 对端写, 客户端自报的头一律无效
  const tryCode = (i, extraHeaders) => fetch(base + '/v1/auth/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ code: String(100000 + i * 7919) }),
  }).then((r) => r.status);
  const st = [];
  for (let i = 0; i < 7; i++) {
    // 每次伪造不同的来源头 (含 CF 的 cf-connecting-ip): 不该起作用
    st.push(await tryCode(i, { 'x-aidulc-client-ip': '8.8.8.' + i, 'cf-connecting-ip': '9.9.9.' + i, 'x-forwarded-for': '7.7.7.' + i }));
  }
  check('伪造来源头无法绕过限流: 前 5 次 404, 之后 429', st.slice(0, 5).every((x) => x === 404) && st.slice(5).every((x) => x === 429), st);
} catch (e) {
  check('server.mjs 冒烟整体', false, String(e && e.message));
} finally {
  await stop();
  rmSync(kvDir, { recursive: true, force: true });
}

// 6. E5: 部署在反代后面 (trustProxy) 时按 X-Forwarded-For 的**最后一项**计来源 (前面的项客户端能写)
{
  const kv2 = mkdtempSync(join(tmpdir(), 'aidulc-server-test2-'));
  const port2 = await freePort();
  const srv2 = await startServer({ port: port2, kvDir: kv2, rootSecret: 's2', trustProxy: true, log: () => {} });
  try {
    const hit = (i, xff) => fetch('http://127.0.0.1:' + port2 + '/v1/auth/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ code: String(200000 + i * 7919) }),
    }).then((r) => r.status);
    const same = [];
    for (let i = 0; i < 7; i++) same.push(await hit(i, 'fake-' + i + ', 6.6.6.6')); // 最后一项相同 = 同一来源
    check('trustProxy: 取 XFF 最后一项, 前面伪造的项不起作用 (同一来源被锁)', same.slice(5).every((x) => x === 429), same);
    const fresh = await hit(50, 'fake, 6.6.6.7'); // 另一个真实来源
    check('trustProxy: 另一个来源不受影响', fresh === 404, fresh);
    // CF Tunnel 模式: 取 CF-Connecting-IP, 忽略客户端自带的 x-forwarded-for
    const srv3 = await startServer({ port: await freePort(), kvDir: kv2, rootSecret: 's2', trustProxy: 'cf', log: () => {} });
    try {
      const p3 = srv3.server.address().port;
      const cfHit = (i, cfip) => fetch('http://127.0.0.1:' + p3 + '/v1/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': cfip, 'x-forwarded-for': 'spoof-' + i },
        body: JSON.stringify({ code: String(400000 + i * 7919) }),
      }).then((r) => r.status);
      const cf = [];
      for (let i = 0; i < 7; i++) cf.push(await cfHit(i, '4.4.4.4'));
      check('TRUST_PROXY=cf: 按 CF-Connecting-IP 计, 同一来源被锁', cf.slice(5).every((x) => x === 429), cf);
      check('TRUST_PROXY=cf: 另一个 CF 来源不受影响', (await cfHit(60, '4.4.4.5')) === 404);
    } finally { await srv3.stop(); }
  } catch (e) {
    check('trustProxy 场景整体', false, String(e && e.message));
  } finally {
    await srv2.stop();
    rmSync(kv2, { recursive: true, force: true });
  }
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
