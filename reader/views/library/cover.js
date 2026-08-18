/**
 * views/library/cover.js —— 书封面渲染 + "最近阅读"横滑区 (K2-2/K2-3, 2026-08-13)
 * 从 library_view.js 拆出 (文件规模门禁: 加入封面/书架后原文件超过登记基线 1063 行,
 * 这块是真正独立的展示逻辑——不碰书 CRUD/导入/处理队列, 符合"真混域才拆"标准)。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** 无封面占位色系 —— 复用 tokens.css 已有的 5 色系 swatch, 书名 hash 出稳定色,
   *  同一本书刷新页面颜色不变(不用灰块, 灰块看着像加载失败)。 */
  const COVER_SWATCHES = ['clay', 'sage', 'ocean', 'rose', 'slate'];
  function _coverSwatch(title) {
    let h = 0;
    const s = String(title || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COVER_SWATCHES[h % COVER_SWATCHES.length];
  }
  /** 书名首字(中文取第一个汉字, 英文取首字母大写)作占位块文字 */
  function _coverInitial(title) {
    const s = String(title || '').trim();
    return s ? s[0].toUpperCase() : '?';
  }

  /** 封面元素: 有 pack_dir+cover_file 就懒加载图片, 失败/无封面回落占位块。
   *
   * 2026-08-18 (用户报"我的书页面显示封面还是很卡"): 原来是**每张卡片建好就立刻**
   * 去 read_image 整文件 base64, 11 张 = 14.6 MB base64 过 IPC, 且没有任何缓存,
   * 每次进页面重来。判据与三条对策见 core/cover_cache.js 的头注释。
   * 这里只负责接线: 懒加载(进视口才取) → 缓存命中直接用 → 未命中才走网络并顺手
   * 生成缩略图存回书包。 */
  function build(title, packDir, coverFile) {
    const cover = el('div', 'book-cover');
    const swatch = _coverSwatch(title);
    const placeholder = el('div', 'book-cover-placeholder', _coverInitial(title));
    placeholder.style.background = `var(--swatch-${swatch})`;
    cover.appendChild(placeholder);
    if (!(packDir && coverFile && global.AiduLibraryService)) return cover;

    const C = global.AiduCoverCache;
    const show = (url) => {
      if (!url || !cover.isConnected) return;
      const img = el('img');
      img.src = url;
      img.alt = title || '';
      img.decoding = 'async';
      // 图真的解码出来再换掉占位块, 避免中间态闪一下空白
      img.onload = () => { cover.innerHTML = ''; cover.appendChild(img); };
    };

    if (!C) {
      // 缓存模块没加载上(冒烟/裁剪环境): 退化成旧的"立即取原图", 至少还能显示,
      // 不要因为一个优化模块缺席就整页没封面
      _loadRaw(packDir, coverFile).then(show);
      return cover;
    }
    const cached = C.get(packDir, coverFile);
    if (cached) { show(cached); return cover; }

    _observe(cover, () => { _load(packDir, coverFile).then(show); });
    return cover;
  }

  /** 进视口才回调一次 (IntersectionObserver 不可用时立即回调, 退化成旧行为) */
  let _io = null;
  const _pendingEls = new WeakMap();
  function _observe(elm, cb) {
    if (typeof IntersectionObserver !== 'function') { cb(); return; }
    if (!_io) {
      _io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          _io.unobserve(en.target);
          const fn = _pendingEls.get(en.target);
          _pendingEls.delete(en.target);
          if (fn) fn();
        });
      }, { rootMargin: '200px' });   // 提前一屏开始取, 滚动时不会看到空格子
    }
    _pendingEls.set(elm, cb);
    _io.observe(elm);
  }

  /** 无缓存模块时的退化路径: 直接取原图, 不缩不缓存 */
  function _loadRaw(packDir, coverFile) {
    return global.AiduLibraryService.readImage(packDir, coverFile).then((r) => {
      const b64 = r && r.ok && r.data && r.data.data_b64;
      if (!b64) return null;
      const ext = String(coverFile).split('.').pop().toLowerCase();
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext]
        || 'image/jpeg';
      return `data:${mime};base64,${b64}`;
    }).catch(() => null);
  }

  /** 取一张封面 → objectURL。优先缩略图; 没有缩略图且原图偏大时顺手生成一张。 */
  function _load(packDir, coverFile) {
    const C = global.AiduCoverCache;
    const S = global.AiduLibraryService;
    const inflight = C.pending(packDir, coverFile);
    if (inflight) return inflight;

    const p = (async () => {
      // 1) 缩略图命中就用它 (几十 KB)
      const t = await S.readImage(packDir, C.THUMB_FILE).catch(() => null);
      if (t && t.ok && t.data && t.data.data_b64) {
        return C.put(packDir, coverFile,
          URL.createObjectURL(C.b64ToBlob(t.data.data_b64, 'image/jpeg')));
      }
      // 2) 回落原图
      const r = await S.readImage(packDir, coverFile).catch(() => null);
      const b64 = r && r.ok && r.data && r.data.data_b64;
      if (!b64) return null;
      const url = URL.createObjectURL(C.b64ToBlob(b64, C.mimeOf(coverFile)));
      const stored = C.put(packDir, coverFile, url);
      // 3) 原图够大才值得缩 —— 失败不影响本次显示 (下次再试)
      if (C.decodedBytes(b64) >= C.THUMB_SKIP_BELOW_BYTES) {
        _makeThumb(packDir, url).catch(() => {});
      }
      return stored;
    })().finally(() => C.clearPending(packDir, coverFile));

    return C.setPending(packDir, coverFile, p);
  }

  /** canvas 缩到 480px 宽 → jpeg → 回传 Rust 存成 cover_thumb.jpg */
  function _makeThumb(packDir, objectUrl) {
    const C = global.AiduCoverCache;
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onerror = reject;
      im.onload = () => {
        const size = C.thumbSize(im.naturalWidth, im.naturalHeight);
        if (!size) { resolve(null); return; }   // 本来就不大, 不折腾
        const cv = document.createElement('canvas');
        cv.width = size.w; cv.height = size.h;
        cv.getContext('2d').drawImage(im, 0, 0, size.w, size.h);
        const dataUrl = cv.toDataURL('image/jpeg', C.THUMB_QUALITY);
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        resolve(global.AiduLibraryService.writeCoverThumb(packDir, b64));
      };
      im.src = objectUrl;
    });
  }

  /** K2-3: "最近阅读"横滑区 —— 苹果书架语汇的克制版本(横向滚动+封面为主, 不做
   *  3D 书架透视: 拟物效果与本项目"暖纸克制"设计语言冲突, 维护成本也高)。
   *  opts: { onOpenBook(book), parseTitle(book) => string } */
  function renderShelf(shelfEl, books, opts) {
    const onOpenBook = (opts && opts.onOpenBook) || null;
    const parseTitle = (opts && opts.parseTitle) || ((b) => b.title || b.id);
    shelfEl.innerHTML = '';
    const recent = (books || [])
      .filter((b) => b.last_opened_at)
      .sort((a, b) => (b.last_opened_at || 0) - (a.last_opened_at || 0))
      .slice(0, 12);
    if (!recent.length) { shelfEl.classList.add('hidden'); return; }
    shelfEl.classList.remove('hidden');
    shelfEl.appendChild(el('div', 'library-shelf-title', '最近阅读'));
    const track = el('div', 'library-shelf-track');
    recent.forEach((book) => {
      const title = parseTitle(book);
      const cardEl = el('div', 'shelf-card');
      cardEl.appendChild(build(title, book.pack_dir, book.cover_file));
      cardEl.appendChild(el('div', 'shelf-card-title', title));
      const canOpen = book.status === 'ready' || book.status === 'partial';
      if (canOpen) {
        cardEl.onclick = () => onOpenBook && onOpenBook(book);
      } else {
        cardEl.classList.add('shelf-card-disabled');
      }
      track.appendChild(cardEl);
    });
    shelfEl.appendChild(track);
  }

  global.AiduLibraryCover = { build, renderShelf };
})(window);
