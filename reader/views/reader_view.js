/**
 * views/reader_view.js —— 阅读器 (组合根)
 *
 * R2 重构 (2026-08-08): 原先 600+ 行一个类同时管顶栏/音频/章节/书签/搜索,
 * 拆成 reader/ 目录下的单一职责模块, 这里只做组装与编排:
 *   reader/topbar.js        —— 顶栏 DOM 与按钮绑定
 *   reader/player.js        —— <audio> 生命周期/分块加载/进度条/时间
 *   reader/chapter_loader.js—— 按需拉章节 + 竞态防护
 *   reader/bookmarks.js     —— 书签集合/面板/持久化
 *   reader/search.js        —— 搜索与跳转
 *
 * 数据流: open() 拉书包元信息 → _loadChapter() 按需拉当前章完整内容 →
 * renderer 渐进渲染 + player 加载音频 → tick 同步高亮/进度。
 */
(function (global) {
  'use strict';

  class ReaderView {
    constructor(store) {
      this.store = store;
      this.bookpack = null;
      this.basePath = '';
      this.bookId = '';
      this.chapterIndex = 0;
      this.sentences = [];
      this.renderer = null;
      this.container = null;
      this.onBack = null; // () => void
      this._saveTimer = null;
      this._generation = 0; // 书打开的竞态防护 (open/cleanup)
      this._chapterGen = 0; // 章节渲染期的竞态防护 (fetch 内由 chapterLoader 管, 渲染期归这里)
      this._granularity = null; // 用户选择的粒度 (切章不重置)
      this._defaultGranularity = 'word';

      // R2: 单一职责模块实例
      this.shadow = new ShadowMachine();
      this.player = new ReaderPlayer();
      this.chapterLoader = new ChapterLoader();
      this.bookmarks = new BookmarkPanel({
        onSave: () => this._saveProgress(),
        onPlay: (i) => this._playFrom(i),
        getSentences: () => this.sentences,
      });
      this.search = new ReaderSearch({
        getChapterIndex: () => this.chapterIndex,
        loadChapter: async (index) => { this.chapterIndex = index; await this._loadChapter(); },
        setSentenceVisible: (index) => this._setSentenceVisible(index),
        setStatus: (text) => this._setStatus(text),
      });
      this.dictPanel = null;
    }

    _setStatus(text) {
      const statusEl = document.getElementById('reader-status');
      if (statusEl) statusEl.textContent = text;
    }

    async open(bookId) {
      this.bookId = bookId;
      this._generation++; // 取消旧的 in-flight open (审查确认 bug)
      const gen = this._generation;
      const res = await AiduLibraryService.loadBookpack(bookId);
      if (gen !== this._generation) return; // 已切换
      if (!res.ok) throw new Error('加载书包失败: ' + res.error);
      this.bookpack = res.data.bookpack;
      this.basePath = res.data.basePath;
      this.chapterIndex = 0;
      // G3: 全书搜索索引 (元信息含 original_text, SearchIndex 恰好只需要这个字段)
      this.search.build(this.bookpack.chapters);
      // 应用该 profile 的阅读设置 (P2: 字体/主题/粒度)
      const profileId = (this.bookpack.profile && this.bookpack.profile.id) || 'default';
      const sres = await AiduSettingsService.get(profileId);
      if (gen !== this._generation) return;
      if (sres.ok && sres.data) {
        this._applySettings(sres.data);
      }
      // 离开阅读器后 DOM 已被清理 → 中止 (审查确认: 写 null DOM 抛 TypeError)
      if (!document.getElementById('reader-content')) return;
      await this._loadChapter();
      // 恢复书签 + 阅读位置 (只一次, 防死循环)
      await this._restoreState();
    }

    _applySettings(s) {
      const root = document.documentElement;
      root.style.setProperty('--reader-font-size', (s.font_size || 18) + 'px');
      root.style.setProperty('--reader-line-height', s.line_height || 1.7);
      root.style.setProperty('--reader-content-width', (s.content_width || 760) + 'px');
      document.body.dataset.theme = s.theme || 'light';
      this._defaultGranularity = s.highlight_granularity === 'word' ? 'word' : 'sentence';
    }

    render(container) {
      this.container = container;
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'reader-page';

      // 顶栏 (reader/topbar.js)
      const topbar = new ReaderTopbar({
        onBack: () => this.onBack && this.onBack(),
        onSwitchChapter: (delta) => this._switchChapter(delta),
        onGranularity: (g) => this._setGranularity(g),
        onTogglePlay: () => this.player.toggle(),
        onStepSentence: (delta) => this.player.stepSentence(delta),
        onToggleBookmark: () => this._toggleBookmark(),
        onShowBookmarks: () => this.bookmarks.showPanel(),
        onSearch: (q) => this.search.search(q),
        onSelectChapter: (idx) => {
          if (idx >= 0 && idx < this.bookpack.chapters.length) {
            this.chapterIndex = idx;
            this._loadChapter();
          }
        },
      });
      this.topbar = topbar;
      wrap.appendChild(topbar.el);

      // 播放器进度条 (reader/player.js)
      wrap.appendChild(this.player.bindDOM({
        shadow: this.shadow,
        onStatus: (text) => this._setStatus(text),
        onSaveProgress: () => this._saveProgress(),
        onSentenceEnded: (idx) => this.shadow.sentenceEnded(idx),
      }));

      // 跟读控制条
      const bar = document.createElement('div');
      bar.className = 'shadow-bar';
      bar.innerHTML = `
        <label>重复 <input id="repeat-n" type="number" min="1" max="10" value="1" style="width:45px"></label>
        <label>留白 <input id="gap-ms" type="number" min="0" max="3000" step="100" value="500" style="width:60px">ms</label>
        <label>速度 <input id="speed-x" type="number" min="0.5" max="2" step="0.1" value="1.0" style="width:55px"></label>
        <button id="ab-set">设A-B</button>
        <button id="ab-clear">清A-B</button>
        <span id="ab-info"></span>
      `;
      wrap.appendChild(bar);

      // 正文
      const content = document.createElement('div');
      content.className = 'reader-content';
      content.id = 'reader-content';
      wrap.appendChild(content);

      // 状态行
      const status = document.createElement('div');
      status.className = 'status';
      status.id = 'reader-status';
      wrap.appendChild(status);

      container.appendChild(wrap);
      this._bindControls();
    }

    _bindControls() {
      document.getElementById('repeat-n').onchange = (e) => { this.shadow.setRepeat(+e.target.value); this._updateStatus(); };
      document.getElementById('gap-ms').onchange = (e) => { this.shadow.setGap(+e.target.value); this._updateStatus(); };
      document.getElementById('speed-x').onchange = (e) => {
        this.shadow.setSpeed(+e.target.value);
        this.player.speed = this.shadow.speed;
        if (this.player.audio) this.player.audio.playbackRate = this.shadow.speed;
        this._updateStatus();
      };
      let abStart = null;
      document.getElementById('ab-set').onclick = () => {
        if (!this.player.audio) return;
        const ms = this.player.audio.currentTime * 1000;
        if (abStart == null) {
          abStart = ms;
          document.getElementById('ab-info').textContent = `A=${(abStart / 1000).toFixed(1)}s ...`;
        } else {
          this.shadow.setABLoop(abStart, ms);
          abStart = null;
          document.getElementById('ab-info').textContent =
            `循环 ${(this.shadow.abLoop.start_ms / 1000).toFixed(1)}s-${(this.shadow.abLoop.end_ms / 1000).toFixed(1)}s`;
        }
      };
      document.getElementById('ab-clear').onclick = () => {
        this.shadow.setABLoop(null, null);
        abStart = null;
        document.getElementById('ab-info').textContent = '';
      };
    }

    /**
     * 按需拉取当前章完整内容 (译文/讲解/segments/时间轴), 再交给 renderer 渐进渲染。
     * 返回 Promise, resolve 时该章首屏已渲染完 (书签恢复/搜索跳转需要 DOM 已存在)。
     */
    async _loadChapter() {
      const chMeta = this.bookpack.chapters[this.chapterIndex];
      if (!chMeta) return;

      // 渲染期竞态防护: 切章后旧渲染结果丢弃 (fetch 内由 chapterLoader 自己管)
      this._chapterGen++;
      const gen = this._chapterGen;

      const content = document.getElementById('reader-content');
      if (!content) { this.chapterLoader.invalidate(); return; }
      content.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'chapter-loading';
      loading.textContent = '加载中…';
      content.appendChild(loading);

      const res = await this.chapterLoader.load(this.bookId, this.chapterIndex);
      if (!res) return; // 竞态/防重入
      if (gen !== this._chapterGen) return; // 等 fetch 期间又切了章
      if (!res.ok) {
        content.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'global-error';
        err.textContent = '加载章节失败: ' + res.error;
        content.appendChild(err);
        return;
      }
      const ch = res.data; // { index, title, audioFile, sentences }
      this.sentences = ch.sentences;
      content.innerHTML = '';
      this.renderer = new ReaderRenderer(content);
      const savedSet = new Set();
      await this.renderer.render({ sentences: this.sentences, images: ch.images, showTranslations: false, savedSet, bookmarkIndices: this.bookmarks.bookmarks }, {
        onPlay: (i) => this._toggleSentencePlay(i),
        onSelect: () => {},
        onBubbleClick: (bubble, seg) => { this._onWordClick(seg); },
        onBookmark: () => {},
      });
      if (gen !== this._chapterGen) return; // 渲染期间又切了章, 丢弃这次结果
      this.renderer.setBasePath(this.basePath); // R4: 注入书包根, 触发插图预取

      // 修复: 粒度用户选择持久; 仅首次用默认 (原每次切章强制重置导致"词级跳回句级")
      this._setGranularity(this._granularity || this._defaultGranularity || 'word');

      this.topbar.setTitle(`${this.bookpack.title} · ${chMeta.title || ('第' + (this.chapterIndex + 1) + '章')}`);
      this.topbar.setChapters(this.bookpack.chapters, this.chapterIndex);

      // R2: 音频交给 player (分块加载 + 竞态防护在模块内)
      this.player.renderer = this.renderer;
      this.player.sentences = this.sentences;
      this.player.basePath = this.basePath;
      this.player.speed = this.shadow.speed;
      this.player.loadChapter(ch);
      this._updateStatus();
    }

    // 修复: _restoreState 只在 open() 后调一次 (原在 _setupAudio 里 → 死循环:
    // _setupAudio → _restoreState → _loadChapter → _setupAudio → ... 无限)
    async _restoreState() {
      const res = await AiduReadingService.get(this.bookId);
      if (!res.ok || !res.data) return;
      const state = res.data;
      const chapter = state.chapter != null ? state.chapter : state.chapter_index;
      if (chapter != null && chapter < this.bookpack.chapters.length && chapter >= 0 && chapter !== this.chapterIndex) {
        this.chapterIndex = chapter;
        await this._loadChapter();
      }
      const bookmarks = state.bookmarks || state.bm;
      if (Array.isArray(bookmarks)) {
        this.bookmarks.restore(bookmarks);
        // R1: 渐进式渲染下书签句可能还没建 DOM, 先补渲染到最大的书签句再标高亮
        const maxBm = this.bookmarks.bookmarks.size ? Math.max(...this.bookmarks.bookmarks) : -1;
        if (maxBm >= 0 && this.renderer) await this.renderer.ensureRendered(maxBm);
        this.bookmarks.bookmarks.forEach(i => {
          const block = document.querySelector(`.atomic-block[data-index="${i}"]`);
          if (block) block.classList.add('bookmark-active');
        });
      }
      const pos = state.position_ms != null ? state.position_ms : 0;
      if (this.player.audio && pos && chapter === this.chapterIndex) {
        this.player.setPosition(pos);
      }
    }

    _saveProgress() {
      if (!this.player.audio || !this.bookId) return;
      const state = {
        bookKey: this.bookId,
        chapter: this.chapterIndex,
        position_ms: this.player.currentTimeMs,
        bookmarks: Array.from(this.bookmarks.bookmarks),
      };
      AiduReadingService.save(state);
    }

    _switchChapter(delta) {
      const next = this.chapterIndex + delta;
      if (next < 0 || next >= this.bookpack.chapters.length) return;
      this._saveProgress();
      this.chapterIndex = next;
      this._loadChapter();
    }

    _playFrom(index) {
      this.player.playFrom(index);
    }

    /**
     * 句子前三角: 点一下开始, 再点一下停止。
     * 正在播这句 → 停; 否则从这句开始 (锚点移到该句)。
     */
    _toggleSentencePlay(index) {
      if (this.player.isPlayingSentence(index)) {
        this.player.stop();
      } else {
        this.player.playFrom(index);
      }
    }

    _toggleBookmark() {
      if (!this.player.audio) return;
      const ms = this.player.audio.currentTime * 1000;
      const idx = this.sentences.findIndex(s => s.audio && ms >= s.audio.start_ms && ms < s.audio.end_ms);
      if (idx < 0) return;
      this.bookmarks.toggle(idx);
    }

    async _setSentenceVisible(index) {
      // R1: 渐进式渲染下目标句可能还没建 DOM, 先补渲染再滚动定位
      if (this.renderer && index > this.renderer._renderedUpTo) {
        await this.renderer.ensureRendered(index);
      }
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (block) {
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        block.classList.add('search-target');
        setTimeout(() => block.classList.remove('search-target'), 2000);
      }
    }

    _setGranularity(g) {
      if (!this.renderer) return;
      this.renderer.setGranularity(g);
      this._granularity = g; // 修复: 用户选择持久, 切章不重置
      this.topbar.setGranularity(g);
    }

    _updateStatus() {
      const statusEl = document.getElementById('reader-status');
      if (statusEl && this.bookpack) {
        statusEl.textContent =
          `${this.sentences.length} 句 | 跟读: 重复 ${this.shadow.repeatCount} 次 / 留白 ${this.shadow.gapMs}ms / 变速 x${this.shadow.speed}`;
      }
    }

    _onWordClick(seg) {
      const word = Array.isArray(seg) ? seg[0] : (seg && seg.word);
      if (!word) return;
      const profileId = (this.bookpack && this.bookpack.profile && this.bookpack.profile.id) || 'default';
      // I-A: 完整词典面板
      if (!this.dictPanel) {
        this.dictPanel = new DictionaryPanel();
      }
      // 上下文: 当前句原文
      const idx = this.sentences.findIndex(s =>
        s.original_text && s.original_text.toLowerCase().includes(word.toLowerCase()));
      const context = idx >= 0 ? this.sentences[idx].original_text : '';
      this.dictPanel.show(word, profileId, context);
    }

    cleanup() {
      // 取消 in-flight open/章节加载 + 释放音频与 blob URL
      this._generation++;
      this._chapterGen++;
      this.chapterLoader.invalidate();
      this.player.cleanup();
    }
  }

  global.ReaderView = ReaderView;
})(window);
