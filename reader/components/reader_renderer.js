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
 */
(function (global) {
  'use strict';

  class ReaderRenderer {
    constructor(rootElement) {
      this.root = rootElement;
      this.contentArea = null;
      this.granularity = 'sentence'; // 'sentence' | 'word'
      this._blockCache = new Map();  // 句下标 → { block, bubbles: Map<segIdx, el> }
      this._activeSentence = -1;
      this._activeWordSeg = -1;
    }

    render(state, handlers) {
      const { sentences, showTranslations, savedSet, bookmarkIndices } = state;
      const container = document.createElement('div');
      container.className = 'reader-container';

      const content = document.createElement('div');
      content.className = 'reader-content';
      this.contentArea = content;

      if (!sentences || sentences.length === 0) {
        this.renderEmptyState(content);
      } else {
        this.renderSentences(content, sentences, showTranslations, savedSet, handlers, bookmarkIndices);
      }

      container.appendChild(content);
      this.root.appendChild(container);
      return { contentArea: content };
    }

    renderEmptyState(container) {
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:40px 20px; color:#999; text-align:center;';
      hint.textContent = '没有内容';
      container.appendChild(hint);
    }

    renderSentences(container, sentences, showTranslations, savedSet, handlers, bookmarkIndices) {
      sentences.forEach((sentence, index) => {
        const block = AtomicBlock.create(sentence, index, {
          onPlay: handlers.onPlay,
          onSelect: handlers.onSelect,
          onBubbleClick: handlers.onBubbleClick,
          onBookmark: handlers.onBookmark,
        }, {
          showTranslations,
          savedSet,
          bookmarkIndices,
        });
        container.appendChild(block);
        // 缓存句块内 seg_idx → bubble (P0: 避免 60Hz 全量查询)
        const bubbles = new Map();
        block.querySelectorAll('.bubble[data-seg-idx]').forEach(b => {
          const idx = parseInt(b.dataset.segIdx, 10);
          if (!Number.isNaN(idx)) bubbles.set(idx, b);
        });
        this._blockCache.set(index, { block, bubbles });
      });
    }

    /**
     * 高亮当前时间点(60Hz rAF 调用)。
     * granularity='word'   → 找词 → bubble.word-reading
     * granularity='sentence' → 找句 → atomic-block.sentence-reading
     */
    highlightAt(currentTimeMs, sentences) {
      if (!this.contentArea) return;
      if (this.granularity === 'word') {
        // 先定位句, 再只在该句内二分 (词时间是句内相对 ms)
        const si = AiduTimeline.findSentenceIndex(sentences, currentTimeMs);
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
