/**
 * views/reader_view.js —— 阅读器 (组合根, S5 三模式重写, 2026-08-08)
 *
 * 架构延续 R2: 单一职责模块只做组装与编排。
 *   reader/chapter_ruler.js    —— 章节尺 (26px 左列)
 *   reader/player.js           —— <audio> 生命周期 + 3px 进度轨
 *   reader/chapter_loader.js   —— 按需拉章节
 *   reader/bookmarks.js        —— 书签
 *   reader/search.js           —— 搜索跳转
 *   reader/support_panel.js    —— 对照台右栏
 *   reader/settings_overlay.js —— 页面设置浮层
 *   reader/follow_bar.js       —— 逐句跟读条
 *   reader/silent_card.js      —— 静默正文支撑卡片
 *   reader/command_palette.js  —— Ctrl+K 命令面板 (搜索/书签入口)
 *
 * S5 核心: 三显示模式 (先答后核 / 静默正文 / 对照台) × 双节奏 (通篇 / 逐句跟读),
 * 状态机在 core/reader_state.js (纯逻辑), 键盘映射见 _onKeydown (设计 §4)。
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
      this.onBack = null;
      this._saveTimer = null;
      this._generation = 0;
      this._chapterGen = 0;
      this._granularity = 'word';

      // S5 状态
      this.rd = new AiduReaderState();
      this._settings = null;
      this._presetKey = 'shadow';
      this._speed = 1.0;
      this._blind = false;
      this._anchorIndex = -1;
      this._followTarget = -1;
      this._verifiedMap = {}; // 章下标 → [句下标,...] (持久化)

      // R2 模块
      this.shadow = new ShadowMachine();
      this.player = new ReaderPlayer();
      this.chapterLoader = new ChapterLoader();
      this.bookmarks = new BookmarkPanel({
        onSave: () => this._scheduleSave(),
        onPlay: (i) => this._playFrom(i),
        getSentences: () => this.sentences,
      });
      this.search = new ReaderSearch({
        getChapterIndex: () => this.chapterIndex,
        loadChapter: async (index) => {
          this.chapterIndex = index;
          this.bookmarks.restore([]); // R4-1: 搜索跨章跳转同样清空书签
          await this._loadChapter();
        },
        setSentenceVisible: (index) => this._setSentenceVisible(index),
        setStatus: (text) => this._setStatus(text),
      });
      this.dictPanel = null;

      // S5 view 模块 (render 时建)
      this.ruler = null;
      this.supportPanel = null;
      this.settingsOverlay = null;
      this.followBar = null;
      this.silentCard = null;
      this.commandPalette = null;
      this.topEl = null;
      this.countEl = null;

      // M7 R17: 摘录标注
      this.highlights = new ReaderHighlights({
        bookKey: () => this.bookId,
        getChapterIndex: () => this.chapterIndex,
        getSentences: () => this.sentences,
        onJump: (chapter, index) => this._jumpToHighlight(chapter, index),
        onChanged: () => this._renderSentences(),
      });

      // 渲染回调 (S5: 加句内三开关)
      this._handlers = {
        onPlay: (i) => this._toggleSentencePlay(i),
        onSelect: (i) => this._setAnchor(i, { scroll: false }),
        onBubbleClick: (bubble, seg) => this._onWordClick(seg),
        onBookmark: (i) => this._toggleBookmark(i),
        onFollowToggle: (i) => this._toggleFollow(i),
        onRevealToggle: (i) => this._toggleReveal(i),
      };

      this._onKeydown = (e) => this._handleKeydown(e);
      this._onScroll = () => {
        if (this.topEl) this.topEl.classList.toggle('scrolled', window.scrollY > 24);
      };
    }

    _setStatus(text) {
      const statusEl = document.getElementById('reader-status');
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.classList.add('show');
      clearTimeout(this._statusTimer);
      this._statusTimer = setTimeout(() => statusEl.classList.remove('show'), 2600);
    }

    // ---------------- 阶段3 (F46): 加载/错误/重试/返回书库 可见态 ----------------

    /** 在 reader-content 里放一个全区域状态块: loading / error(带重试 + 返回书库)。 */
    _showReaderState(kind, message, retry) {
      const content = document.getElementById('reader-content');
      if (!content) return;
      content.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'reader-state-box';
      if (kind === 'error') box.classList.add('reader-state-error');
      const text = document.createElement('div');
      text.textContent = message || (kind === 'loading' ? '加载中…' : '出错了');
      text.className = 'reader-state-text';
      box.appendChild(text);
      if (kind === 'error') {
        const row = document.createElement('div');
        row.className = 'reader-state-actions';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-small btn-primary';
        retryBtn.textContent = '重试';
        retryBtn.onclick = () => retry && retry();
        row.appendChild(retryBtn);
        const backBtn = document.createElement('button');
        backBtn.className = 'btn-small';
        backBtn.textContent = '返回书库';
        backBtn.onclick = () => this.onBack && this.onBack();
        row.appendChild(backBtn);
        box.appendChild(row);
      }
      content.appendChild(box);
    }

    // ---------------- 打开/设置 ----------------

    async open(bookId) {
      this.bookId = bookId;
      this._generation++;
      const gen = this._generation;
      // 阶段3 (F46): 打开即显示加载态, 后端失败不再落到空白页
      this._showReaderState('loading', '正在加载书包…');
      const res = await AiduLibraryService.loadBookpack(bookId);
      if (gen !== this._generation) return;
      if (!res.ok) {
        // 可读错误 + 重试/返回书库
        this._showReaderState('error', '加载书包失败: ' + res.error, () => {
          this._generation++;
          this.open(bookId).catch(() => {});
        });
        return;
      }
      this.bookpack = res.data.bookpack;
      this.basePath = res.data.basePath;
      this.chapterIndex = 0;
      this.search.build(this.bookpack.chapters);

      const profileId = (this.bookpack.profile && this.bookpack.profile.id) || 'default';
      // M7 R19 (2026-08-08): 四个 fetch 互不依赖, 并行拉取 —— 打开大书首屏不再等串行 IPC。
      const [rdRes, hlRes, sres, vres] = await Promise.all([
        AiduReadingService.get(bookId),
        this.highlights.load(bookId),
        // F25: 阅读器设置是用户级偏好(字号/主题/粒度/儿童模式/显示模式), 一律读 'default',
        // 不按书 profile 读 —— 否则 kid 书永远拿不到设置页写给 'default' 的儿童取值。
        AiduSettingsService.get('default'),
        AiduDictionaryService.list(profileId),
      ]);
      if (gen !== this._generation) return;

      if (rdRes.ok && rdRes.data) {
        this._verifiedMap = rdRes.data.verified || {};
        this._readingState = rdRes.data;
      }

      if (sres.ok && sres.data) this._applySettings(sres.data);
      else this._applySettings({
        profile_id: 'default',
        font_size: 18, line_height: 1.7, content_width: 760,
        font_family: 'serif', theme: 'light', highlight_granularity: 'sentence',
        child_mode: false, display_mode: 'guess', pace: 'flow', preset: 'shadow', speed: 1.0,
        palette: 'clay',
      });

      // 已入生词本的词 → 词下 1px 实线。R1-2: 双键匹配 (词面 + spaCy lemma)。
      this._savedSet = new Set(
        (vres.ok && Array.isArray(vres.data) ? vres.data : [])
          .flatMap((d) => [String(d.lemma || d.word || '').toLowerCase(), String(d.word || d.lemma || '').toLowerCase()])
      );

      if (!document.getElementById('reader-content')) return;
      await this._loadChapter();
      await this._restoreState();
      this._loadTodayStats();
      // V4 (2026-08-09): 背单词"在阅读器中打开" → 跳到记录位置 (消费后清除)
      const jump = this.store && this.store.state && this.store.state.vocabJump;
      if (jump && jump.chapter != null && jump.sentence != null) {
        this.store.set({ vocabJump: null });
        if (jump.chapter !== this.chapterIndex) {
          this.chapterIndex = jump.chapter;
          this._anchorIndex = jump.sentence;
          await this._loadChapter();
        }
        if (this.renderer) await this.renderer.ensureRendered(jump.sentence);
        this._setSentenceVisible(jump.sentence);
        this._setAnchor(jump.sentence, { scroll: true });
      }
    }

    /** M7 R37: 顶栏显示"今日已读 X 分钟" */
    _loadTodayStats() {
      if (!this.todayEl || !this.bookId) return;
      AiduReadingService.stats(this.bookId, 1).then((res) => {
        const d = (res.ok && res.data) || {};
        const mins = Math.floor((d.today_ms || 0) / 60000);
        this.todayEl.textContent = mins > 0 ? `今日 ${mins} 分钟` : '';
      });
    }

    /** S5: 应用 ReaderSettings (CSS 令牌 + 模式/节奏/预设/速度/粒度 + 儿童取值) */
    _applySettings(s) {
      this._settings = s || {};
      const root = document.documentElement;
      root.style.setProperty('--rd-text', (this._settings.font_size || 19) + 'px');
      root.style.setProperty('--rd-lh', String(this._settings.line_height || 1.85));
      root.style.setProperty('--rd-measure', (this._settings.content_width || 660) + 'px');
      document.body.dataset.theme = this._settings.theme || 'light';
      document.body.dataset.palette = this._settings.palette || 'clay';
      root.dataset.kid = this._settings.child_mode ? '1' : '0';
      // M7 R23: 自定义强调色 —— palette='custom' 且给了色值才派生内联变量
      const CUSTOM_PALETTE = ['--md-sys-color-primary', '--md-sys-color-on-primary',
        '--md-sys-color-primary-container', '--md-sys-color-on-primary-container',
        '--md-sys-color-inverse-primary', '--md-sys-state-hover', '--md-sys-state-focus',
        '--md-sys-state-pressed', '--rd-accent', '--rd-reading-bg'];
      const isCustom = this._settings.palette === 'custom' && this._settings.custom_color;
      if (isCustom) {
        const vars = AiduTheme.deriveCustomPalette(this._settings.custom_color);
        CUSTOM_PALETTE.forEach((k) => { if (vars[k]) root.style.setProperty(k, vars[k]); });
      } else {
        CUSTOM_PALETTE.forEach((k) => root.style.removeProperty(k));
      }

      this._granularity = this._settings.highlight_granularity === 'sentence' ? 'sentence' : 'word';
      this.rd.setMode(this._settings.display_mode || 'guess');
      this.rd.setPace(this._settings.pace || 'flow');

      const p = AiduFollowPresets.presetByKey(this._settings.preset);
      this._presetKey = p ? p.key : 'shadow';
      const preset = AiduFollowPresets.presetByKey(this._presetKey);
      this._speed = (typeof this._settings.speed === 'number' && this._settings.speed > 0)
        ? this._settings.speed : 1.0;
      if (preset) {
        this.shadow.setRepeat(preset.repeat);
        this.shadow.setGap(preset.gapMs);
      }
      this.shadow.setSpeed(this._speed);
      this._blind = preset ? preset.blind : false;
      this.player.speed = this._speed;
      if (this.player.audio) this.player.audio.playbackRate = this._speed;
    }

    _persistSettings() {
      if (!this._settings) return;
      const patch = Object.assign({}, this._settings, {
        display_mode: this.rd.displayMode,
        pace: this.rd.pace,
        preset: this._presetKey,
        speed: this._speed,
        updated_at: Date.now(),
      });
      // UX 审计 (2026-08-09): 保存失败不能静默 —— 否则用户改的字号/主题在下次打开
      // 时被静默还原, 是"后台失败但用户以为成功"。与 _saveProgress 同一反馈通道。
      AiduSettingsService.upsert(patch).catch(() => {
        if (document.body.classList.contains('reader-active')) {
          this._setStatus('设置保存失败 (磁盘写入失败?)');
        }
      });
    }

    // ---------------- 渲染 ----------------

    render(container) {
      this.container = container;
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'reader-page';

      // 沉浸: 隐藏 shell 导航, 阅读器全宽
      document.body.classList.add('reader-active');

      // 顶栏 单行: 返回 · 书名 · 章名 · 第 n/N 句 · 设置 (随滚动淡出)
      const top = document.createElement('header');
      top.className = 'rd-top';
      this.topEl = top;
      const back = document.createElement('button');
      back.className = 'rd-back';
      back.textContent = '←';
      back.title = '返回';
      back.onclick = () => this.onBack && this.onBack();
      const title = document.createElement('span');
      title.className = 'rd-title';
      this.titleEl = title;
      const count = document.createElement('span');
      count.className = 'rd-count';
      this.countEl = count;
      // M7 R37: 今日已读时长 (顶栏, 阅读量可见)
      const today = document.createElement('span');
      today.className = 'rd-today';
      this.todayEl = today;
      const gear = document.createElement('button');
      gear.className = 'rd-gear';
      gear.textContent = '⚙';
      gear.title = '页面设置';
      gear.onclick = () => {
        this.settingsOverlay.setSettings(this._settings);
        this.settingsOverlay.toggle();
      };
      top.append(back, title, today, count, gear);
      wrap.appendChild(top);

      // 正文容器 (滚动条归窗口)
      const content = document.createElement('div');
      content.className = 'reader-content';
      content.id = 'reader-content';
      wrap.appendChild(content);

      // 底部 3px 进度轨
      const progress = document.createElement('div');
      progress.className = 'rd-progress';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 100;
      slider.value = 0;
      slider.className = 'rd-progress-rail';
      progress.appendChild(slider);
      wrap.appendChild(progress);

      // 逐句跟读条 (仅 sentence 节奏显示)
      this.followBar = new FollowBar({
        presets: AiduFollowPresets.allPresets(),
        activePreset: this._presetKey,
        onSelectPreset: (key) => this._selectPreset(key),
        onFineTune: (patch) => this._onFineTune(patch),
        onExit: () => this._togglePace(),
      });
      wrap.appendChild(this.followBar.el);

      // 对照台右栏 (仅 bench 模式显示)
      this.supportPanel = new SupportPanel({
        getVerified: () => ({
          n: this.rd.verifiedCount(),
          total: this.sentences.length,
        }),
      });
      wrap.appendChild(this.supportPanel.el);

      // 页面设置浮层
      this.settingsOverlay = new SettingsOverlay({
        settings: this._settings,
        onPatch: (patch) => this._onSettingsPatch(patch),
      });
      wrap.appendChild(this.settingsOverlay.el);

      // 静默正文卡片 / 命令面板 (挂 body, 定位自由)
      this.silentCard = new SilentCard({
        getCurrentIndex: () => this._anchorIndex,
        getCurrentSentence: () => this.sentences[this._anchorIndex] || null,
      });
      this.commandPalette = new CommandPalette({
        onSearch: (q) => { this.search.search(q); this.commandPalette.close(); },
        onShowBookmarks: () => this.bookmarks.showPanel(),
        onShowHighlights: () => this.highlights.togglePanel(),
        onShowReadingStats: () => this._showReadingStats(),
      });

      // M7 R17: 选中文字 → 摘录
      this.highlights.attach();

      // 状态行 (临时浮窗)
      const status = document.createElement('div');
      status.className = 'rd-status';
      status.id = 'reader-status';
      wrap.appendChild(status);

      container.appendChild(wrap);

      // 章节尺 (最左 26px, 全屏定位)
      this.ruler = new ChapterRuler({
        chapters: this.bookpack ? this.bookpack.chapters : [],
        currentIndex: this.chapterIndex,
        onSelect: (idx) => this._jumpChapter(idx),
      });
      document.body.appendChild(this.ruler.el);

      // 音频接线 (进度轨外部注入)
      this.player.bindDOM({
        shadow: this.shadow,
        onStatus: (text) => this._setStatus(text),
        onSaveProgress: () => this._saveProgress(),
        onSentenceEnded: (idx) => this.shadow.sentenceEnded(idx),
        onAnchorChange: (idx) => this._onReadingAnchor(idx),
        onShadowAction: (action) => this._onShadowAction(action),
        onPlayingChange: (playing) => this._onPlayingChange(playing),
      });
      this.player.attachSlider(slider);

      window.addEventListener('keydown', this._onKeydown);
      window.addEventListener('scroll', this._onScroll, { passive: true });
      // F8 (2026-08-08): 关窗口/切后台前落盘位置 —— 连续播放中直接关窗口, 靠 pause 事件
      // 落盘会丢 (WebView 销毁时 pause 不保证触发)。
      this._onPageHide = () => this._saveProgress();
      window.addEventListener('pagehide', this._onPageHide);
      document.addEventListener('visibilitychange', this._onPageHide);

      this._applyModeChrome();
      this._updatePaceUI();
      this._updateFollowDataAttrs();
      this._updateTopCount();
      this._maybeShowOnboarding();
    }

    /** 设计 §4 可发现性兜底: 首次进入的一次性快捷键提示 (localStorage 记一次) */
    _maybeShowOnboarding() {
      try {
        if (window.localStorage.getItem('aidulc.rd.onboarding')) return;
        window.localStorage.setItem('aidulc.rd.onboarding', '1');
      } catch (e) { return; }
      const card = document.createElement('div');
      card.className = 'rd-onboard';
      card.textContent =
        '1/2/3 显示模式 · J/K 上/下一句 · Enter 核对 · S 通篇⇄逐句 · T 支撑卡片 · Ctrl+K 命令 · Space 播放';
      card.onclick = () => card.remove();
      setTimeout(() => card.remove(), 9000);
      document.body.appendChild(card);
    }

    _applyModeChrome() {
      if (!this.supportPanel) return;
      this.supportPanel.el.classList.toggle('visible', this.rd.displayMode === 'bench');
    }

    _updatePaceUI() {
      if (!this.followBar) return;
      this.followBar.el.classList.toggle('visible', this.rd.pace === 'sentence');
    }

    _updateFollowDataAttrs() {
      const content = document.getElementById('reader-content');
      if (!content) return;
      content.dataset.pace = this.rd.pace;
      content.dataset.blind = (this._blind && this._granularity === 'word') ? '1' : '0';
    }

    _updateTopCount() {
      if (this.countEl) {
        this.countEl.textContent = `第 ${Math.max(0, this._anchorIndex + 1)} / ${this.sentences.length} 句`;
      }
    }

    // ---------------- 章节 ----------------

    async _loadChapter() {
      const chMeta = this.bookpack.chapters[this.chapterIndex];
      if (!chMeta) return;

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
      if (!res) return;
      if (gen !== this._chapterGen) return;
      if (!res.ok) {
        // 阶段3 (F46): 章节加载失败可见 + 重试 + 返回书库 (不再只是红字)
        this._showReaderState('error', '加载章节失败: ' + res.error, () => {
          this._chapterGen++;
          this._loadChapter();
        });
        return;
      }
      const ch = res.data;
      this.sentences = ch.sentences;
      this._chapterImages = ch.images || [];
      content.innerHTML = '';
      this.renderer = new ReaderRenderer(content);
      if (this._anchorIndex < 0) this._anchorIndex = 0;
      await this._renderSentences();
      if (gen !== this._chapterGen) return;
      this.renderer.setBasePath(this.basePath);

      this.topbarTitle = `${this.bookpack.title} · ${chMeta.title || ('第' + (this.chapterIndex + 1) + '章')}`;
      if (this.titleEl) this.titleEl.textContent = this.topbarTitle;
      if (this.ruler) {
        this.ruler.setChapters(this.bookpack.chapters);
        this.ruler.setCurrent(this.chapterIndex);
      }

      this.player.renderer = this.renderer;
      this.player.sentences = this.sentences;
      this.player.basePath = this.basePath;
      this.player.speed = this.shadow.speed;
      this.player.anchorIndex = -1; // F11: 切章锚点归零, 防全局播放键串到旧章下标
      this.player.loadChapter(ch);
      this.rd.restoreVerified((this._verifiedMap && this._verifiedMap[this.chapterIndex]) || []);
    }

    /** S5: 用当前模式/粒度重建正文 (模式切换时复用 renderer, 保持滚动位置) */
    async _renderSentences() {
      if (!this.renderer) return;
      const scrollY = window.scrollY;
      const verifiedSet = (this._verifiedMap && this._verifiedMap[this.chapterIndex]) || [];
      await this.renderer.render({
        sentences: this.sentences,
        images: this._chapterImages || [],
        mode: this.rd.displayMode,
        currentIndex: this._anchorIndex,
        readerState: this.rd,
        verifiedSet: new Set(verifiedSet),
        savedSet: this._savedSet || new Set(),
        bookmarkIndices: this.bookmarks.bookmarks,
        highlights: this.highlights ? this.highlights.itemsForChapter(this.chapterIndex) : [],
      }, this._handlers);
      this.renderer.setGranularity(this._granularity || 'word');
      this._updateFollowDataAttrs();
      window.scrollTo(0, scrollY);
      if (this.rd.displayMode === 'bench' && this.supportPanel) {
        this.supportPanel.setSentence(this.sentences[this._anchorIndex] || null);
      }
    }

    _jumpChapter(idx) {
      if (idx < 0 || idx >= this.bookpack.chapters.length || idx === this.chapterIndex) return;
      this._saveProgress();
      this.chapterIndex = idx;
      this._anchorIndex = -1;
      // R4-1 (2026-08-08): 书签下标只在"当前章"有意义 —— 切章清空, 防旧章下标套到新章
      this.bookmarks.restore([]);
      this._loadChapter();
    }

    /** M7 R17: 摘录面板跳转 —— 跨章先切章, 再定位到句 */
    async _jumpToHighlight(chapter, index) {
      if (chapter !== this.chapterIndex) {
        this.chapterIndex = chapter;
        this._anchorIndex = index;
        this.bookmarks.restore([]); // R4-1
        await this._loadChapter();
      }
      this._setSentenceVisible(index);
    }

    /** M7 R39: 本周阅读面板 (近 7 天条形图, 复用 reading_daily 数据) */
    _showReadingStats() {
      const existing = document.getElementById('rd-stats-panel');
      if (existing) { existing.remove(); return; }
      const panel = document.createElement('div');
      panel.id = 'rd-stats-panel';
      panel.className = 'hl-panel';
      const head = document.createElement('div');
      head.className = 'hl-panel-head';
      const title = document.createElement('span');
      title.textContent = '本周阅读';
      const close = document.createElement('button');
      close.className = 'btn-small';
      close.textContent = '✕';
      close.onclick = () => panel.remove();
      head.append(title, close);
      const body = document.createElement('div');
      body.className = 'hl-panel-list';
      body.textContent = '加载中…';
      panel.append(head, body);
      document.body.appendChild(panel);
      AiduReadingService.stats(this.bookId, 7).then((res) => {
        body.innerHTML = '';
        const d = (res.ok && res.data) || {};
        const days = d.days || [];
        const today = Math.floor(Date.now() / 86400000);
        const bars = [];
        for (let i = 6; i >= 0; i--) {
          const day = today - i;
          const hit = days.find((x) => x.day === day);
          bars.push({ day, ms: hit ? hit.ms : 0 });
        }
        const max = Math.max(1, ...bars.map((b) => b.ms));
        const chart = document.createElement('div');
        chart.className = 'vocab-chart';
        bars.forEach((b) => {
          const bar = document.createElement('div');
          bar.className = 'vocab-chart-bar';
          const mins = Math.round(b.ms / 60000);
          bar.style.height = Math.max(2, Math.round((b.ms / max) * 42)) + 'px';
          bar.title = new Date(b.day * 86400000).toLocaleDateString() + ' ' + mins + ' 分钟';
          chart.appendChild(bar);
        });
        body.appendChild(chart);
        const total = Math.round(bars.reduce((s, b) => s + b.ms, 0) / 60000);
        const totalEl = document.createElement('div');
        totalEl.className = 'preview-meta';
        totalEl.textContent = `本周共读 ${total} 分钟`;
        body.appendChild(totalEl);
      });
    }

    async _restoreState() {
      const res = this._readingState
        ? { ok: true, data: this._readingState }
        : await AiduReadingService.get(this.bookId);
      if (!res.ok || !res.data) return;
      const state = res.data;
      const chapter = state.chapter != null ? state.chapter : state.chapter_index;
      if (chapter != null && chapter < this.bookpack.chapters.length && chapter >= 0 && chapter !== this.chapterIndex) {
        this.chapterIndex = chapter;
        // R4-1: 恢复位置切章时同样清空书签 (书签只属于各自那章)
        this.bookmarks.restore([]);
        await this._loadChapter();
      }
      const bookmarks = state.bookmarks || state.bm;
      if (Array.isArray(bookmarks)) {
        this.bookmarks.restore(bookmarks);
        const maxBm = this.bookmarks.bookmarks.size ? Math.max(...this.bookmarks.bookmarks) : -1;
        if (maxBm >= 0 && this.renderer) await this.renderer.ensureRendered(maxBm);
        this.bookmarks.bookmarks.forEach(i => {
          const block = document.querySelector(`.atomic-block[data-index="${i}"]`);
          if (block) block.classList.add('bookmark-active');
        });
      }
      this.rd.restoreVerified((this._verifiedMap && this._verifiedMap[this.chapterIndex]) || []);
      const pos = state.position_ms != null ? state.position_ms : 0;
      if (pos && chapter === this.chapterIndex) {
        // R1-1 (2026-08-08): 等音频就绪再 setPosition —— 否则 loadChapter 的 fire-and-forget
        // 让这里永远在 audio 就绪前执行, 位置恢复被静默跳过 (P0: 打开书总从句首开始)。
        // 竞态防护: await 期间切章/离开则丢弃。
        const gen = this._generation;
        if (this.player.audioReady) await this.player.audioReady;
        if (gen !== this._generation) return;
        if (!document.getElementById('reader-content')) return;
        if (this.player.audio) {
          this.player.setPosition(pos);
          // M7 R18: 恢复累计阅读时长
          this.player.timeSpentMs = state.time_spent_ms || 0;
          // 恢复锚点 (player 全局播放键 + 阅读器当前句) 到该位置所在句
          const si = AiduTimeline.findSentenceIndex(this.sentences, pos);
          if (si >= 0) {
            this.player.anchorIndex = si;
            this._setAnchor(si, { scroll: false });
          }
        }
      }
    }

    // ---------------- 锚点 / 当前句 ----------------

    _onReadingAnchor(idx) {
      // 通篇节奏: 当前句跟随朗读推进; 逐句节奏: 锚点固定在被跟读的句
      if (this.rd.pace === 'flow' && idx !== this._anchorIndex) {
        this._setAnchor(idx, { scroll: false });
        this._maybeAutoscroll(idx); // R27
      }
    }

    /** M7 R27: 通篇听读时, 当前句掉出视口才滚回视野 (保守, 不逐句跳) */
    _maybeAutoscroll(index) {
      if (this.rd.pace !== 'flow') return;
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (!block) return;
      const r = block.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      if (r.top >= 0 && r.bottom <= vh) return; // 完全在视口内, 不动
      window.scrollTo({ top: window.scrollY + r.top - vh * 0.4, behavior: 'smooth' });
    }

    _setAnchor(index, opts = {}) {
      const idx = Math.max(0, Math.min(this.sentences.length - 1, index));
      this._anchorIndex = idx;
      if (this.renderer) this.renderer.setCurrentSentence(idx);
      this._updateTopCount();
      if (this.silentCard && this.silentCard.isOpen()) this.silentCard.refresh();
      if (this.rd.displayMode === 'bench' && this.supportPanel) {
        this.supportPanel.setSentence(this.sentences[idx] || null);
      }
      if (opts.scroll) this._scrollToSentence(idx, opts.center);
    }

    _stepAnchor(delta) {
      if (!this.sentences.length) return;
      const next = Math.max(0, Math.min(this.sentences.length - 1, this._anchorIndex + delta));
      if (next === this._anchorIndex) return;
      this._setAnchor(next, { scroll: true, center: 0.42 });
      if (this.rd.pace === 'sentence') {
        this._enterSentencePace({ index: next, play: false });
      }
    }

    async _scrollToSentence(index, center) {
      if (this.renderer && index > this.renderer._renderedUpTo) {
        await this.renderer.ensureRendered(index);
      }
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (!block) return;
      if (center == null) {
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const r = block.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * center, behavior: 'smooth' });
    }

    async _setSentenceVisible(index) {
      this._setAnchor(index, { scroll: true });
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (block) {
        block.classList.add('search-target');
        setTimeout(() => block.classList.remove('search-target'), 2000);
      }
    }

    // ---------------- 播放 / 跟读 ----------------

    _toggleSentencePlay(index) {
      if (this.player.isPlayingSentence(index)) {
        this.player.stop();
        this.renderer.setBlockPlaying(index, false);
      } else {
        this._playFrom(index);
      }
    }

    _playFrom(index) {
      if (!this.player.audio) { this._setStatus('音频尚未就绪, 请稍候再试'); return; }
      this._setAnchor(index, { scroll: true, center: 0.42 });
      this.player.playFrom(index);
      this.renderer.setBlockPlaying(index, true);
      // 句内 ▶/❙❙ 状态复位 (其它句)
      this.renderer._blockCache.forEach((c, i) => {
        if (i !== index && c.ab) c.ab.setPlaying(false);
      });
    }

    _toggleFollow(index) {
      if (this.rd.pace === 'sentence' && this._followTarget === index) {
        this._exitSentencePace();
        return;
      }
      this._enterSentencePace({ index, play: true });
    }

    _enterSentencePace(opts = {}) {
      const target = opts.index != null ? opts.index : this._anchorIndex;
      this.rd.setPace('sentence');
      // 旧跟读目标的 ↻ 按钮态复位 (可能正跟着别的句)
      if (this._followTarget >= 0 && this._followTarget !== target && this.renderer) {
        this.renderer.setBlockFollow(this._followTarget, false);
      }
      this._followTarget = target;
      this._updatePaceUI();
      this._updateFollowDataAttrs();
      this._persistSettings();
      if (this.renderer) {
        this.renderer.setBlockFollow(target, true);
      }
      this._setAnchor(target, { scroll: true, center: 0.42 });
      const preset = AiduFollowPresets.presetByKey(this._presetKey);
      if (this.followBar) this.followBar.setBeats(1, preset ? preset.repeat : 1);
      if (opts.play) this._playFrom(target);
    }

    _exitSentencePace() {
      this.rd.setPace('flow');
      this._updatePaceUI();
      this._updateFollowDataAttrs();
      this._persistSettings();
      if (this.renderer && this._followTarget >= 0) {
        this.renderer.setBlockFollow(this._followTarget, false);
      }
      this._followTarget = -1;
    }

    _togglePace() {
      if (this.rd.pace === 'flow') this._enterSentencePace({ index: this._anchorIndex, play: false });
      else this._exitSentencePace();
    }

    _selectPreset(key) {
      const p = AiduFollowPresets.presetByKey(key);
      if (!p) return;
      this._presetKey = key;
      this.shadow.setRepeat(p.repeat);
      this.shadow.setGap(p.gapMs);
      this.shadow.setSpeed(p.speed);
      this._speed = p.speed;
      this.player.speed = p.speed;
      if (this.player.audio) this.player.audio.playbackRate = p.speed;
      this._blind = p.blind;
      if (this.followBar) {
        this.followBar.setPreset(p);
        this.followBar.setBeats(1, p.repeat);
      }
      this._updateFollowDataAttrs();
      this._persistSettings();
    }

    _onFineTune(patch) {
      if ('repeat' in patch) this.shadow.setRepeat(patch.repeat);
      if ('gapMs' in patch) this.shadow.setGap(patch.gapMs);
      if ('speed' in patch) this._setSpeed(patch.speed);
    }

    _setSpeed(v) {
      this._speed = Math.min(2, Math.max(0.5, v));
      this.shadow.setSpeed(this._speed);
      this.player.speed = this._speed;
      if (this.player.audio) this.player.audio.playbackRate = this._speed;
      this._persistSettings();
    }

    _onShadowAction(action) {
      if (!this.followBar) return;
      const preset = AiduFollowPresets.presetByKey(this._presetKey);
      const total = preset ? preset.repeat : 1;
      if (action.type === 'next') {
        this.followBar.setBeats(1, total);
      } else if (action.type === 'repeat') {
        const pass = Math.max(1, total - this.shadow.repeatLeft + 1);
        this.followBar.setBeats(pass, total);
      }
    }

    /** 音频暂停 → 复位所有句内 ▶/❙❙ 按钮 (自然播完/手动暂停都走到这) */
    _onPlayingChange(playing) {
      if (playing || !this.renderer) return;
      this.renderer._blockCache.forEach((c) => {
        if (c && c.ab) c.ab.setPlaying(false);
      });
    }

    // ---------------- 揭示 / 核对 / 模式 ----------------

    _toggleReveal(index) {
      if (this.rd.displayMode !== 'guess' || index < 0) return;
      if (!this.renderer) return;
      const c = this.renderer._blockCache.get(index);
      if (!c || !c.ab) return;
      if (this.rd.isRevealed(index)) {
        this.rd.collapse(index);
        c.ab.showSupport('scar');
        c.ab.setHint(this.rd.hintFor('guess', index));
      } else {
        const { newlyVerified } = this.rd.reveal(index);
        c.ab.showSupport('revealed');
        c.ab.setHint('');
        if (newlyVerified) this._markVerified(index);
      }
    }

    _markVerified(index) {
      if (!this._verifiedMap) this._verifiedMap = {};
      const arr = this._verifiedMap[this.chapterIndex] || (this._verifiedMap[this.chapterIndex] = []);
      if (!arr.includes(index)) {
        arr.push(index);
        arr.sort((a, b) => a - b);
      }
      this._scheduleSave();
      if (this.rd.displayMode === 'bench' && this.supportPanel) {
        this.supportPanel.setSentence(this.sentences[this._anchorIndex] || null);
      }
    }

    _setMode(m) {
      if (!this.rd.setMode(m)) return;
      this._settings.display_mode = m;
      this._persistSettings();
      if (m !== 'silent' && this.silentCard) this.silentCard.hide();
      this._applyModeChrome();
      this._renderSentences();
    }

    _toggleSilentCard() {
      if (this.rd.displayMode !== 'silent') return;
      if (!this.silentCard) return;
      this.silentCard.toggle();
    }

    // ---------------- 设置面板 ----------------

    _onSettingsPatch(patch) {
      if (!this._settings) this._settings = {};
      Object.assign(this._settings, patch, { updated_at: Date.now() });
      this._applySettings(this._settings);
      if ('highlight_granularity' in patch) {
        this._granularity = patch.highlight_granularity === 'sentence' ? 'sentence' : 'word';
        if (this.renderer) this.renderer.setGranularity(this._granularity);
        this._updateFollowDataAttrs();
      }
      if ('speed' in patch) {
        this.player.speed = this._speed;
        if (this.player.audio) this.player.audio.playbackRate = this._speed;
      }
      this._persistSettings();
    }

    // ---------------- 书签 / 查词 ----------------

    _toggleBookmark(index) {
      if (index == null) return;
      this.bookmarks.toggle(index);
      this._scheduleSave();
    }

    _onWordClick(seg) {
      const word = Array.isArray(seg) ? seg[0] : (seg && seg.word);
      if (!word) return;
      const profileId = (this.bookpack && this.bookpack.profile && this.bookpack.profile.id) || 'default';
      if (!this.dictPanel) {
        this.dictPanel = new DictionaryPanel();
        // F32 (2026-08-08): 加词入生词本 → 正文该词立即加下划线 (不用重开书)
        this.dictPanel.onVocabAdded = (w) => this._markSavedImmediate(w);
      }
      const idx = this.sentences.findIndex(s =>
        s.original_text && s.original_text.toLowerCase().includes(word.toLowerCase()));
      const context = idx >= 0 ? this.sentences[idx].original_text : '';
      // V4 (2026-08-09): 来源定位 —— bookId 即 edition id; 记录章节与句下标供"跳到原文"
      const source = {
        editionId: this.bookId,
        chapterIndex: this.chapterIndex,
        sentenceIndex: idx >= 0 ? idx : null,
      };
      this.dictPanel.show(word, profileId, context, source);
    }

    /** F32: 加词后立即给已渲染的匹配 token 加 saved 标记 + 并入 _savedSet */
    _markSavedImmediate(word) {
      const w = String(word || '').toLowerCase();
      if (!w) return;
      if (this._savedSet) this._savedSet.add(w);
      document.querySelectorAll('.reader-content .bubble').forEach((t) => {
        const text = (t.textContent || '').toLowerCase();
        const lemma = (t.dataset.lemma || '').toLowerCase();
        if (text === w || lemma === w) t.classList.add('saved');
      });
    }

    // ---------------- 键盘 (设计 §4) ----------------

    _handleKeydown(e) {
      // Ctrl+K 命令面板优先 (即使焦点在输入框)
      if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (this.commandPalette) this.commandPalette.toggle();
        return;
      }
      // 输入框/编辑区不劫持
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      switch (e.key) {
        case 'j': case 'J': this._stepAnchor(1); e.preventDefault(); break;
        case 'k': case 'K': this._stepAnchor(-1); e.preventDefault(); break;
        case ' ': this._onSpace(); e.preventDefault(); break;
        case 'Enter': this._onEnter(); e.preventDefault(); break;
        case 't': case 'T': this._toggleSilentCard(); break;
        case 'Escape': this._onEscape(); break;
        case 's': case 'S': this._togglePace(); e.preventDefault(); break;
        case '1': this._setMode('guess'); break;
        case '2': this._setMode('silent'); break;
        case '3': this._setMode('bench'); break;
        default: break;
      }
    }

    _onSpace() {
      if (this.rd.pace === 'sentence' && this._followTarget >= 0) {
        this._playFrom(this._followTarget); // 逐句: 重播当前句
      } else {
        this.player.toggle(); // 通篇: 播放/暂停
      }
    }

    _onEnter() {
      if (this.rd.displayMode === 'guess') {
        this._toggleReveal(this._anchorIndex);
      } else if (this.rd.displayMode === 'bench' && this.supportPanel) {
        this.supportPanel.openTranslation();
      }
    }

    _onEscape() {
      if (this.silentCard && this.silentCard.isOpen()) { this.silentCard.hide(); return; }
      if (this.settingsOverlay && this.settingsOverlay.isOpen()) { this.settingsOverlay.close(); return; }
      if (this.commandPalette && this.commandPalette.isOpen()) { this.commandPalette.close(); return; }
      if (this.supportPanel && this.supportPanel.isTranslationOpen()) {
        this.supportPanel._toggleTranslation();
      }
    }

    // ---------------- 持久化 ----------------

    _scheduleSave() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._saveProgress(), 800);
    }

    _saveProgress() {
      if (!this.bookId) return;
      const state = {
        bookKey: this.bookId,
        chapter: this.chapterIndex,
        position_ms: this.player.currentTimeMs,
        bookmarks: Array.from(this.bookmarks.bookmarks),
        verified: this._verifiedMap || {},
        time_spent_ms: this.player.timeSpentMs || 0, // M7 R18
      };
      // F41 (2026-08-08): 落盘失败不能静默 —— 否则用户以为已保存, 下次打开还原旧位置
      AiduReadingService.save(state).catch(() => {
        if (document.body.classList.contains('reader-active')) {
          this._setStatus('进度保存失败 (磁盘写入失败?)');
        }
      });
    }

    cleanup() {
      this._generation++;
      this._chapterGen++;
      this.chapterLoader.invalidate();
      this.player.cleanup();
      window.removeEventListener('keydown', this._onKeydown);
      window.removeEventListener('scroll', this._onScroll);
      if (this._onPageHide) {
        window.removeEventListener('pagehide', this._onPageHide);
        document.removeEventListener('visibilitychange', this._onPageHide);
      }
      if (this.highlights) this.highlights.detach();
      document.body.classList.remove('reader-active');
      const onboard = document.querySelector('.rd-onboard');
      if (onboard && onboard.parentNode) onboard.parentNode.removeChild(onboard);
      if (this.ruler && this.ruler.el.parentNode) this.ruler.el.parentNode.removeChild(this.ruler.el);
      if (this.silentCard) this.silentCard.hide();
      if (this.commandPalette) this.commandPalette.close();
      if (this.followBar && this.followBar.el.parentNode) this.followBar.el.parentNode.removeChild(this.followBar.el);
      if (this.supportPanel && this.supportPanel.el.parentNode) this.supportPanel.el.parentNode.removeChild(this.supportPanel.el);
      if (this.settingsOverlay && this.settingsOverlay.el.parentNode) this.settingsOverlay.el.parentNode.removeChild(this.settingsOverlay.el);
      clearTimeout(this._saveTimer);
    }
  }

  global.ReaderView = ReaderView;
})(window);
