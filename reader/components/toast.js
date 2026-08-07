/**
 * components/toast.js —— 轻提示 (苹果级: 成功/失败/信息, 自动消失, 可堆叠)
 * 用法: AiduToast.show('已保存', 'success' | 'error' | 'info')
 */
(function (global) {
  'use strict';

  let container = null;

  function ensureContainer() {
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function show(message, type) {
    const c = ensureContainer();
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = message;
    c.appendChild(el);
    // 动画: 进入
    requestAnimationFrame(() => el.classList.add('toast-in'));
    // 自动消失 2.5s
    setTimeout(() => {
      el.classList.remove('toast-in');
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 250);
    }, 2500);
  }

  global.AiduToast = { show };
})(window);
