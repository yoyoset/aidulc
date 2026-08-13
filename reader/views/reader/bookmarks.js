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
     *   getChapterIndex(): () => number 当前章下标 (排除, 不在"其它章节"里重复列)
     *   listAllChapters(): () => Promise<{[chapter]: number[]}|null> UX7 #3 全书书签
     *     (接 bookmarks_list 命令; 返回 null 表示取失败, 面板不显示"其它章节"分节)
     *   getChapterTitle(idx): (idx) => string 章名 (面板里跨章行的标签)
     *   onJumpChapter(chapter, index): 点跨章书签行 → 跳章定位
     */
    constructor(deps) {
      this.bookmarks = new Set(); // 句下标
      this.onSave = deps.onSave || (() => {});
      this.onPlay = deps.onPlay || (() => {});
      this.getSentences = deps.getSentences || (() => []);
      this.getChapterIndex = deps.getChapterIndex || (() => 0);
      this.listAllChapters = deps.listAllChapters || (() => Promise.resolve(null));
      this.getChapterTitle = deps.getChapterTitle || ((idx) => '第 ' + (idx + 1) + ' 章');
      this.onJumpChapter = deps.onJumpChapter || (() => {});
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

    /** 渲染书签抽屉面板 (重复调用 = 关闭)。UX7 #3: 额外拉一次全书书签, 列"其它章节"分节。 */
    async showPanel() {
      const existing = document.getElementById('bookmarks-panel');
      if (existing) { existing.remove(); return; }
      const panel = document.createElement('div');
      panel.id = 'bookmarks-panel';
      panel.className = 'bookmarks-panel';
      const header = document.createElement('div');
      header.className = 'bookmarks-header';
      const title = document.createElement('span');
      title.textContent = '本章书签 (' + this.bookmarks.size + ')';
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
        list.appendChild(this._makeRow('本章暂无书签。播放时点"🔖 当前句书签"。', null));
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

      // UX7 #3: 其它章节的书签(跨章遍历), 只给"第 N 章 · 第 i 句"标签, 没有原文预览
      // (要拿其它章原文得再发一次章节内容请求, 面板打开这一下没必要多这个 IPC)。
      const all = await this.listAllChapters();
      if (!all || typeof all !== 'object') return;
      if (!document.body.contains(panel)) return; // 面板在 await 期间被关了
      const curIdx = this.getChapterIndex();
      const otherEntries = Object.keys(all)
        .map((k) => [Number(k), all[k]])
        .filter(([ch, arr]) => ch !== curIdx && Array.isArray(arr) && arr.length)
        .sort((a, b) => a[0] - b[0]);
      if (!otherEntries.length) return;
      const otherHeader = document.createElement('div');
      otherHeader.className = 'bookmarks-header bookmarks-header-other';
      const otherTitle = document.createElement('span');
      otherTitle.textContent = '其它章节';
      otherHeader.appendChild(otherTitle);
      panel.appendChild(otherHeader);
      const otherList = document.createElement('div');
      otherList.className = 'bookmarks-list';
      panel.appendChild(otherList);
      otherEntries.forEach(([ch, arr]) => {
        arr.slice().sort((a, b) => a - b).forEach((i) => {
          const row = this._makeRow(this.getChapterTitle(ch) + ' · 第 ' + (i + 1) + ' 句', null);
          row.onclick = () => { this.onJumpChapter(ch, i); panel.remove(); };
          otherList.appendChild(row);
        });
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
