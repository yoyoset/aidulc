/**
 * views/reader/bookmarks.js —— 书签集合 + 面板 + 持久化回调 (R2 拆分自 reader_view.js)
 * 单一职责: 持有句下标集合; 切换某句书签; 渲染书签抽屉面板; 变更时通知外部保存。
 * 不碰音频/渲染, 通过构造时传入的 onSave / onPlay / getSentences 与宿主协作。
 */
(function (global) {
  'use strict';

  class BookmarkPanel {
    /**
     * @param {object} deps
     *   onSave(): 书签集合变化时调用 (宿主落盘)
     *   onPlay(index): 面板里点书签行 → 跳转播放
     *   getSentences(): () => Sentence[] 当前章句子 (面板显示原文预览)
     */
    constructor(deps) {
      this.bookmarks = new Set(); // 句下标
      this.onSave = deps.onSave || (() => {});
      this.onPlay = deps.onPlay || (() => {});
      this.getSentences = deps.getSentences || (() => []);
    }

    /** 恢复集合 (从阅读状态加载); highlight 由宿主根据 renderer 做 */
    restore(indices) {
      this.bookmarks = new Set(Array.isArray(indices) ? indices : []);
    }

    /** 切换某句的书签状态, 并同步 DOM 高亮 (句块可能还没渲染, 查到就改查不到跳过) */
    toggle(index) {
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (this.bookmarks.has(index)) {
        this.bookmarks.delete(index);
        if (block) block.classList.remove('bookmark-active');
      } else {
        this.bookmarks.add(index);
        if (block) block.classList.add('bookmark-active');
      }
      this.onSave();
    }

    /** 删除某句书签 (面板行内删除用) */
    remove(index) {
      this.bookmarks.delete(index);
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (block) block.classList.remove('bookmark-active');
      this.onSave();
    }

    /** 渲染书签抽屉面板 (重复调用 = 关闭) */
    showPanel() {
      const existing = document.getElementById('bookmarks-panel');
      if (existing) { existing.remove(); return; }
      const panel = document.createElement('div');
      panel.id = 'bookmarks-panel';
      panel.className = 'bookmarks-panel';
      const header = document.createElement('div');
      header.className = 'bookmarks-header';
      const title = document.createElement('span');
      title.textContent = '书签 (' + this.bookmarks.size + ')';
      const close = document.createElement('button');
      close.className = 'btn-small';
      close.textContent = '✕';
      close.onclick = () => panel.remove();
      header.append(title, close);
      const list = document.createElement('div');
      list.className = 'bookmarks-list';
      panel.append(header, list);
      document.body.appendChild(panel);

      const sentences = this.getSentences();
      const idxs = Array.from(this.bookmarks).sort((a, b) => a - b);
      if (!idxs.length) {
        list.appendChild(this._makeRow('暂无书签。播放时点"🔖 当前句书签"。', null));
      }
      idxs.forEach(i => {
        const s = sentences[i];
        const text = s ? s.original_text.slice(0, 60) : '句 ' + i;
        const row = this._makeRow(text, i);
        if (s) {
          row.onclick = () => { this.onPlay(i); panel.remove(); };
        }
        list.appendChild(row);
      });
    }

    _makeRow(text, index) {
      const row = document.createElement('div');
      row.className = 'bookmarks-row';
      const t = document.createElement('span');
      t.textContent = text;
      t.className = 'bookmarks-text';
      row.appendChild(t);
      if (index != null) {
        const del = document.createElement('button');
        del.className = 'btn-small';
        del.textContent = '删除';
        del.onclick = (e) => {
          e.stopPropagation();
          this.remove(index);
          this.showPanel();
        };
        row.appendChild(del);
      }
      return row;
    }
  }

  global.BookmarkPanel = BookmarkPanel;
})(window);
