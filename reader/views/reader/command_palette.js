/**
 * views/reader/command_palette.js —— 轻量命令面板 (S5)
 * 顶栏撤销后, 搜索/书签的入口退到 Ctrl+K 命令面板 (设计 §7 "命令入口(搜索/书签)")。
 * 面板内部设计(搜索/书签的面板本身)本轮未做, 这里只提供入口与调用方式:
 *   - 输入即搜索 (回车跳转)
 *   - 快捷按钮: 书签面板
 */
(function (global) {
  'use strict';

  class CommandPalette {
    /**
     * @param {object} deps
     *   onSearch(query): 跳转到首个命中 (复用 ReaderSearch.search)
     *   onShowBookmarks(): 打开书签面板
     *   onShowHighlights(): 打开摘录面板 (M7 R17)
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-cmd';
      this._open = false;

      const box = document.createElement('div');
      box.className = 'rd-cmd-box';

      const input = document.createElement('input');
      input.className = 'rd-cmd-input';
      input.placeholder = '搜索本书… (Enter 跳转)';
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          const q = e.target.value;
          if (q) this.deps.onSearch(q);
        }
        if (e.key === 'Escape') this.close();
      };
      this.input = input;
      box.appendChild(input);

      const actions = document.createElement('div');
      actions.className = 'rd-cmd-actions';
      const bm = document.createElement('button');
      bm.className = 'rd-cmd-btn';
      bm.textContent = '📋 书签面板';
      bm.onclick = () => { this.close(); this.deps.onShowBookmarks(); };
      actions.appendChild(bm);
      const hl = document.createElement('button');
      hl.className = 'rd-cmd-btn';
      hl.textContent = '📕 摘录';
      hl.onclick = () => { this.close(); this.deps.onShowHighlights && this.deps.onShowHighlights(); };
      actions.appendChild(hl);
      const stats = document.createElement('button');
      stats.className = 'rd-cmd-btn';
      stats.textContent = '📊 本周阅读';
      stats.onclick = () => { this.close(); this.deps.onShowReadingStats && this.deps.onShowReadingStats(); };
      actions.appendChild(stats);
      box.appendChild(actions);

      const hint = document.createElement('div');
      hint.className = 'rd-cmd-hint';
      hint.textContent = 'Esc 关闭';
      box.appendChild(hint);

      this.el.appendChild(box);
      this.el.onclick = (e) => { if (e.target === this.el) this.close(); };
    }

    toggle() {
      if (this._open) this.close();
      else this.open();
    }

    open() {
      if (!this.el.parentNode) document.body.appendChild(this.el);
      this._open = true;
      this.input.value = '';
      this.input.focus();
    }

    close() {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this._open = false;
    }

    isOpen() {
      return this._open;
    }
  }

  global.CommandPalette = CommandPalette;
})(window);
