/**
 * sw.js 鈥斺€?Service Worker 缂撳瓨澹?(V7, P0 鏇存柊鏈哄埗淇 2026-08-10)
 *
 * 鏇存柊鏈哄埗 (P0 淇):
 *   - BUILD_VERSION 鏄瓧闈㈤噺鍐欏湪杩欓噷 鈥斺€?SW 鏇存柊妫€鏌ュ彧姣斿 sw.js 鑷韩鐨勫瓧鑺?
 *     鐗堟湰蹇呴』宓屽叆 sw.js 鎵嶄細鍦ㄦ瘡娆″彂甯冩椂瀛楄妭鍙樺寲 鈫?瑙﹀彂 install 鈫?鎹㈢紦瀛樸€? *   - 鍙戝竷鏃?bump 姝ゅ€?(scripts/deploy_mobile.ps1 鏍￠獙骞跺己鍒?; 涓?build-info.js 涓€鑷淬€? *   - 瀵艰埅/HTML 璇锋眰 network-first (鎷挎渶鏂板３), 澶辫触鍥為€€缂撳瓨;
 *     闈欐€佽祫婧?stale-while-revalidate (鍏堢敤缂撳瓨绉掑紑, 鍚庡彴鎷夋柊)銆? *   - activate 娓呮帀鎵€鏈夋棫鐗堟湰缂撳瓨銆? * 璇嶆潯鏁版嵁鍦?IndexedDB (adapter), 涓?SW 缂撳瓨姝ｄ氦銆? */
'use strict';

const BUILD_VERSION = '0.7.0-3';
const CACHE = 'aidulc-mobile-' + BUILD_VERSION;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './adapter.js',
  './app-logic.js',
  './app.js',
  './build-info.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 璺ㄥ煙 (worker API) / 闈?GET 涓嶆嫤鎴?  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  const isNavigation = e.request.mode === 'navigate';

  if (isNavigation) {
    // network-first: 鎷挎渶鏂?HTML, 澶辫触鍥為€€缂撳瓨 (绂荤嚎鍙敤)
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // stale-while-revalidate: 缂撳瓨绉掑紑, 鍚庡彴鎷夋柊
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
