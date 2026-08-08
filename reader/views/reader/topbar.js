/**
 * views/reader/topbar.js —— 阅读器顶栏 (R2 拆分自 reader_view.js)
 * 单一职责: 顶栏 DOM 构建 + 按钮绑定 + 章节下拉 + 粒度切换视觉。
 * 不碰数据/音频/正文渲染, 只通过构造时传入的 callbacks 把用户动作转发出去。
 */
(function (global) {
  'use strict';

  class ReaderTopbar {
    /**
     * @param {object} cbs 回调集合:
     *   onBack(): 返回书库
     *   onSwitchChapter(delta): 上一章/下一章
     *   onGranularity(g): 词节奏/句节奏
     *   onTogglePlay(): 播放/暂停
     *   onStepSentence(delta): 上一句/下一句
     *   onToggleBookmark(): 当前句加/删书签
     *   onShowBookmarks(): 打开书签面板
     *   onSearch(query): 搜索
     *   onSelectChapter(idx): 下拉选中某章
     */
    constructor(cbs) {
      this.cbs = cbs;
      this.el = document.createElement('div');
      this.el.className = 'reader-topbar';
      this.titleEl = null;
      this.chSelect = null;

      const backBtn = document.createElement('button');
      backBtn.className = 'btn-small';
      backBtn.textContent = '← 书库';
      backBtn.onclick = () => this.cbs.onBack && this.cbs.onBack();

      const title = document.createElement('span');
      title.className = 'reader-book-title';
      this.titleEl = title;

      const chSelect = document.createElement('select');
      chSelect.className = 'reader-chapter-select';
      chSelect.id = 'reader-chapter-select';
      chSelect.title = '选择章节';
      chSelect.onchange = () => {
        const idx = parseInt(chSelect.value, 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          this.cbs.onSelectChapter && this.cbs.onSelectChapter(idx);
        }
      };
      this.chSelect = chSelect;

      const prevCh = document.createElement('button');
      prevCh.className = 'btn-small';
      prevCh.textContent = '上一章';
      prevCh.onclick = () => this.cbs.onSwitchChapter && this.cbs.onSwitchChapter(-1);
      const nextCh = document.createElement('button');
      nextCh.className = 'btn-small';
      nextCh.textContent = '下一章';
      nextCh.onclick = () => this.cbs.onSwitchChapter && this.cbs.onSwitchChapter(1);

      const btnWord = document.createElement('button');
      btnWord.className = 'gran-toggle';
      btnWord.textContent = '词节奏';
      btnWord.onclick = () => this.cbs.onGranularity && this.cbs.onGranularity('word');
      const btnSent = document.createElement('button');
      btnSent.className = 'gran-toggle';
      btnSent.textContent = '句节奏';
      btnSent.onclick = () => this.cbs.onGranularity && this.cbs.onGranularity('sentence');

      const prevSent = document.createElement('button');
      prevSent.className = 'btn-small';
      prevSent.textContent = '上一句';
      prevSent.onclick = () => this.cbs.onStepSentence && this.cbs.onStepSentence(-1);
      const nextSent = document.createElement('button');
      nextSent.className = 'btn-small';
      nextSent.textContent = '下一句';
      nextSent.onclick = () => this.cbs.onStepSentence && this.cbs.onStepSentence(1);

      const bmBtn = document.createElement('button');
      bmBtn.className = 'btn-small';
      bmBtn.textContent = '🔖 当前句书签';
      bmBtn.onclick = () => this.cbs.onToggleBookmark && this.cbs.onToggleBookmark();
      const bmListBtn = document.createElement('button');
      bmListBtn.className = 'btn-small';
      bmListBtn.textContent = '📋 书签';
      bmListBtn.onclick = () => this.cbs.onShowBookmarks && this.cbs.onShowBookmarks();

      const searchInput = document.createElement('input');
      searchInput.className = 'reader-search';
      searchInput.placeholder = '搜索…';
      searchInput.id = 'reader-search';
      searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') this.cbs.onSearch && this.cbs.onSearch(e.target.value);
      };

      const playBtn = document.createElement('button');
      playBtn.className = 'play-btn';
      playBtn.textContent = '▶ 播放';
      playBtn.onclick = () => this.cbs.onTogglePlay && this.cbs.onTogglePlay();

      this.el.append(
        backBtn, title, chSelect, prevCh, nextCh,
        btnWord, btnSent, prevSent, nextSent,
        bmBtn, bmListBtn, searchInput, playBtn
      );
    }

    setTitle(text) {
      if (this.titleEl) this.titleEl.textContent = text;
    }

    /** 填充章节下拉(章节数不变时不重建, 保留用户当前选中) + 高亮当前章 */
    setChapters(chapters, currentIndex) {
      if (!this.chSelect) return;
      if (this.chSelect.options.length !== chapters.length) {
        this.chSelect.innerHTML = '';
        chapters.forEach((c, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = c.title || ('第' + (i + 1) + '章');
          this.chSelect.appendChild(opt);
        });
      }
      this.chSelect.value = String(currentIndex);
    }

    /** 高亮当前的粒度切换按钮 (word/sentence) */
    setGranularity(g) {
      this.el.querySelectorAll('.gran-toggle').forEach(b => {
        const target = g === 'word' ? '词节奏' : '句节奏';
        b.classList.toggle('active', b.textContent === target);
      });
    }
  }

  global.ReaderTopbar = ReaderTopbar;
})(window);
