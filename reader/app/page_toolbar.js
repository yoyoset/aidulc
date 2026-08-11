/**
 * app/page_toolbar.js —— 页头动作工具条 (L5, 2026-08-11)
 *
 * 三处页面头 (生词本 备份/恢复/导出 / 同步 立即同步/拉取合并/更多 / 模型与依赖
 * 扫描/添加) 曾共用 `.page-header { justify-content: space-between }`, 把标题和
 * 2~3 个按钮撑到整行两端, 中间巨大空白。根因是"按钮被 space-between 撑开", 不是
 * 三个独立 bug。这里做成一个共用工具条: 标题靠左, 动作按钮成组靠右, 组内间距固定
 * (gap: var(--md-sys-space-2))。新页面直接复用 build()。
 *
 * 用法: AiduPageToolbar.build('页面标题', [btn1, btn2]) → <div class="page-header">
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  global.AiduPageToolbar = {
    /**
     * @param {string} title 页面标题
     * @param {Array<HTMLElement>} buttons 动作按钮 (成组靠右, 组内 gap 固定)
     * @returns {HTMLElement} <div class="page-header"><h1>title</h1><div class="page-toolbar">...</div></div>
     */
    build(title, buttons) {
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, title));
      const toolbar = el('div', 'page-toolbar');
      (buttons || []).forEach((b) => toolbar.appendChild(b));
      header.appendChild(toolbar);
      return header;
    },
  };
})(window);
