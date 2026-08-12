/**
 * test/browser_adapter_test.mjs —— browserAdapter 真 IndexedDB 测试 (M0, 2026-08-12)
 *
 * 背景: 发货的 browserAdapter 此前零测试覆盖 —— app_test.mjs 全用 nodeAdapter
 * (纯内存), 而 browserAdapter 的 tx/getAll/getMeta 在请求未完成时同步读
 * req.result → InvalidStateError, 手机端从上线起所有读取一律失败, 显示 0。
 *
 * 本条用 fake-indexeddb 跑与 app_test.mjs 相同的核心链路 (存词→读回→getToken→
 * sync 全链路), 锁死"读取必须等 IDBRequest 完成"这一修复, 不允许再出现
 * "被测实现 ≠ 发货实现"。
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// 每段用例用全新的 FDBFactory, 段间零污染 (fake-indexeddb 单例在进程内共享,
// 不隔离会造成上一段的数据漏进下一段)
function freshIdb() {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
}
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileKv } from '../../worker/src/storage.js';
import worker from '../../worker/src/index.js';
import { makeAppLogic } from '../app-logic.js';
import { browserAdapter } from '../adapter.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

// fake-indexeddb 在同一进程内是单例 —— 每段用例前换一个全新 factory, 避免段间污染;
// 不在此 reopen (空 upgrade 会建出无 store 的空库), 由 adapter 的 openDb 自带
// onupgradeneeded 重建。
async function wipeDb() {
  freshIdb();
}

console.log('== browserAdapter (fake-indexeddb, 真 IndexedDB 语义) ==');

// 1. 基础读写: 存词→读回 / token / meta —— 这就是曾经每读必抛 InvalidStateError 的路径
await wipeDb();
{
  const adapter = browserAdapter();
  await adapter.storage.init();
  const now = Date.now();
  const w = { word: 'bank', lemma: 'bank', meaning: '银行', stage: 'new', updated_at: now };
  await adapter.storage.putWord(w);
  const words = await adapter.storage.getWords();
  check('存词→读回 1 条', words.length === 1 && words[0].lemma === 'bank', words);

  await adapter.storage.setToken('tok-abc');
  check('getToken 读回', (await adapter.storage.getToken()) === 'tok-abc');
  await adapter.storage.setWorkerUrl('http://test.local');
  check('getWorkerUrl 读回', (await adapter.storage.getWorkerUrl()) === 'http://test.local');
  await adapter.storage.setDeviceName('手机');
  check('getDeviceName 读回', (await adapter.storage.getDeviceName()) === '手机');
  await adapter.storage.setMeta('last_rev', 42);
  check('getMetaValue 读回', (await adapter.storage.getMetaValue('last_rev')) === 42);

  await adapter.storage.pushPending(w);
  check('getPending 读回', (await adapter.storage.getPending()).length === 1);
  await adapter.storage.clearPending();
  check('clearPending 后读回 0', (await adapter.storage.getPending()).length === 0);

  await adapter.storage.setWords([w, { lemma: 'languid', word: 'languid', stage: 'new', updated_at: now }]);
  const two = await adapter.storage.getWords();
  check('setWords 批量写回读回 2 条', two.length === 2, two.map((x) => x.lemma));
}

// 2. 全链路: 本地先写 → 断网同步失败但本地不丢 → 恢复网络 (本地 worker) 推拉成功
await wipeDb();
{
  const dir = mkdtempSync(join(tmpdir(), 'aidulc-idb-sync-'));
  const env = { ROOT_SECRET: 'mobile-secret', KV_DIR: dir };
  const localFetch = async (url, init = {}) => {
    return worker.fetch(new Request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? init.body : undefined,
    }), env);
  };
  globalThis.fetch = localFetch;

  const adapter = browserAdapter();
  const app = makeAppLogic(adapter);
  await app.init();
  const auth = await app.authDevice({ workerUrl: 'http://test.local', rootSecret: 'mobile-secret', deviceName: '手机' });
  check('ROOT_SECRET 换 token (IndexedDB 路径)', auth.ok && auth.token && auth.user_id === 'me', auth);

  const now = Date.now();
  const bank = { word: 'bank', lemma: 'bank', meaning: '银行', stage: 'new', updated_at: now };
  await app.saveLocal(bank);
  check('本地先写 (IndexedDB): 生词本 1 条', (await app.loadWords()).length === 1);
  check('待推队列 1 条', (await adapter.storage.getPending()).length === 1);

  const offlineAdapter = browserAdapter();
  const offlineApp = makeAppLogic(offlineAdapter);
  await offlineApp.init();
  await offlineApp.adapter.storage.setToken('t');
  await offlineApp.adapter.storage.setWorkerUrl('http://test.local');
  globalThis.fetch = async () => { throw new Error('offline'); };
  await offlineApp.saveLocal({ word: 'languid', lemma: 'languid', meaning: '倦怠的', stage: 'new', updated_at: now });
  const off = await offlineApp.sync();
  check('断网同步失败但本地不丢', off && off.offline === true && (await offlineApp.loadWords()).some((w) => w.lemma === 'languid'), off);

  globalThis.fetch = localFetch;
  const restored = browserAdapter();
  const restoredApp = makeAppLogic(restored);
  await restoredApp.init();
  await restoredApp.adapter.storage.setToken(auth.token);
  await restoredApp.adapter.storage.setWorkerUrl('http://test.local');
  await restoredApp.saveLocal(bank);
  await restoredApp.saveLocal({ word: 'languid', lemma: 'languid', meaning: '倦怠的', stage: 'new', updated_at: now });
  const syncRes = await restoredApp.sync();
  check('恢复网络同步成功', syncRes.ok === true, syncRes);
  check('待推队列清空', (await restoredApp.adapter.storage.getPending()).length === 0);
  check('本地 2 条', (await restoredApp.loadWords()).length === 2);
  check('同步诊断: last_rev 已记录', (await restoredApp.adapter.storage.getMetaValue('last_rev')) != null);

  const deckRes = await localFetch('http://test.local/v1/sync?since=0', { headers: { Authorization: 'Bearer ' + auth.token } });
  const deck = await deckRes.json();
  check('远端条数对上 (2)', deck.ok && deck.changed.length === 2, deck.changed && deck.changed.length);

  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
