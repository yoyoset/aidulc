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
      // K26 (2026-08-14, 用户拍板"带日期时间的书签"): 句下标 → 创建时间(ms)。
      // Map 而不是 Set——书签面板要按时间显示"什么时候读到哪里", 光有下标不够。
      this.bookmarks = new Map();
      this.onSave = deps.onSave || (() => {});
      this.onPlay = deps.onPlay || (() => {});
      this.getSentences = deps.getSentences || (() => []);
      this.getChapterIndex = deps.getChapterIndex || (() => 0);
      this.listAllChapters = deps.listAllChapters || (() => Promise.resolve(null));
      this.getChapterTitle = deps.getChapterTitle || ((idx) => '第 ' + (idx + 1) + ' 章');
      this.onJumpChapter = deps.onJumpChapter || (() => {});
    }

    /** 恢复集合 (从阅读状态加载); highlight 由宿主根据 renderer 做。
     *  接受 [{i, at}, ...](K26 新格式)或旧数据的纯数字数组(老书签没有创建时间,
     *  用 0 占位——面板显示"时间未知", 不假装知道)。 */
    restore(entries) {
      this.bookmarks = new Map();
      (Array.isArray(entries) ? entries : []).forEach((e) => {
        if (typeof e === 'number') this.bookmarks.set(e, 0);
        else if (e && typeof e.i === 'number') this.bookmarks.set(e.i, e.at || 0);
      });
    }

    /** 切换某句的书签状态, 并同步 DOM 高亮 (句块可能还没渲染, 查到就改查不到跳过) */
    toggle(index) {
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (this.bookmarks.has(index)) {
        this.bookmarks.delete(index);
        if (block) block.classList.remove('bookmark-active');
      } else {
        this.bookmarks.set(index, Date.now());
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
      // K26: 按创建时间倒序(最近标的书签排最上面, 比按句序更符合"我最近读到哪"的直觉)
      const entries = Array.from(this.bookmarks.entries()).sort((a, b) => b[1] - a[1]);
      if (!entries.length) {
        list.appendChild(this._makeRow('本章暂无书签。播放时点"🔖 当前句书签"。', null));
      }
      entries.forEach(([i, at]) => {
        const s = sentences[i];
        const text = (s ? s.original_text.slice(0, 60) : '句 ' + i) + (at ? ('  · ' + this._formatTime(at)) : '');
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
      // K26: 后端存的是 [{i, at}, ...](新格式); 老数据/老前端万一还是纯数字数组也兼容。
      otherEntries.forEach(([ch, arr]) => {
        const normalized = arr.map((e) => (typeof e === 'number' ? { i: e, at: 0 } : e));
        normalized.slice().sort((a, b) => a.i - b.i).forEach(({ i, at }) => {
          const label = this.getChapterTitle(ch) + ' · 第 ' + (i + 1) + ' 句' + (at ? ('  · ' + this._formatTime(at)) : '');
          const row = this._makeRow(label, null);
          row.onclick = () => { this.onJumpChapter(ch, i); panel.remove(); };
          otherList.appendChild(row);
        });
      });
    }

    /** K26: 书签面板里的时间展示——同一天只显示时分, 跨天带日期 (不需要秒级精度)。 */
    _formatTime(ms) {
      const d = new Date(ms);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (sameDay) return hm;
      return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + hm;
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
