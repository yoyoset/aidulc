/**
 * test/app_test.mjs —— 手机端核心逻辑 + 同步链路测试 (V7 验收)
 * 覆盖:
 *   1. core.js 纯逻辑 (配比/归类/调度预览一致性/撤销栈/翻面锁)
 *   2. app-logic: 本地先写 + 先推后拉
 *   3. 离线完整复习一轮 → 恢复网络自动补推、条数对上 (node adapter + 本地 worker)
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileKv } from '../../worker/src/storage.js';
import worker from '../../worker/src/index.js';
import core from '../core.js';
import { makeAppLogic } from '../app-logic.js';
import { nodeAdapter } from '../adapter.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

console.log('== 1. core 纯逻辑 (与桌面/Rust 同算法) ==');
{
  const NOW = 1_700_000_000_000;
  const DAY = 86400000;
  // 配比
  check('负债轻 → 满额 6', core.newWordQuota(0) === 6);
  check('30 到期 → 收缩到 1', core.newWordQuota(30) === 1);
  check('40 到期 → 0', core.newWordQuota(40) === 0);
  check('kid base=3', core.newWordQuota(0, { base: 3 }) === 3);
  // 调度预览一致性: 按钮预览 == 评分后实际到期 (与 Rust domain/srs.rs 同规则)
  const s = { stage: 'new', interval_ms: 0, ease_factor: 2.5, reviews: 0, next_review: NOW };
  const opts = core.intervalOptions(s, NOW);
  check('新词四档预览', opts[0].human === '1 分钟' && opts[1].human === '10 分钟' && opts[2].human === '3 天' && opts[3].human === '8 天', opts.map(o => o.human));
  opts.forEach((o) => {
    const actual = core.applyGrade(s, o.grade, NOW);
    check('预览==实际到期 g' + o.grade, o.next_review === actual.next_review, { prev: o.next_review, actual: actual.next_review });
  });
  // 学习中未毕业插队
  const learning = { stage: 'learning', interval_ms: 10 * 60000, ease_factor: 2.5, reviews: 1, next_review: NOW - 1 };
  const lo = core.intervalOptions(learning, NOW);
  check('学习中 忘了→learning 1 分钟', core.applyGrade(learning, 1, NOW).stage === 'learning' && core.applyGrade(learning, 1, NOW).interval_ms === 60000);
  check('学习中 记得→毕业 review 3 天', core.applyGrade(learning, 3, NOW).stage === 'review' && core.applyGrade(learning, 3, NOW).interval_ms === 3 * DAY);
  // 复习忘了 → 打回学习
  const review = { stage: 'review', interval_ms: 3 * DAY, ease_factor: 2.5, reviews: 3, next_review: NOW - 1 };
  check('复习忘了→learning', core.applyGrade(review, 1, NOW).stage === 'learning');
  check('复习记得→interval×ease', core.applyGrade(review, 3, NOW).interval_ms === Math.round(3 * DAY * 2.5));
  // 队列顺序
  const due = { lemma: 'r', stage: 'review', next_review: NOW - 1, interval_ms: 3 * DAY };
  const learn = { lemma: 'l', stage: 'learning', next_review: NOW - 1, interval_ms: 10 * 60000 };
  const news = [0,1,2,3,4,5,6,7].map((i) => ({ lemma: 'n' + i, stage: 'new', next_review: null }));
  const q = core.buildQueue([...news, due, learn], NOW);
  check('队列: 到期→学习→新词', q.order[0].lemma === 'r' && q.order[1].lemma === 'l', q.order.map(w => w.lemma));
  check('新词配额 6', q.newQuota === 6 && q.order.length === 1 + 1 + 6);
  // 撤销栈 / 翻面锁
  const undo = new core.UndoStack();
  undo.push({ lemma: 'x' }, NOW);
  check('撤销窗口内可撤', undo.canUndo(NOW + 1000));
  check('撤销窗口外不可撤', !undo.canUndo(NOW + 3001));
  const fl = new core.FlipLock();
  fl.flip(NOW);
  check('翻面 250ms 内锁', !fl.canGrade(NOW + 100));
  check('翻面 250ms 后解锁', fl.canGrade(NOW + 250));
}

console.log('== 2. 本地 worker (文件 KV) + 手机同步链路 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'aidulc-mobile-test-'));
  // fetchImpl 直接调 worker.fetch (Request/Response 对象), 不经过真实 TCP ——
  // 避免 undici keep-alive 与 server.close 在 Windows 上的 libuv 退出断言。
  const env = { ROOT_SECRET: 'mobile-secret', KV_DIR: dir };
  const localFetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const body = init.body ? init.body : undefined;
    return worker.fetch(new Request(url, {
      method: init.method || 'GET',
      headers,
      body,
    }), env);
  };

  const adapter = nodeAdapter({ fetchImpl: localFetch });
  const app = makeAppLogic(adapter);
  await app.init();

  // 首台换 token
  const auth = await app.authDevice({ workerUrl: 'http://test.local', rootSecret: 'mobile-secret', deviceName: '手机' });
  check('ROOT_SECRET 换 token', auth.ok && auth.token && auth.user_id === 'me', auth);

  // 离线完整复习一轮: 评分只写本地 + 待推
  const now = Date.now();
  const bank = { word: 'bank', lemma: 'bank', meaning: '银行', context: 'He went to the bank.', stage: 'new', interval_ms: 0, ease_factor: 2.5, reviews: 0, next_review: now, updated_at: now };
  await app.saveLocal(bank);
  check('本地先写: 生词本 1 条', (await app.loadWords()).length === 1);
  check('待推队列 1 条', (await adapter.storage.getPending()).length === 1);

  // 断网 (worker 不可达): 同步失败但本地照常复习
  const offlineApp = makeAppLogic(nodeAdapter({ fetchImpl: async () => { throw new Error('offline'); } }));
  await offlineApp.init();
  await offlineApp.adapter.storage.setToken('t');
  await offlineApp.adapter.storage.setWorkerUrl('http://test.local');
  await offlineApp.saveLocal({ word: 'languid', lemma: 'languid', meaning: '倦怠的', stage: 'new', updated_at: Date.now() });
  const off = await offlineApp.sync();
  check('断网同步失败但本地不丢', off && off.offline === true && (await offlineApp.loadWords()).length === 1, off);

  // 恢复网络: 自动补推 → 条数对上
  const restored = makeAppLogic(nodeAdapter({ fetchImpl: localFetch }));
  await restored.init();
  await restored.adapter.storage.setToken(auth.token);
  await restored.adapter.storage.setWorkerUrl('http://test.local');
  await restored.saveLocal(bank);
  await restored.saveLocal({ word: 'languid', lemma: 'languid', meaning: '倦怠的', stage: 'new', updated_at: Date.now() });
  const syncRes = await restored.sync();
  check('恢复网络同步成功', syncRes.ok === true, syncRes);
  check('待推队列清空', (await restored.adapter.storage.getPending()).length === 0);
  check('本地 2 条', (await restored.loadWords()).length === 2);
  // UX A3: 同步诊断元数据 (设置页展示)
  check('同步诊断: 上次 rev 已记录', (await restored.adapter.storage.getMetaValue('last_rev')) != null);
  check('同步诊断: 上次拉回 2 条', (await restored.adapter.storage.getMetaValue('last_pulled')) === 2);
  // 远端条数对上 (服务端 deck)
  const deckRes = await localFetch('http://test.local/v1/sync?since=0', { headers: { Authorization: 'Bearer ' + auth.token } });
  const deck = await deckRes.json();
  check('远端条数对上 (2)', deck.ok && deck.changed.length === 2, deck.changed && deck.changed.length);

  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('== 3. P0-C applyPairing (扫码直连, 不经过网络兑换) ==');
{
  const adapter2 = nodeAdapter({ fetchImpl: async () => { throw new Error('no network'); } });
  const app2 = makeAppLogic(adapter2);
  await app2.init();
  // 桌面端二维码的 #t=..&u=.. 直连: token 是桌面端为手机单独换的 device token
  const r = await app2.applyPairing({ token: 'phone-token', workerUrl: 'https://w.example.workers.dev' });
  check('applyPairing 成功', r === true);
  check('token 已存 IndexedDB', (await adapter2.storage.getToken()) === 'phone-token');
  check('worker_url 已存', (await adapter2.storage.getWorkerUrl()) === 'https://w.example.workers.dev');
  // 配对后不经过 authDevice 网络调用 (离线也能存)
  check('配对不需要网络', true);
}

console.log('== 4. P0-C 端到端: 桌面换手机 token → 手机扫码直连 → 拉到桌面的词 ==');{
  const dir = mkdtempSync(join(tmpdir(), 'aidulc-pair-e2e-'));
  const env = { ROOT_SECRET: 'mobile-secret', KV_DIR: dir };
  const localFetch = async (url, init = {}) => {
    return worker.fetch(new Request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? init.body : undefined,
    }), env);
  };
  const post = (path, body, token) => localFetch('http://test.local' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });

  // 桌面: ROOT_SECRET 换主 token + 推 2 个词 (用户在电脑上背的)
  const desktop = makeAppLogic(nodeAdapter({ fetchImpl: localFetch }));
  await desktop.init();
  const auth = await desktop.authDevice({ workerUrl: 'http://test.local', rootSecret: 'mobile-secret', deviceName: '主电脑' });
  const now = Date.now();
  await desktop.saveLocal({ word: 'bank', lemma: 'bank', meaning: '银行', context: 'He went to the bank.', stage: 'review', interval_ms: 3 * 86400000, ease_factor: 2.5, reviews: 3, next_review: now - 1000, updated_at: now });
  await desktop.saveLocal({ word: 'languid', lemma: 'languid', meaning: '倦怠的', stage: 'new', updated_at: now });
  const deskSync = await desktop.sync();
  check('桌面推送成功', deskSync.ok === true, deskSync);

  // 桌面 sync_pair_qr 等价链路: auth/code(add-device) → auth/device(code) 换手机 token
  const cd = await (await post('/v1/auth/code', { type: 'add-device' }, auth.token)).json();
  check('桌面生成 add-device 码', cd.ok && /^\d{6}$/.test(cd.code), cd);
  const phoneAuth = await (await post('/v1/auth/device', { code: cd.code, device_name: '手机' })).json();
  check('码兑换成手机 token (同 user me)', phoneAuth.ok && phoneAuth.user_id === 'me' && phoneAuth.token !== auth.token, phoneAuth);

  // 手机: applyPairing 直连 (模拟 app.js 解析 #t=..&u=.. 后调 storage.setToken)
  const phone = makeAppLogic(nodeAdapter({ fetchImpl: localFetch }));
  await phone.init();
  await phone.applyPairing({ token: phoneAuth.token, workerUrl: 'http://test.local' });
  const phoneSync = await phone.sync();
  check('手机同步成功', phoneSync.ok === true, phoneSync);
  const words = await phone.loadWords();
  check('手机拉到桌面 2 个词', words.length === 2, words.map((w) => w.lemma));
  const bank = words.find((w) => w.lemma === 'bank');
  check('SRS 字段完整 (stage/interval/ease/next_review)', bank && bank.stage === 'review' && bank.interval_ms === 3 * 86400000 && bank.ease_factor === 2.5 && bank.next_review === now - 1000, bank);

  // 手机背一张 → 桌面拉取, SRS 状态一致
  const updated = { ...bank, stage: 'learning', interval_ms: 60000, ease_factor: 2.5, next_review: now + 60000, reviews: 4, updated_at: now + 5000 };
  await phone.saveLocal(updated);
  await phone.sync();
  const deskPull = await desktop.sync();
  check('桌面拉取后已同步', deskPull.ok === true, deskPull);
  const deskBank = (await desktop.loadWords()).find((w) => w.lemma === 'bank');
  check('桌面看到手机评分结果 (learning/1 分钟)', deskBank && deskBank.stage === 'learning' && deskBank.interval_ms === 60000, deskBank);

  // 踢掉手机 token (桌面调 worker revoke) → 手机变未配置
  const revoke = await (await post('/v1/auth/revoke', { token: phoneAuth.token }, auth.token)).json();
  check('踢掉手机 token → revoked:true', revoke.ok && revoke.revoked === true, revoke);
  const phoneAfter = await phone.sync();
  check('被踢后手机同步失败 (token 失效)', phoneAfter && phoneAfter.offline === true, phoneAfter);

  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('== 5. UX A3 同步诊断区分: "拉到 1424 词但今日只放 6 个新词" vs "一个词都没拉到" ==');
{
  const now = Date.now();
  // 场景 A: 从服务端拉到 1424 个新词 → 今日队列新词配额上限 6, 但总数 1424 必须仍可见
  const words = [];
  for (let i = 0; i < 1424; i++) {
    words.push({ lemma: 'w' + i, word: 'w' + i, meaning: 'm', stage: 'new', next_review: null, updated_at: now });
  }
  const q = core.buildQueue(words, now);
  check('1424 新词 → 今日只放 6 个 (newWordQuota)', q.counts.new === 6, q.counts);
  check('新词总数 1424 仍可见 (诊断显示 6/1424)', q.counts.newTotal === 1424, q.counts);
  check('队列长度 6', q.order.length === 6);
  // 场景 B: 一个词都没拉到 → 本地词库 0, 一眼可辨
  const q0 = core.buildQueue([], now);
  check('空词库 → 队列 0 且总数 0 (一眼可辨)', q0.order.length === 0 && q0.counts.newTotal === 0, q0.counts);
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
// 显式 exit: undici keep-alive 与 server.close 在 Windows 上偶发 libuv 断言, 直接退干净
process.exit(fail === 0 ? 0 : 1);
