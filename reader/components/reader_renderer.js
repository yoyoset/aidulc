/**
 * reader_renderer.js —— 渐进式渲染 + S5 三模式/双节奏 (2026-08-08)
 *
 * R1 (2026-08-08) 保留: 不再"一次建完整章"。初始只建首屏 BATCH, 底部挂 IntersectionObserver
 * 哨兵, 滚到哪渲染到哪; ensureRendered(index) 是唯一"补渲染到目标句"入口。
 * P0 (2026-08-04) 保留: 词级高亮用 words[wordIndex].seg_idx 定位 DOM; 每句缓存 seg_idx → bubble。
 *
 * S5 新增:
 *   - 模式感知: 'guess'(先答后核) / 'silent'(静默正文) / 'bench'(对照台), 建块与高亮走不同路径
 *   - 当前句锚点 setCurrentSentence: 控件常显 + 提示行 + 揭示/细痕策略 (策略来自 ReaderState)
 *   - 对照台节奏线: 句成为当前句时一次性预测量 offsetLeft/Width, 播放期只写 transform (性能 §6)
 *   - 压暗: pace/blind 通过容器 data 属性走纯 CSS (opacity 合成层, 不逐帧改色)
 */
(function (global) {
  'use strict';

  const INITIAL_BATCH = 50;   // 首屏句数
  const SCROLL_BATCH = 300;   // 哨兵触发时补建的句数

  class ReaderRenderer {
    constructor(rootElement) {
      this.root = rootElement;
      this.contentArea = null;
      this.granularity = 'sentence'; // 'sentence' | 'word'
      this.mode = 'guess';
      this._blockCache = new Map();  // 句下标 → { block, bubbles, ab }
      this._activeSentence = -1;     // 朗读中的句 (句底色)
      this._activeWordSeg = -1;      // 朗读中的词 (词底色)
      this._activeWordSentence = -1; // 词底色所在句 (跨句清理用)
      this._activeSweepSeg = -1;     // 节奏线当前段 (bench 词级)
      this._current = -1;            // 当前句锚点
      this.sentences = [];
      this.state = null;             // ReaderState 实例 (view 注入, 供揭示/细痕策略)
      this.handlers = null;
      this._sentinel = null;
      this._observer = null;
      this._renderedUpTo = -1;
      this.images = [];
      this._pendingImages = Object.create(null);
      this.basePath = '';
    }

    /** 整章渲染 / 重渲染 (模式切换时 view 复用本实例重调)。resolve 时首屏已建好。 */
    render(state, handlers) {
      const { sentences, mode = 'guess', currentIndex = -1 } = state;
      this.sentences = sentences || [];
      this.handlers = handlers;
      this.mode = mode;
      this._savedSet = state.savedSet || new Set();
      this._bookmarkIndices = state.bookmarkIndices || new Set();
      this._highlights = state.highlights || [];
      this._verifiedSet = state.verifiedSet || new Set();
      this.state = state.readerState || this.state;

      // 清空旧树 (模式切换重渲染)
      this.root.innerHTML = '';
      this._blockCache.clear();
      this._activeSentence = -1;
      this._activeWordSeg = -1;
      this._activeWordSentence = -1;
      this._activeSweepSeg = -1;
      this._renderedUpTo = -1;
      this._pendingImages = Object.create(null);
      this._disposeSentinel();

      const container = document.createElement('div');
      container.className = 'reader-container';
      const content = document.createElement('div');
      content.className = 'reader-content';
      content.dataset.mode = mode;
      this.contentArea = content;
      container.appendChild(content);
      this.root.appendChild(container);

      if (!this.sentences || this.sentences.length === 0) {
        this.renderEmptyState(content);
        return Promise.resolve({ contentArea: content });
      }

      this.images = (state.images || []).sort((a, b) => a.at - b.at);
      this._pendingImages = Object.create(null);
      this.images.forEach(img => {
        const key = String(img.at);
        if (!this._pendingImages[key]) this._pendingImages[key] = [];
        this._pendingImages[key].push(img);
      });

      this._ensureRenderedUpTo(Math.min(INITIAL_BATCH, this.sentences.length) - 1);
      this._attachSentinel(content);

      // 建完后把锚点句置为当前 (渐进渲染下当前句可能未建, 先记 index, 建到它时再应用)
      this._current = currentIndex;
      const cur = this._blockCache.get(currentIndex);
      if (cur && cur.ab) this._applyCurrent(cur, currentIndex);
      return Promise.resolve({ contentArea: content });
    }

    renderEmptyState(container) {
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:40px 20px; color:#999; text-align:center;';
      hint.textContent = '没有内容';
      container.appendChild(hint);
    }

    /** 底部哨兵: 进入视口 → 再建一批。全书建完自动断开。 */
    _attachSentinel(content) {
      const sentinel = document.createElement('div');
      sentinel.className = 'render-sentinel';
      sentinel.style.height = '1px';
      content.appendChild(sentinel);
      this._sentinel = sentinel;
      if (typeof IntersectionObserver === 'undefined') return;
      const self = this;
      this._observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (self._renderedUpTo >= self.sentences.length - 1) {
              self._disposeSentinel();
              continue;
            }
            self._ensureRenderedUpTo(
              Math.min(self._renderedUpTo + SCROLL_BATCH, self.sentences.length - 1)
            );
          }
        },
        { root: null, rootMargin: '400px 0px' }
      );
      this._observer.observe(sentinel);
    }

    _disposeSentinel() {
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      if (this._sentinel && this._sentinel.parentNode) {
        this._sentinel.parentNode.removeChild(this._sentinel);
      }
      this._sentinel = null;
    }

    /** 唯一的"补渲染到目标句"入口 (搜索/书签/播放定位)。 */
    ensureRendered(targetIndex) {
      const ranges = AiduRenderPlan.renderRanges(
        this._renderedUpTo, targetIndex, SCROLL_BATCH, this.sentences.length
      );
      if (ranges.length === 0) return Promise.resolve();
      const self = this;
      self._ensureRenderedUpTo(ranges[0].to);
      if (ranges.length === 1) return Promise.resolve();
      return new Promise((resolve) => {
        let i = 1;
        const buildNext = () => {
          if (i >= ranges.length) { resolve(); return; }
          self._ensureRenderedUpTo(ranges[i].to);
          i++;
          requestAnimationFrame(buildNext);
        };
        requestAnimationFrame(buildNext);
      });
    }

    _ensureRenderedUpTo(upTo) {
      if (upTo < 0) return;
      const ranges = AiduRenderPlan.renderRanges(
        this._renderedUpTo, upTo, SCROLL_BATCH, this.sentences.length
      );
      for (const r of ranges) {
        for (let i = r.from; i <= r.to; i++) {
          this._buildBlock(i);
        }
      }
    }

    _buildBlock(index) {
      const sentence = this.sentences[index];
      const block = AtomicBlock.create(sentence, index, {
        onPlay: this.handlers.onPlay,
        onSelect: this.handlers.onSelect,
        onBubbleClick: this.handlers.onBubbleClick,
        onBookmark: this.handlers.onBookmark,
        onFollowToggle: this.handlers.onFollowToggle,
        onRevealToggle: this.handlers.onRevealToggle,
      }, {
        mode: this.mode,
        current: index === this._current,
        savedSet: this._savedSet,
        bookmarkIndices: this._bookmarkIndices,
        highlights: this._highlights,
        verifiedSet: this._verifiedSet,
      });

      const pending = this._pendingImages[index];
      if (pending) {
        this._pendingImages[index] = null;
        pending.forEach(img => {
          const fig = document.createElement('figure');
          fig.className = 'reader-figure';
          const imgEl = document.createElement('img');
          imgEl.className = 'reader-figure-img';
          imgEl.alt = '';
          imgEl.loading = 'lazy';
          fig.appendChild(imgEl);
          this._loadFigure(img, imgEl);
          if (this._sentinel && this._sentinel.parentNode) {
            this.contentArea.insertBefore(fig, this._sentinel);
          } else {
            this.contentArea.appendChild(fig);
          }
        });
      }
      if (this._sentinel && this._sentinel.parentNode) {
        this.contentArea.insertBefore(block, this._sentinel);
      } else {
        this.contentArea.appendChild(block);
      }
      const bubbles = new Map();
      block.querySelectorAll('.bubble[data-seg-idx]').forEach(b => {
        const idx = parseInt(b.dataset.segIdx, 10);
        if (!Number.isNaN(idx)) bubbles.set(idx, b);
      });
      this._blockCache.set(index, { block, bubbles, ab: block._ab });
      this._renderedUpTo = Math.max(this._renderedUpTo, index);
      // 锚点句是渐进补建出来的: 建好即应用当前态
      if (index === this._current && block._ab) {
        this._applyCurrent(this._blockCache.get(index), index);
      }
    }

    /** F26 (2026-08-08): data:image/* 不是合法 MIME, 按扩展名给真实类型 (CSP 也已放行 data:) */
    _mimeForFile(file) {
      const ext = String(file || '').split('.').pop().toLowerCase();
      return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
    }

    _loadFigure(img, imgEl) {
      const b64 = img && img._data_b64;
      if (b64) {
        imgEl.src = 'data:' + this._mimeForFile(img.file) + ';base64,' + b64;
        return;
      }
      if (!this.basePath || !img || !img.file) return;
      AiduLibraryService.readImage(this.basePath, img.file).then((res) => {
        if (!res.ok || !res.data) return;
        const data = res.data.data_b64;
        if (data) imgEl.src = 'data:' + this._mimeForFile(img.file) + ';base64,' + data;
      });
    }

    _attachFigureLoading() {
      if (!this.images || !this.basePath) return;
      this.images.forEach((img) => {
        if (img._data_b64) return;
        AiduLibraryService.readImage(this.basePath, img.file).then((res) => {
          if (res.ok && res.data) img._data_b64 = res.data.data_b64;
        });
      });
    }

    setBasePath(basePath) {
      this.basePath = basePath || '';
      this._attachFigureLoading();
    }

    // ---- 当前句锚点 ----

    setCurrentSentence(index) {
      if (index === this._current) {
        // 同句 (可能因重建需要重铺支撑态)
        const c = this._blockCache.get(index);
        if (c && c.ab) this._applyCurrent(c, index);
        return;
      }
      const old = this._current;
      this._current = index;
      if (old >= 0) {
        const c = this._blockCache.get(old);
        if (c && c.ab) {
          c.ab.unsetCurrent();
          // 离开已揭示句 → 折叠成细痕 (先答后核)。必须同时把 ReaderState 的
          // _revealed 摘掉, 否则再回来时 supportFor 仍判定 revealed, 会错误重新展开。
          if (this.mode === 'guess' && c.ab.isRevealed()) {
            if (this.state) this.state.collapse(old);
            c.ab.showSupport('scar');
            c.ab.setHint(this.state ? this.state.hintFor('guess', old) : '');
          }
          if (this.mode === 'bench' && c.ab.setSweepVisible) c.ab.setSweepVisible(false);
        }
      }
      if (index >= 0) {
        const c = this._blockCache.get(index);
        if (c && c.ab) {
          c.ab.setCurrent();
          this._applyCurrent(c, index);
        }
      }
    }

    _applyCurrent(cacheEntry, index) {
      const ab = cacheEntry.ab;
      ab.setCurrent();
      if (this.state) {
        ab.showSupport(this.state.supportFor(this.mode, index));
        ab.setHint(this.state.hintFor(this.mode, index));
      }
      // 对照台词级: 句子成为当前句时一次性预测量, 之后不再读布局
      if (this.mode === 'bench' && this.granularity === 'word') {
        ab.measureSweep();
        ab.setSweepVisible(true);
      } else if (ab.setSweepVisible) {
        ab.setSweepVisible(false);
      }
    }

    setBlockPlaying(index, v) {
      const c = this._blockCache.get(index);
      if (c && c.ab) c.ab.setPlaying(v);
    }

    setBlockFollow(index, v) {
      const c = this._blockCache.get(index);
      if (c && c.ab) c.ab.setFollow(v);
    }

    // ---- 朗读高亮 (60Hz rAF, 变化时才写) ----

    /**
     * granularity='word':
     *   guess/silent → 词底色 (--rd-reading-bg)
     *   bench        → 当前句下的节奏线 (sweep, 纯 transform)
     * granularity='sentence' → 句底色
     */
    highlightAt(currentTimeMs, sentences) {
      if (!this.contentArea) return;
      const si = AiduTimeline.findSentenceIndex(sentences, currentTimeMs);
      if (si >= 0 && si > this._renderedUpTo) {
        this.ensureRendered(si);
      }
      this._setSentenceActive(si);
      if (this.granularity === 'word') {
        const rel = si >= 0 ? currentTimeMs - sentences[si].audio.start_ms : -1;
        const words = si >= 0 ? (sentences[si].words || []) : [];
        const wi = AiduTimeline.findWordIndex(words, rel);
        const segIdx = (wi >= 0 && words[wi]) ? words[wi].seg_idx : -1;
        if (this.mode === 'bench') {
          this._setSweepActive(si, segIdx);
        } else {
          this._setWordActive(si, segIdx);
        }
      } else {
        this._setWordActive(-1, -1);
      }
    }

    _setSentenceActive(index) {
      if (index === this._activeSentence) return;
      if (this._activeSentence >= 0) {
        const prev = this._blockCache.get(this._activeSentence);
        if (prev) prev.block.classList.remove('sentence-reading');
      }
      this._activeSentence = index;
      if (index >= 0) {
        const cur = this._blockCache.get(index);
        if (cur) cur.block.classList.add('sentence-reading');
      }
    }

    _setWordActive(sentenceIndex, segIdx) {
      const cur = this._blockCache.get(sentenceIndex);
      if (!cur || !cur.ab) {
        this._clearWordReading();
        return;
      }
      if (segIdx === this._activeWordSeg && sentenceIndex === this._activeWordSentence) return;
      this._clearWordReading();
      this._activeWordSentence = sentenceIndex;
      this._activeWordSeg = segIdx;
      if (segIdx >= 0) cur.ab.setWordReading(segIdx);
    }

    /** 清掉"上一个词的底色"——必须按词自己记的句下标找, 不能用 sentence-bg 的 _activeSentence
        (它已被 highlightAt 先更新成新句, 用来清理会漏掉上一句残留的词底色)。 */
    _clearWordReading() {
      if (this._activeWordSentence >= 0 && this._activeWordSeg >= 0) {
        const prev = this._blockCache.get(this._activeWordSentence);
        if (prev && prev.ab) prev.ab.clearWordReading();
      }
      this._activeWordSeg = -1;
      this._activeWordSentence = -1;
    }

    /** 对照台节奏线: 只在当前句内动, 词变才写 transform */
    _setSweepActive(sentenceIndex, segIdx) {
      if (sentenceIndex !== this._current) return;
      const cur = this._blockCache.get(sentenceIndex);
      if (!cur || !cur.ab) return;
      if (segIdx !== this._activeSweepSeg) {
        this._activeSweepSeg = segIdx;
        cur.ab.setSweep(segIdx);
      }
    }

    setGranularity(g) {
      this.granularity = g;
      this._activeWordSeg = -1;
      this._activeWordSentence = -1;
      this._activeSweepSeg = -1;
      const cur = this._blockCache.get(this._current);
      if (cur && cur.ab) {
        if (this.mode === 'bench' && g === 'word') {
          cur.ab.measureSweep();
          cur.ab.setSweepVisible(true);
        } else if (cur.ab.setSweepVisible) {
          cur.ab.setSweepVisible(false);
        }
      }
    }
  }

  global.ReaderRenderer = ReaderRenderer;
})(window);
