/**
 * views/reader/silent_card.js —— 静默正文模式的支撑卡片 (S5, 设计 §2.1/§3)
 * 正文只有英文。按 T 从当前句下方浮出一张卡片 (同一时刻只有一张), ESC 收起。
 * 译文永远默认不在场, 浮层卡片完全离场——不需要三行常驻。
 */
(function (global) {
  'use strict';

  class SilentCard {
    constructor(deps) {
      this.deps = deps; // { getCurrentSentence() }
      this.el = document.createElement('div');
      this.el.className = 'rd-silent-card';
      this.origEl = document.createElement('div');
      this.origEl.className = 'rd-silent-orig';
      this.trEl = document.createElement('div');
      this.trEl.className = 'rd-silent-tr';
      this.exEl = document.createElement('div');
      this.exEl.className = 'rd-silent-ex';
      this.el.append(this.origEl, this.trEl, this.exEl);
      this._open = false;
    }

    toggle() {
      if (this._open) this.hide();
      else this.show();
    }

    show() {
      this.refresh();
      document.body.appendChild(this.el);
      // 定位到当前句下方
      const idx = this.deps.getCurrentIndex && this.deps.getCurrentIndex();
      if (idx != null) {
        const block = document.querySelector(`.atomic-block[data-index="${idx}"]`);
        if (block) {
          const r = block.getBoundingClientRect();
          this.el.style.top = (r.bottom + 8) + 'px';
          this.el.style.left = Math.max(16, r.left) + 'px';
        }
      }
      this._open = true;
    }

    hide() {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this._open = false;
    }

    isOpen() {
      return this._open;
    }

    /** 当前句变化时刷新内容 (卡片还开着) */
    refresh() {
      const s = this.deps.getCurrentSentence();
      if (!s) return;
      this.origEl.textContent = s.original_text || '';
      this.trEl.textContent = s.translation || '';
      this.exEl.textContent = s.explanation || '';
      const idx = this.deps.getCurrentIndex && this.deps.getCurrentIndex();
      if (idx != null && this._open) {
        const block = document.querySelector(`.atomic-block[data-index="${idx}"]`);
        if (block) {
          const r = block.getBoundingClientRect();
          this.el.style.top = (r.bottom + 8) + 'px';
          this.el.style.left = Math.max(16, r.left) + 'px';
        }
      }
    }
  }

  global.SilentCard = SilentCard;
})(window);
