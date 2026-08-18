/**
 * core/cover_cache.js —— 封面加载策略 (纯逻辑, 零 DOM)
 *
 * 2026-08-18, 用户报"我的书页面显示封面还是很卡"后实测出来的账:
 *
 *   库里 11 张封面合计 **10.95 MB**, 全是原始尺寸原样落盘的 ——
 *   Because of Winn-Dixie 是 1742x2284 的 PNG、**8.95 MB**, 而卡片上它只占一个
 *   aspect-ratio 2/3 的小格子。read_image 是整文件 base64 过 IPC,
 *   11 张 = **14.6 MB base64** 走 JSON 序列化, 每次进"我的书"都从头来一遍。
 *
 * 拆开看各项成本(实测): 读盘 + base64 只有 **66 ms**, 所以瓶颈不在磁盘 ——
 * 在 (a) IPC 把 11.9 MB 的 base64 字符串做 JSON 编解码, (b) 浏览器解一张
 * 400 万像素的 PNG 再缩到缩略图大小, (c) 没有任何缓存, 每次导航重来。
 *
 * 三条对策, 各自解决上面一项:
 *   1. **缩略图**: 首次加载后用 canvas 缩到 480px 宽存回书包 (cover_thumb.jpg),
 *      之后读的是几十 KB。缩放放在前端是为了不给 Rust 引一整套图像解码依赖。
 *   2. **进程内缓存**: 同一张封面在一次会话里只解一次, 再进页面直接拿 objectURL。
 *   3. **懒加载**: 只有滚进视口的卡片才去取图 (调用方用 IntersectionObserver)。
 *
 * 另外用 Blob URL 而不是 data: URI —— 12 MB 的 data URI 会整个字符串挂在 DOM
 * 属性上, blob: 只挂一个句柄, 且能 revoke 掉释放内存 (CSP 里 img-src 已允许 blob:)。
 */
(function (global) {
  'use strict';

  var THUMB_FILE = 'cover_thumb.jpg';
  var THUMB_MAX_W = 480;      // 卡片实际显示宽度的 2 倍上下, 够高分屏用
  var THUMB_QUALITY = 0.82;
  // 小于这个尺寸的原图不值得再生成缩略图: 省下来的传输还不够一次 canvas 编码
  var THUMB_SKIP_BELOW_BYTES = 80 * 1024;

  var cache = new Map();      // key -> objectURL
  var inflight = new Map();   // key -> Promise<objectURL|null>

  function key(packDir, file) { return String(packDir || '') + '|' + String(file || ''); }

  function mimeOf(file) {
    var ext = String(file || '').split('.').pop().toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext]
      || 'image/jpeg';
  }

  /** base64 → Blob (不经过 data: URI, 避免超大字符串挂在 DOM 上) */
  function b64ToBlob(b64, mime) {
    var bin = atob(b64);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  /** 估算 base64 解码后的字节数 (不真的解码, 只为决定要不要生成缩略图) */
  function decodedBytes(b64) {
    var s = String(b64 || '');
    if (!s) return 0;
    var pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
    return Math.floor(s.length * 3 / 4) - pad;
  }

  /** 目标缩放尺寸: 宽超过 THUMB_MAX_W 才缩, 等比。返回 null 表示不需要缩。 */
  function thumbSize(w, h) {
    if (!w || !h || w <= THUMB_MAX_W) return null;
    return { w: THUMB_MAX_W, h: Math.max(1, Math.round(h * THUMB_MAX_W / w)) };
  }

  function get(packDir, file) { return cache.get(key(packDir, file)) || null; }
  function put(packDir, file, url) { cache.set(key(packDir, file), url); return url; }
  function has(packDir, file) { return cache.has(key(packDir, file)); }
  function pending(packDir, file) { return inflight.get(key(packDir, file)) || null; }
  function setPending(packDir, file, p) { inflight.set(key(packDir, file), p); return p; }
  function clearPending(packDir, file) { inflight.delete(key(packDir, file)); }

  /** 会话结束/切库时释放, 避免 objectURL 泄漏 */
  function clear() {
    cache.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) { /* 已释放, 忽略 */ }
    });
    cache.clear();
    inflight.clear();
  }

  global.AiduCoverCache = {
    THUMB_FILE: THUMB_FILE,
    THUMB_MAX_W: THUMB_MAX_W,
    THUMB_QUALITY: THUMB_QUALITY,
    THUMB_SKIP_BELOW_BYTES: THUMB_SKIP_BELOW_BYTES,
    key: key,
    mimeOf: mimeOf,
    b64ToBlob: b64ToBlob,
    decodedBytes: decodedBytes,
    thumbSize: thumbSize,
    get: get, put: put, has: has,
    pending: pending, setPending: setPending, clearPending: clearPending,
    clear: clear,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
