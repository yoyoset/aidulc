/**
 * reader_view.js —— 阅读器 (P1: 路由视图化, 通过 bridge 加载指定书)
 *
 * 播放: 整章一条 Opus, <audio> + rAF 轮询 currentTime → 句级/词级高亮
 * 跟读: ShadowMachine (repeat N / A-B 循环 / 句末留白 / 变速 / 空格重复)
 * 数据: bridge.bookpack.load(bookId) → { bookpack, basePath, bookId }
 * 音频: bridge.bookpack.readAudio(basePath, audioFile) → Blob URL
 */
(function (global) {
  'use strict';

  class ReaderView {
    constructor(store) {
      this.store = store;
      this.renderer = null;
      this.bookpack = null;
      this.basePath = '';
      this.bookId = '';
      this.chapterIndex = 0;
      this.sentences = [];
      this.audio = null;
      this.shadow = new ShadowMachine();
      this.playing = false;
      this.container = null;
      this.onBack = null; // () => void
      this.bookmarks = new Set(); // 句下标
      this._saveTimer = null;
      this._searchIndex = new SearchIndex(); // G3
      this._blobUrl = null; // G3: 追踪待 revoke 的音频 blob
      this._generation = 0; // G3: 章节异步竞态防护(书打开/音频)
      this._chapterGen = 0; // 章节内容拉取+渲染的竞态防护(与 _generation 分开, 见 _loadChapter 注释)
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
      // G3: 全书搜索索引 (一次构建; bookpack.chapters[*].sentences 现在只带 original_text
      // 元信息, 修复大书 IPC 卡死用的, 恰好就是 SearchIndex.build 需要的最小字段)
      this._searchIndex.build(this.bookpack.chapters);
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
      // 注意: 这里不能再判 `gen !== this._generation` 才继续——_loadChapter 内部会
      // fire-and-forget 调 _setupAudio, 而 _setupAudio 自己的第一行就会 this._generation++
      // (用同一个计数器做音频竞态防护), 所以 _loadChapter 一返回, _generation 几乎必然
      // 已经变了; 加这个判断会导致 _restoreState 100% 被跳过(书签/阅读位置永远恢复不了,
      // 2026-08-07 改成按需加载章节时曾经这么写、被浏览器实测撞见)。
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

      // 顶栏: 返回书库 + 章切换 + 高亮切换 + 播放
      const top = document.createElement('div');
      top.className = 'reader-topbar';
      const backBtn = document.createElement('button');
      backBtn.className = 'btn-small';
      backBtn.textContent = '← 书库';
      backBtn.onclick = () => this.onBack && this.onBack();
      const title = document.createElement('span');
      title.className = 'reader-book-title';
      const prevCh = document.createElement('button');
      prevCh.className = 'btn-small';
      prevCh.textContent = '上一章';
      prevCh.onclick = () => this._switchChapter(-1);
      const nextCh = document.createElement('button');
      nextCh.className = 'btn-small';
      nextCh.textContent = '下一章';
      nextCh.onclick = () => this._switchChapter(1);
      const btnWord = document.createElement('button');
      btnWord.className = 'gran-toggle';
      btnWord.textContent = '词节奏';
      btnWord.onclick = () => this._setGranularity('word');
      const btnSent = document.createElement('button');
      btnSent.className = 'gran-toggle';
      btnSent.textContent = '句节奏';
      btnSent.onclick = () => this._setGranularity('sentence');
      const playBtn = document.createElement('button');
      playBtn.className = 'play-btn';
      playBtn.textContent = '▶ 播放';
      playBtn.onclick = () => { if (this.audio) { if (this.audio.paused) this.audio.play(); else this.audio.pause(); } };
      const prevSent = document.createElement('button');
      prevSent.className = 'btn-small';
      prevSent.textContent = '上一句';
      prevSent.onclick = () => this._stepSentence(-1);
      const nextSent = document.createElement('button');
      nextSent.className = 'btn-small';
      nextSent.textContent = '下一句';
      nextSent.onclick = () => this._stepSentence(1);
      const bmBtn = document.createElement('button');
      bmBtn.className = 'btn-small';
      bmBtn.textContent = '🔖 当前句书签';
      bmBtn.onclick = () => this._toggleBookmark();
      const bmListBtn = document.createElement('button');
      bmListBtn.className = 'btn-small';
      bmListBtn.textContent = '📋 书签';
      bmListBtn.onclick = () => this._showBookmarksPanel();
      const searchInput = document.createElement('input');
      searchInput.className = 'reader-search';
      searchInput.placeholder = '搜索…';
      searchInput.id = 'reader-search';
      searchInput.onkeydown = (e) => { if (e.key === 'Enter') this._search(e.target.value); };
      // 章节下拉 (用户要求: 书籍章节显示 + 可切换)
      const chSelect = document.createElement('select');
      chSelect.className = 'reader-chapter-select';
      chSelect.id = 'reader-chapter-select';
      chSelect.title = '选择章节';
      chSelect.onchange = () => {
        const idx = parseInt(chSelect.value, 10);
        if (!Number.isNaN(idx) && idx >= 0 && idx < this.bookpack.chapters.length) {
          this.chapterIndex = idx;
          this._loadChapter();
        }
      };
      top.append(backBtn, title, chSelect, prevCh, nextCh, btnWord, btnSent, prevSent, nextSent, bmBtn, bmListBtn, searchInput, playBtn);
      wrap.appendChild(top);

      // 播放器进度条 (P2)
      const player = document.createElement('div');
      player.className = 'player-bar';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 100;
      slider.value = 0;
      slider.id = 'audio-slider';
      const timeLabel = document.createElement('span');
      timeLabel.className = 'player-time';
      timeLabel.id = 'audio-time';
      timeLabel.textContent = '0:00 / 0:00';
      slider.addEventListener('input', () => {
        if (this.audio && this.audio.duration) {
          this.audio.currentTime = (slider.value / 100) * this.audio.duration;
        }
      });
      player.append(slider, timeLabel);
      wrap.appendChild(player);

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
        if (this.audio) this.audio.playbackRate = this.shadow.speed;
        this._updateStatus();
      };
      let abStart = null;
      document.getElementById('ab-set').onclick = () => {
        if (!this.audio) return;
        const ms = this.audio.currentTime * 1000;
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
     * 修复(2026-08-07): 章节内容不再随整本书一次性传来(见 load_bookpack 注释),
     * 这里按需拉取当前章完整内容(译文/讲解/segments/时间轴), 再分帧建 DOM。
     * 返回 Promise, resolve 时该章已经渲染完(书签恢复/搜索跳转等需要 DOM 已存在的
     * 逻辑必须等它, 否则会在 querySelector 时扑空 —— 见 _restoreState/_search)。
     */
    async _loadChapter() {
      const chMeta = this.bookpack.chapters[this.chapterIndex];
      if (!chMeta) return;
      // 修复: 防重入 (同章加载中跳过 — 无限循环防护)
      if (this._loadingChapter === this.chapterIndex) return;
      this._loadingChapter = this.chapterIndex;
      this._chapterGen++;
      const gen = this._chapterGen;

      const content = document.getElementById('reader-content');
      if (!content) { this._loadingChapter = null; return; }
      content.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'chapter-loading';
      loading.textContent = '加载中…';
      content.appendChild(loading);

      const res = await AiduLibraryService.loadBookpackChapter(this.bookId, this.chapterIndex);
      if (gen !== this._chapterGen) return; // 加载期间又切了章, 丢弃这次结果
      if (!res.ok) {
        content.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'global-error';
        err.textContent = '加载章节失败: ' + res.error;
        content.appendChild(err);
        this._loadingChapter = null;
        return;
      }
      const ch = res.data; // { index, title, audioFile, sentences }
      this.sentences = ch.sentences;
      content.innerHTML = '';
      this.renderer = new ReaderRenderer(content);
      const savedSet = new Set();
      await this.renderer.render({ sentences: this.sentences, showTranslations: false, savedSet, bookmarkIndices: this.bookmarks }, {
        onPlay: (i) => this._playFrom(i),
        onSelect: () => {},
        onBubbleClick: (bubble, seg) => { this._onWordClick(seg); },
        onBookmark: () => {},
      });
      if (gen !== this._chapterGen) return; // 渲染期间又切了章, 丢弃这次结果

      // 修复: 粒度用户选择持久; 仅首次用默认 (原每次切章强制重置导致"词级跳回句级")
      if (!this._granularity) {
        this._setGranularity(this._defaultGranularity || 'word');
      } else {
        this._setGranularity(this._granularity);
      }
      document.querySelector('.reader-book-title').textContent =
        `${this.bookpack.title} · ${chMeta.title || ('第' + (this.chapterIndex + 1) + '章')}`;
      // 章节下拉: 填充所有章节 + 高亮当前
      const chSelect = document.getElementById('reader-chapter-select');
      if (chSelect) {
        if (chSelect.options.length !== this.bookpack.chapters.length) {
          chSelect.innerHTML = '';
          this.bookpack.chapters.forEach((c, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = c.title || ('第' + (i + 1) + '章');
            chSelect.appendChild(opt);
          });
        }
        chSelect.value = String(this.chapterIndex);
      }
      this._setupAudio(ch);
      this._updateStatus();
      this._loadingChapter = null;
    }

    async _setupAudio(ch) {
      // G3: 释放旧 blob URL + 竞态防护 + 分块读取 (长章不整文件跨 IPC)
      this._generation++;
      const gen = this._generation;
      const audio = new Audio();
      audio.preload = 'auto';
      // 修复: 只在 blob 创建后设 this.audio; 旧调用 (gen 过时) 不碰全局状态
      const prevAudio = this.audio;
      if (prevAudio) { prevAudio.pause(); prevAudio.src = ''; prevAudio.remove(); }
      const oldBlob = this._blobUrl;
      this._blobUrl = null;
      if (oldBlob) URL.revokeObjectURL(oldBlob);
      const parts = [];
      let offset = 0;
      const CHUNK = 2 * 1024 * 1024; // 2MB/块
      try {
        for (;;) {
          // Bug fix (审查确认): 切章后立即中止旧章节读取循环
          if (gen !== this._generation) return;
          const r = await AiduLibraryService.readAudioRange(this.basePath, ch.audioFile, offset, CHUNK);
          if (!r.ok) throw new Error(r.error);
          // base64 → Uint8Array (修复: JSON 数字数组序列化开销大/截断 → blob 空, 无声音)
          const b64 = r.data && r.data.data_b64;
          if (!b64) throw new Error('音频数据为空');
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          parts.push(bytes);
          offset += r.data.read;
          if (r.data.end || r.data.read === 0) break;
        }
      } catch (e) {
        if (gen !== this._generation) return;
        document.getElementById('reader-status').textContent = '音频加载失败: ' + (e && e.message || e);
        return;
      }
      if (gen !== this._generation) return; // 旧章节结果丢弃
      const blob = new Blob(parts, { type: 'audio/ogg; codecs=opus' });
      this._blobUrl = URL.createObjectURL(blob);
      this.audio = audio;  // 修复: blob 就绪后才设 this.audio (旧调用不覆盖)
      audio.src = this._blobUrl;
      audio.load();
      // 修复: audio 挂到 reader-page; 替换旧实例 (否则 DOM 残留空 src 旧 audio)
      audio.id = 'reader-audio';
      audio.style.display = 'none';
      const page = document.querySelector('.reader-page');
      const old = document.getElementById('reader-audio');
      if (old) { old.onerror = null; old.remove(); }
      if (page) page.appendChild(audio);
      audio.addEventListener('error', () => {
        const statusEl = document.getElementById('reader-status');
        if (statusEl) statusEl.textContent = '音频播放错误: ' + (audio.error ? audio.error.message : '未知');
      });

      this.shadow.onAction = (action) => {
        if (action.type === 'repeat') {
          const s = this.sentences[action.sentenceIndex];
          if (s && s.audio) { audio.currentTime = s.audio.start_ms / 1000; audio.play(); }
        } else if (action.type === 'next') {
          if (action.sentenceIndex < this.sentences.length) this._playFrom(action.sentenceIndex);
        }
      };
      audio.addEventListener('ended', () => {
        const idx = this.sentences.findIndex(s => s.audio && Math.abs(audio.currentTime * 1000 - s.audio.end_ms) < 200);
        if (idx >= 0) this.shadow.sentenceEnded(idx);
      });
      audio.addEventListener('play', () => { this.playing = true; requestAnimationFrame(() => this._tick()); });
      audio.addEventListener('pause', () => { this.playing = false; this._saveProgress(); });
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
        // 修复(2026-08-07): 章节内容现在按需异步拉取, 必须等渲染完再摸 DOM 做书签恢复,
        // 否则大章节还没建完 DOM, querySelector 直接扑空(原来同步渲染时不会有这个问题)。
        await this._loadChapter();
      }
      const bookmarks = state.bookmarks || state.bm;
      if (Array.isArray(bookmarks)) {
        this.bookmarks = new Set(bookmarks);
        this.bookmarks.forEach(i => {
          const block = document.querySelector(`.atomic-block[data-index="${i}"]`);
          if (block) block.classList.add('bookmark-active');
        });
      }
      const pos = state.position_ms != null ? state.position_ms : 0;
      if (this.audio && pos && chapter === this.chapterIndex) {
        this.audio.currentTime = pos / 1000;
      }
    }

    _saveProgress() {
      if (!this.audio || !this.bookId) return;
      const state = {
        bookKey: this.bookId,
        chapter: this.chapterIndex,
        position_ms: Math.floor((this.audio.currentTime || 0) * 1000),
        bookmarks: Array.from(this.bookmarks),
      };
      AiduReadingService.save(state);
    }

    _stepSentence(delta) {
      if (!this.audio) return;
      const ms = this.audio.currentTime * 1000;
      const idx = this.sentences.findIndex(s => s.audio && ms >= s.audio.start_ms && ms < s.audio.end_ms);
      if (idx < 0) return;
      const target = idx + delta;
      if (target < 0 || target >= this.sentences.length) return;
      this._playFrom(target);
    }

    _toggleBookmark() {
      if (!this.audio) return;
      const ms = this.audio.currentTime * 1000;
      const idx = this.sentences.findIndex(s => s.audio && ms >= s.audio.start_ms && ms < s.audio.end_ms);
      if (idx < 0) return;
      if (this.bookmarks.has(idx)) {
        this.bookmarks.delete(idx);
        const block = document.querySelector(`.atomic-block[data-index="${idx}"]`);
        if (block) block.classList.remove('bookmark-active');
      } else {
        this.bookmarks.add(idx);
        const block = document.querySelector(`.atomic-block[data-index="${idx}"]`);
        if (block) block.classList.add('bookmark-active');
      }
      this._saveProgress();
    }

    _showBookmarksPanel() {
      // I-D: 书签面板 (抽屉): 列本书所有书签 → 跳转/删除
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

      const idxs = Array.from(this.bookmarks).sort((a, b) => a - b);
      if (!idxs.length) {
        list.appendChild(this._makeBookmarkRow('暂无书签。播放时点"🔖 当前句书签"。', null));
      }
      idxs.forEach(i => {
        const s = this.sentences[i];
        const text = s ? s.original_text.slice(0, 60) : '句 ' + i;
        const row = this._makeBookmarkRow(text, i);
        if (s) {
          row.onclick = () => { this._playFrom(i); panel.remove(); };
        }
        list.appendChild(row);
      });
    }

    _makeBookmarkRow(text, index) {
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
          this.bookmarks.delete(index);
          const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
          if (block) block.classList.remove('bookmark-active');
          this._saveProgress();
          this._showBookmarksPanel();
        };
        row.appendChild(del);
      }
      return row;
    }

    _switchChapter(delta) {
      const next = this.chapterIndex + delta;
      if (next < 0 || next >= this.bookpack.chapters.length) return;
      this._saveProgress();
      this.chapterIndex = next;
      this._loadChapter();
    }

    _playFrom(index) {
      const s = this.sentences[index];
      if (!s || !s.audio || !this.audio) {
        const statusEl = document.getElementById('reader-status');
        if (statusEl) statusEl.textContent = '音频尚未就绪, 请稍候再试';
        return;
      }
      this.shadow.sentenceStarted(index);
      this.audio.currentTime = s.audio.start_ms / 1000;
      this.audio.playbackRate = this.shadow.speed;
      this.audio.play().catch(e => {
        const statusEl = document.getElementById('reader-status');
        if (statusEl) statusEl.textContent = '播放失败: ' + e.message;
      });
    }

    _tick() {
      if (!this.playing || !this.audio) return;
      if (this.audio.paused) { this.playing = false; return; }
      const ms = this.audio.currentTime * 1000;
      if (this.shadow.shouldLoopBack(ms)) {
        this.audio.currentTime = this.shadow.loopBackPoint() / 1000;
      } else {
        this.renderer.highlightAt(ms, this.sentences);
      }
      // 进度条同步 (P2)
      const slider = document.getElementById('audio-slider');
      const timeLabel = document.getElementById('audio-time');
      if (slider && this.audio.duration) {
        slider.value = String((this.audio.currentTime / this.audio.duration) * 100);
        const t = Math.floor(this.audio.currentTime);
        const d = Math.floor(this.audio.duration || 0);
        timeLabel.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} / ${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
      }
      // 节流保存进度 (2s; 苹果级: 离开时 cleanup flush 兜底)
      if (this._saveTimer == null || Date.now() - this._saveTimer > 2000) {
        this._saveTimer = Date.now();
        this._saveProgress();
      }
      requestAnimationFrame(() => this._tick());
    }

    _setGranularity(g) {
      if (!this.renderer) return;
      this.renderer.setGranularity(g);
      this._granularity = g;  // 修复: 用户选择持久, 切章不重置 (原 _loadChapter 强制回默认)
      document.querySelectorAll('.gran-toggle').forEach(b => {
        b.classList.toggle('active', b.textContent === (g === 'word' ? '词节奏' : '句节奏'));
      });
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
      // I-A: 完整词典面板 (替换旧状态栏一行文本 + 临时 word-panel)
      if (!this.dictPanel) {
        this.dictPanel = new DictionaryPanel();
      }
      // 上下文: 当前句原文
      const idx = this.sentences.findIndex(s =>
        s.original_text && s.original_text.toLowerCase().includes(word.toLowerCase()));
      const context = idx >= 0 ? this.sentences[idx].original_text : '';
      this.dictPanel.show(word, profileId, context);
    }

    async _search(query) {
      if (!query) return;
      // G3: 用全书索引 (跨章节搜索), 不线性扫当前章
      const hits = this._searchIndex.search(query);
      if (!hits.length) {
        document.getElementById('reader-status').textContent = `未找到: ${query}`;
        return;
      }
      const first = hits[0];
      if (first.chapter !== this.chapterIndex) {
        // 命中在其它章节 → 切章; 章节内容现在是异步按需拉取的(见 _loadChapter 注释),
        // 必须等它渲染完, 目标句的 DOM 才存在, 否则 _setSentenceVisible 会扑空。
        this.chapterIndex = first.chapter;
        await this._loadChapter();
      }
      this._setSentenceVisible(first.index);
      document.getElementById('reader-status').textContent = `找到 ${hits.length} 处: ${first.text.slice(0, 60)}…`;
    }

    _setSentenceVisible(index) {
      const block = document.querySelector(`.atomic-block[data-index="${index}"]`);
      if (block) {
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        block.classList.add('search-target');
        setTimeout(() => block.classList.remove('search-target'), 2000);
      }
    }

    cleanup() {
      // G3: 释放音频 + blob URL
      this._generation++;
      // 苹果级: 离开前 flush 进度 (最后 2s 内的位置不丢)
      if (this.audio) {
        this._saveProgress();
        this.audio.pause(); this.audio.src = ''; this.audio = null;
      }
      if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
      this.playing = false;
    }
  }

  global.ReaderView = ReaderView;
})(window);
