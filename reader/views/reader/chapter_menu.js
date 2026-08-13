/**
 * views/reader/chapter_menu.js —— 章节下拉菜单 (UX6 #5, 2026-08-13)
 *
 * 顶栏章名可点 → 弹出全部章节列表 (可滚动), 当前章高亮, 点选跳章。
 * 与左侧章节尺互补: 尺 = 概览定位 (整本压成一列, 章多时 3px 刻度点不准/放不下);
 * 菜单 = 精确选章 (几十章时看章名逐条点)。
 *
 * 生命周期: open() 挂 body, close() 移除; Esc / 点外部 / 点外部章节尺刻度关闭。
 * 挂载: reader_view 在 render 时把 this.titleEl 交给它做触发点。
 */
(function (global) {
  'use strict';

  class ChapterMenu {
    /**
     * @param {object} deps
     *   triggerEl: 顶栏章名元素 (点击弹出)
     *   getChapters(): () => [{title}] 全部章元信息
     *   getCurrentIndex(): () => number 当前章下标
     *   onSelect(index): 点选跳章
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-chapter-menu';
      this._open = false;
      this._onKey = null;
      this._onDocClick = null;

      const trigger = deps.triggerEl;
      trigger.classList.add('rd-title-btn');
      trigger.title = '打开章节列表';
      trigger.onclick = (e) => {
        e.stopPropagation();
        this.toggle();
      };

      this.el.onclick = (e) => {
        if (e.target === this.el) this.close();
      };
    }

    toggle() {
      if (this._open) this.close();
      else this.open();
    }

    open() {
      if (!this.deps.triggerEl) return;
      this._renderList();
      if (!this.el.parentNode) document.body.appendChild(this.el);
      this._open = true;
      // Esc 关闭 + 点外部关闭 (document 级, 触发点在元素自身的 stopPropagation 已挡住)
      this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
      this._onDocClick = () => { if (this._open) this.close(); };
      document.addEventListener('keydown', this._onKey);
      // setTimeout 0: 让这次的点击事件先完成, 否则点击触发点自身会立即触发 doc click 关掉
      setTimeout(() => document.addEventListener('click', this._onDocClick), 0);
    }

    close() {
      if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
      if (this._onDocClick) { document.removeEventListener('click', this._onDocClick); this._onDocClick = null; }
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this._open = false;
    }

    isOpen() { return this._open; }

    _renderList() {
      this.el.innerHTML = '';
      const chapters = this.deps.getChapters() || [];
      const current = this.deps.getCurrentIndex() || 0;
      const list = document.createElement('div');
      list.className = 'rd-chapter-menu-list';
      chapters.forEach((c, i) => {
        const item = document.createElement('button');
        item.className = 'rd-chapter-menu-item' + (i === current ? ' current' : '');
        item.textContent = (i + 1) + '. ' + (c.title || ('第' + (i + 1) + '章'));
        item.onclick = () => {
          this.close();
          if (i !== current) this.deps.onSelect && this.deps.onSelect(i);
        };
        list.appendChild(item);
      });
      this.el.appendChild(list);
    }

    /** 外部 (如设置浮层/命令面板) 打开时主动收起, 防叠加 */
    closeExternal() {
      if (this._open) this.close();
    }
  }

  global.ChapterMenu = ChapterMenu;
})(window);
