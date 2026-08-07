/**
 * core/search_index.js —— 章节搜索索引 (G3: 避免每次从头线性扫描)
 * 构建: {chapter, sentenceIndex, text} 的扁平列表 + 小写映射, 一次构建多次查询。
 */
(function (global) {
  'use strict';

  class SearchIndex {
    constructor() {
      this.items = [];      // [{chapter, index, text}]
      this.normalized = []; // 小写文本
    }

    /** 全书 (或当前章) 句子索引 */
    build(chapters) {
      this.items = [];
      this.normalized = [];
      (chapters || []).forEach((ch, ci) => {
        (ch.sentences || []).forEach((s, si) => {
          if (s && s.original_text) {
            this.items.push({ chapter: ci, index: si, text: s.original_text });
            this.normalized.push(s.original_text.toLowerCase());
          }
        });
      });
    }

    /**
     * 搜索: 返回所有命中 [{chapter, index, text}]
     * 首次 100 条内用 indexOf; 大量命中时用 gather 一次遍历。
     */
    search(query) {
      const q = String(query || '').toLowerCase().trim();
      if (!q) return [];
      const hits = [];
      for (let i = 0; i < this.normalized.length; i++) {
        if (this.normalized[i].includes(q)) {
          hits.push(this.items[i]);
          if (hits.length >= 500) break; // 防爆
        }
      }
      return hits;
    }

    /** 首个命中 (跳转用) */
    first(query) {
      const hits = this.search(query);
      return hits.length ? hits[0] : null;
    }
  }

  global.SearchIndex = SearchIndex;
})(window);
