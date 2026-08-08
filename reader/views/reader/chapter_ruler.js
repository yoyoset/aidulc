/**
 * views/reader/chapter_ruler.js —— 章节尺 (S5, 设计 §2.6/§3)
 * 最左 26px 一列刻度, 整本书压成一列; 当前章加高加色; hover 出章名; 点刻度跳章。
 * 顶栏的下拉菜单就此退役 (几十章的定位不再靠下拉)。
 */
(function (global) {
  'use strict';

  class ChapterRuler {
    /**
     * @param {object} deps
     *   chapters: [{title}] 书的所有章元信息
     *   currentIndex: number
     *   onSelect(index): 点刻度跳章
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-ruler';
      this._ticks = [];
      this._current = deps.currentIndex || 0;
      this._render();
    }

    _render() {
      this.el.innerHTML = '';
      this._ticks = [];
      const chapters = this.deps.chapters || [];
      chapters.forEach((c, i) => {
        const tick = document.createElement('button');
        tick.className = 'rd-ruler-tick';
        tick.title = c.title || ('第' + (i + 1) + '章');
        tick.dataset.index = i;
        tick.onclick = () => this.deps.onSelect && this.deps.onSelect(i);
        this.el.appendChild(tick);
        this._ticks.push(tick);
      });
      this._applyCurrent();
    }

    /** 书包加载完成后再补章节 (render 在 open 之前跑, 书元信息可能还没到) */
    setChapters(chapters) {
      if (!chapters || this._ticks.length === chapters.length) return;
      this.deps.chapters = chapters;
      this._render();
    }

    setCurrent(index) {
      this._current = index;
      this._applyCurrent();
    }

    _applyCurrent() {
      this._ticks.forEach((t, i) => {
        t.classList.toggle('current', i === this._current);
      });
    }
  }

  global.ChapterRuler = ChapterRuler;
})(window);
