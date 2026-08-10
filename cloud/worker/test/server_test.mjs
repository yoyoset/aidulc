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
} catch (e) {
  check('server.mjs 冒烟整体', false, String(e && e.message));
} finally {
  await stop();
  rmSync(kvDir, { recursive: true, force: true });
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
