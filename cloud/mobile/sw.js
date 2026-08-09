/**
 * sw.js —— Service Worker 缓存壳 (V7, 2026-08-09)
 * 缓存应用壳 (html/css/js), 离线可打开复习界面。
 * 词条数据在 IndexedDB (adapter), 与 SW 缓存正交。
 */
'use strict';

const CACHE = 'aidulc-mobile-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './adapter.js',
  './app-logic.js',
  './app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只处理同源 GET; 跨域 (worker API) 不拦截
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
