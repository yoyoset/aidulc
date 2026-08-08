/**
 * reader_renderer.js —— 从 aidu reader_renderer.js 剥离适配
 * 剥离点: styles.module.css → 全局类名; t() → 内置; 进度条保留; byline 保留
 *
 * P0 修复 (审查确认, 2026-08-04):
 * - 词级高亮必须用 words[wordIndex].seg_idx 定位 DOM, 不能把 words[] 数组下标
 *   当 seg_idx (words[] 是稀疏索引, 标点段不产生 timing, 数组位置 ≠ 物理段下标,
 *   第二句的 it 因此错位)。
 * - 为每个句块缓存 seg_idx → bubble 的 Map, 不在 60Hz rAF 里全量 querySelectorAll。
 * - 句级高亮同样用缓存, 不用每帧全量查询。
 *
 * R1 修复 (渐进式渲染, 2026-08-08):
 * - 不再"一次建完整章"——那在 5351 句的大章里要建 10 万+ DOM 节点, 即使分批也
 *   会把长章首屏拖到全建完。改成初始只建首屏 BATCH, 底部挂 IntersectionObserver
 *   哨兵, 滚到哪渲染到哪; 已建的句块不回收(渐进式, 用户选择)。
 * - ensureRendered(index) 是唯一的"补渲染到目标句"入口: 搜索命中/书签跳转/
 *   _playFrom/highlightAt 定位到未渲染的句时, 一律先 ensureRendered 再操作,
 *   "DOM 可能还不存在"这件事不再散落在调用点各自判断。
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
      this._blockCache = new Map();  // 句下标 → { block, bubbles: Map<segIdx, el> }
      this._activeSentence = -1;
      this._activeWordSeg = -1;
      this.sentences = [];
      this.handlers = null;
      this._sentinel = null;   // 底部哨兵元素
      this._observer = null;   // IntersectionObserver
      this._renderedUpTo = -1; // 已建到哪个句下标 (-1 = 未建任何块)
      this.images = [];        // R4: [{file, at}]
      this._pendingImages = Object.create(null); // 句下标 → [ChapterImage]
      this.basePath = '';      // R4: 插图读取用
    }

    /**
     * 返回 Promise, resolve 时首屏已建好(不是整章!)。之后由滚动哨兵 / ensureRendered
     * 补建剩余句子。resolve 的值带 contentArea(兼容旧调用)。
     */
    render(state, handlers) {
      const { sentences, showTranslations, savedSet, bookmarkIndices } = state;
      this.sentences = sentences || [];
      this.handlers = handlers;
      this._showTranslations = showTranslations;
      this._savedSet = savedSet || new Set();
      this._bookmarkIndices = bookmarkIndices || new Set();

      const container = document.createElement('div');
      container.className = 'reader-container';

      const content = document.createElement('div');
      content.className = 'reader-content';
      this.contentArea = content;
      container.appendChild(content);
      this.root.appendChild(container);

      if (!this.sentences || this.sentences.length === 0) {
        this.renderEmptyState(content);
        return Promise.resolve({ contentArea: content });
      }

      // R4: 插图列表 [{file, at}] — at = 渲染在第 at 句之前
      this.images = (state.images || []).sort((a, b) => a.at - b.at);
      // 按 at 分组: 句下标 → 该句前的图片列表 (一张图可能 at 指向同一句)
      this._pendingImages = Object.create(null);
      this.images.forEach(img => {
        const key = String(img.at);
        if (!this._pendingImages[key]) this._pendingImages[key] = [];
        this._pendingImages[key].push(img);
      });

      // 首屏 + 哨兵 (哨兵必须在首屏之后挂, 否则 Observer 看不到内容底)
      this._ensureRenderedUpTo(Math.min(INITIAL_BATCH, this.sentences.length) - 1);
      this._attachSentinel(content);

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

      if (typeof IntersectionObserver === 'undefined') return; // 无 IO 环境(测试/旧 webview)
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

    /**
     * 唯一的"补渲染到目标句"入口。跳到未渲染的句(搜索/书签/播放定位)时先调这个。
     * 返回 Promise, resolve 时目标句 DOM 已存在。
     * 远距离跳转分帧补建(避免一次同步建上万 DOM 冻帧); 首屏内则同步补建。
     */
    ensureRendered(targetIndex) {
      const ranges = AiduRenderPlan.renderRanges(
        this._renderedUpTo, targetIndex, SCROLL_BATCH, this.sentences.length
      );
      if (ranges.length === 0) return Promise.resolve();
      const self = this;
      // 同步补建第一片(远跳时首片先落, 视觉立即有反馈), 余片让帧
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

    /** 同步建句块到 upTo (含)。不拆帧, 只被首屏/哨兵/ensureRendered 的第一片使用。 */
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
      }, {
        showTranslations: this._showTranslations,
        savedSet: this._savedSet,
        bookmarkIndices: this._bookmarkIndices,
      });
      // R4: 插图按 at 插到对应句块之前 (多个图都在同一句前 → 依次紧贴)
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
      // 哨兵之前插入: 保持"新块在哨兵上方", 哨兵永远位于内容末尾
      if (this._sentinel && this._sentinel.parentNode) {
        this.contentArea.insertBefore(block, this._sentinel);
      } else {
        this.contentArea.appendChild(block);
      }
      // 缓存句块内 seg_idx → bubble (P0: 避免 60Hz 全量查询)
      const bubbles = new Map();
      block.querySelectorAll('.bubble[data-seg-idx]').forEach(b => {
        const idx = parseInt(b.dataset.segIdx, 10);
        if (!Number.isNaN(idx)) bubbles.set(idx, b);
      });
      this._blockCache.set(index, { block, bubbles });
      this._renderedUpTo = Math.max(this._renderedUpTo, index);
    }

    _loadFigure(img, imgEl) {
      // 图片异步加载: 加载完成才替换 src, 避免大量 base64 阻塞渲染队列
      const b64 = img && img._data_b64;
      if (b64) {
        imgEl.src = 'data:image/*;base64,' + b64;
        return;
      }
      if (!this.basePath || !img || !img.file) return;
      AiduLibraryService.readImage(this.basePath, img.file).then((res) => {
        if (!res.ok || !res.data) return;
        const data = res.data.data_b64;
        if (data) imgEl.src = 'data:image/*;base64,' + data;
      });
    }

    _attachFigureLoading() {
      // basePath 注入后, 预取整章图片 (渐进渲染下图与正文同批建; 加载是异步的,
      // 不预取的话用户滚到图的位置才发起 IPC, 会有明显闪白)。
      if (!this.images || !this.basePath) return;
      // 图片不多 (一本几十张), 全部预取 base64 缓存在 this.images 里
      this.images.forEach((img) => {
        if (img._data_b64) return;
        AiduLibraryService.readImage(this.basePath, img.file).then((res) => {
          if (res.ok && res.data) img._data_b64 = res.data.data_b64;
        });
      });
    }

    /** 供宿主注入 basePath (书打开后才有), 触发图片预取 */
    setBasePath(basePath) {
      this.basePath = basePath || '';
      this._attachFigureLoading();
    }

    /**
     * 高亮当前时间点(60Hz rAF 调用)。
     * granularity='word'   → 找词 → bubble.word-reading
     * granularity='sentence' → 找句 → atomic-block.sentence-reading
     * R1: 定位到的句若尚未渲染, 先 ensureRendered 再高亮(播放跳过未渲染段时
     * 高亮不会扑空, 且不会阻塞 rAF——远跳分帧, 高亮随补建逐帧跟上)。
     */
    highlightAt(currentTimeMs, sentences) {
      if (!this.contentArea) return;
      if (this.granularity === 'word') {
        // 先定位句, 再只在该句内二分 (词时间是句内相对 ms)
        const si = AiduTimeline.findSentenceIndex(sentences, currentTimeMs);
        if (si >= 0 && si > this._renderedUpTo) {
          this.ensureRendered(si); // fire-and-forget, 不阻塞 rAF
        }
        this._setSentenceActive(si);
        if (si >= 0) {
          const rel = currentTimeMs - sentences[si].audio.start_ms;
          const words = sentences[si].words || [];
          const wi = AiduTimeline.findWordIndex(words, rel);
          // P0: 用 words[wi].seg_idx 而非 wi (稀疏索引错位修复)
          const segIdx = (wi >= 0 && words[wi]) ? words[wi].seg_idx : -1;
          this._setWordActive(si, segIdx);
        }
      } else {
        const si = AiduTimeline.findSentenceIndex(sentences, currentTimeMs);
        if (si >= 0 && si > this._renderedUpTo) {
          this.ensureRendered(si); // fire-and-forget
        }
        this._setSentenceActive(si);
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
      if (!cur) {
        if (this._activeWordSeg >= 0) {
          const prev = this._blockCache.get(this._activeSentence);
          if (prev && prev.bubbles.has(this._activeWordSeg)) {
            prev.bubbles.get(this._activeWordSeg).classList.remove('word-reading');
          }
          this._activeWordSeg = -1;
        }
        return;
      }
      if (segIdx === this._activeWordSeg) return;
      if (this._activeWordSeg >= 0) {
        const prev = this._blockCache.get(this._activeSentence);
        if (prev && prev.bubbles.has(this._activeWordSeg)) {
          prev.bubbles.get(this._activeWordSeg).classList.remove('word-reading');
        }
      }
      this._activeWordSeg = segIdx;
      if (segIdx >= 0 && cur.bubbles.has(segIdx)) {
        cur.bubbles.get(segIdx).classList.add('word-reading');
      }
    }

    setGranularity(g) {
      this.granularity = g;
      if (this._activeWordSeg >= 0) {
        const prev = this._blockCache.get(this._activeSentence);
        if (prev && prev.bubbles.has(this._activeWordSeg)) {
          prev.bubbles.get(this._activeWordSeg).classList.remove('word-reading');
        }
      }
      this._activeWordSeg = -1;
    }
  }

  global.ReaderRenderer = ReaderRenderer;
})(window);
