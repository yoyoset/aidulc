/**
 * views/reader/search.js —— 全书搜索与跳转 (R2 拆分自 reader_view.js)
 * 单一职责: 构建搜索索引 + 跨章节搜索 + 命中跳转 (切章/滚动定位)。
 * 依赖 SearchIndex (core, 纯逻辑); 通过构造时传入的 deps 与宿主协作。
 */
(function (global) {
  'use strict';

  class ReaderSearch {
    /**
     * @param {object} deps
     *   getChapterIndex(): () => number 当前章
     *   loadChapter(index): async (index) => void 切章后加载 (等待渲染完)
     *   setSentenceVisible(index): async (index) => void 滚动定位到句块
     *   setStatus(text): (text) => void 状态行
     */
    constructor(deps) {
      this.deps = deps;
      this._searchIndex = new SearchIndex();
    }

    /** 全书索引 (一次构建; bookpack.chapters[*].sentences 元信息就够) */
    build(chapters) {
      this._searchIndex.build(chapters);
    }

    async search(query) {
      if (!query) return;
      // G3: 用全书索引 (跨章节搜索), 不线性扫当前章
      const hits = this._searchIndex.search(query);
      if (!hits.length) {
        this.deps.setStatus(`未找到: ${query}`);
        return;
      }
      const first = hits[0];
      if (first.chapter !== this.deps.getChapterIndex()) {
        // 命中在其它章节 → 切章; 章节内容异步按需拉取, 必须等渲染完再定位
        await this.deps.loadChapter(first.chapter);
      }
      await this.deps.setSentenceVisible(first.index);
      this.deps.setStatus(`找到 ${hits.length} 处: ${first.text.slice(0, 60)}…`);
    }
  }

  global.ReaderSearch = ReaderSearch;
})(window);
