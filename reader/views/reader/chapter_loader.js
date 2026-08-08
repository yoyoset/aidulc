/**
 * views/reader/chapter_loader.js —— 按需拉取章节内容 (R2 拆分自 reader_view.js)
 * 单一职责: loadBookpackChapter 的封装 + 竞态防护 (_chapterGen 那套)。
 * 调用方传入 load() 每轮必须自增的 generation; resolve 时若 generation 已变,
 * 丢弃这次结果 (用户在等待期间又切了章)。对外只暴露 load, 不管 DOM/渲染。
 */
(function (global) {
  'use strict';

  class ChapterLoader {
    constructor() {
      this._chapterGen = 0;
      this._loadingChapter = null; // 防重入: 同章加载中跳过
    }

    /** 自增计数 (切章/离开时调用), 使 in-flight 的 load 结果作废 */
    invalidate() {
      this._chapterGen++;
      this._loadingChapter = null;
    }

    /**
     * 拉取一章完整内容。返回 Promise<{ok:true, data} | {ok:false, error}>。
     * @param {string} bookId
     * @param {number} chapterIndex
     * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
     */
    async load(bookId, chapterIndex) {
      // 修复: 防重入 (同章加载中跳过 — 无限循环防护)
      if (this._loadingChapter === chapterIndex) return null;
      this._loadingChapter = chapterIndex;
      this._chapterGen++;
      const gen = this._chapterGen;

      const res = await AiduLibraryService.loadBookpackChapter(bookId, chapterIndex);
      if (gen !== this._chapterGen) return null; // 加载期间又切了章, 丢弃这次结果
      this._loadingChapter = null;
      return res;
    }
  }

  global.ChapterLoader = ChapterLoader;
})(window);
