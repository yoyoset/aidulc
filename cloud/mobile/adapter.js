/**
 * adapter.js —— 平台适配层 (V7, 2026-08-09)
 * 手机 Web 端不依赖 window.__TAURI__; 存储/网络/时间走这一层 adapter。
 * 将来套壳 apk/iOS 只换 adapter 实现, app 逻辑不动。
 *
 * 接口:
 *   storage: { init(), getWords(), putWord(word), getPending(), pushPending(word), clearPending(), getToken(), setToken() }
 *   net:     { authDevice({url, rootSecret, code, deviceName}), makeCode({url, token, type, name}),
 *              syncPush({url, token, words}), syncPull({url, token, since}) }
 *   clock:   { now() }
 */
'use strict';

// ---------- 浏览器实现 (IndexedDB + fetch) ----------
function browserAdapter() {
  // IndexedDB 封装: 库 aidulc-mobile, 表 words / pending / meta
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      const req = indexedDB.open('aidulc-mobile', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'lemma' });
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'lemma' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function tx(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      const out = fn(os);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  function getAll(store) {
    return tx(store, 'readonly', (os) => {
      const r = os.getAll();
      return r.result;
    });
  }
  function putOne(store, value) {
    return tx(store, 'readwrite', (os) => { os.put(value); });
  }
  function clearStore(store) {
    return tx(store, 'readwrite', (os) => { os.clear(); });
  }
  async function getMeta(key) {
    const rows = await tx('meta', 'readonly', (os) => { const r = os.get(key); return r.result; });
    return rows || null;
  }

  const storage = {
    async init() { await openDb(); },
    async getWords() {
      const rows = await getAll('words');
      return rows || [];
    },
    async putWord(word) { await putOne('words', word); },
    async setWords(words) {
      await tx('words', 'readwrite', (os) => {
        os.clear();
        (words || []).forEach((w) => os.put(w));
      });
    },
    async getPending() {
      const rows = await getAll('pending');
      return rows || [];
    },
    async pushPending(word) { await putOne('pending', word); },
    async clearPending() { await clearStore('pending'); },
    async getToken() {
      const m = await getMeta('token');
      return m ? m.value : null;
    },
    async setToken(token) { await putOne('meta', { key: 'token', value: token }); },
    async getWorkerUrl() {
      const m = await getMeta('worker_url');
      return m ? m.value : null;
    },
    async setWorkerUrl(url) { await putOne('meta', { key: 'worker_url', value: url }); },
    async getDeviceName() {
      const m = await getMeta('device_name');
      return m ? m.value : null;
    },
    async setDeviceName(name) { await putOne('meta', { key: 'device_name', value: name }); },
  };

  const net = {
    async authDevice({ url, rootSecret, code, deviceName }) {
      const res = await retryFetch(() => fetch(url + '/v1/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_secret: rootSecret || undefined, code: code || undefined, device_name: deviceName }),
      }));
      return res.json();
    },
    async makeCode({ url, token, type, name }) {
      const res = await retryFetch(() => fetch(url + '/v1/auth/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ type, name: name || undefined }),
      }));
      return res.json();
    },
    async syncPush({ url, token, words }) {
      const res = await retryFetch(() => fetch(url + '/v1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ words }),
      }));
      return res.json();
    },
    async syncPull({ url, token, since }) {
      const res = await retryFetch(() => fetch(url + '/v1/sync?since=' + (since || 0), {
        headers: { Authorization: 'Bearer ' + token },
      }));
      return res.json();
    },
  };

  return { storage, net, clock: { now: () => Date.now() }, name: 'browser' };
}

/** 指数退避重试 (与桌面 Rust 客户端同策略: 3 次) */
function retryFetch(fn) {
  let last;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fn().then(resolve).catch((e) => {
        last = e;
        if (n < 3) setTimeout(() => attempt(n + 1), Math.pow(2, n) * 1000);
        else reject(e);
      });
    };
    attempt(0);
  });
}

// ---------- Node 测试实现 (内存 + fetch 直连; 可注入) ----------
function nodeAdapter({ fetchImpl, inMemory = true } = {}) {
  const mem = { words: {}, pending: {}, meta: {} };
  const storage = {
    async init() {},
    async getWords() { return Object.values(mem.words); },
    async putWord(word) { mem.words[word.lemma] = word; },
    async setWords(words) { mem.words = {}; (words || []).forEach((w) => { mem.words[w.lemma] = w; }); },
    async getPending() { return Object.values(mem.pending); },
    async pushPending(word) { mem.pending[word.lemma] = word; },
    async clearPending() { mem.pending = {}; },
    async getToken() { return mem.meta.token || null; },
    async setToken(v) { mem.meta.token = v; },
    async getWorkerUrl() { return mem.meta.worker_url || null; },
    async setWorkerUrl(v) { mem.meta.worker_url = v; },
    async getDeviceName() { return mem.meta.device_name || null; },
    async setDeviceName(v) { mem.meta.device_name = v; },
  };
  const net = {
    async authDevice({ url, rootSecret, code, deviceName }) {
      const res = await retryFetch(() => fetchImpl(url + '/v1/auth/device', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_secret: rootSecret || undefined, code: code || undefined, device_name: deviceName }),
      }));
      return res.json();
    },
    async makeCode({ url, token, type, name }) {
      const res = await retryFetch(() => fetchImpl(url + '/v1/auth/code', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ type, name: name || undefined }),
      }));
      return res.json();
    },
    async syncPush({ url, token, words }) {
      const res = await retryFetch(() => fetchImpl(url + '/v1/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ words }),
      }));
      return res.json();
    },
    async syncPull({ url, token, since }) {
      const res = await retryFetch(() => fetchImpl(url + '/v1/sync?since=' + (since || 0), {
        headers: { Authorization: 'Bearer ' + token },
      }));
      return res.json();
    },
  };
  return { storage, net, clock: { now: () => Date.now() }, name: 'node' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { browserAdapter, nodeAdapter };
}
if (typeof window !== 'undefined') {
  window.AidulcMobileAdapters = { browserAdapter };
}
