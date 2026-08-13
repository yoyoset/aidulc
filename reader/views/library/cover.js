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

  /** 封面元素: 有 pack_dir+cover_file 就异步拉图片, 失败/无封面回落占位块 */
  function build(title, packDir, coverFile) {
    const cover = el('div', 'book-cover');
    const swatch = _coverSwatch(title);
    const placeholder = el('div', 'book-cover-placeholder', _coverInitial(title));
    placeholder.style.background = `var(--swatch-${swatch})`;
    cover.appendChild(placeholder);
    if (packDir && coverFile && global.AiduLibraryService) {
      global.AiduLibraryService.readImage(packDir, coverFile).then((res) => {
        const b64 = res.ok && res.data && res.data.data_b64;
        if (!b64) return;
        const ext = String(coverFile).split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/jpeg';
        const img = el('img');
        img.src = `data:${mime};base64,${b64}`;
        img.alt = title || '';
        cover.innerHTML = '';
        cover.appendChild(img);
      });
    }
    return cover;
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
