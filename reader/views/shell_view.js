/**
 * views/shell_view.js —— 应用壳: 顶部导航 + 路由容器 + 全局错误条
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class ShellView {
    constructor(app) {
      this.app = app;       // #app 根元素
      this.router = null;   // 由 setRouter 补接 (main.js: render 后建 router)
      this.navEl = null;
      this.errorEl = null;
    }

    /** 绑定路由 (main.js 先 render 后创建 router, 这里补接) */
    setRouter(router) {
      this.router = router;
    }

    render() {
      this.app.innerHTML = '';

      // 阶段6 设计交付 §01/§10 item 3: 三层导航 —— 左「我的书·生词本」右「导入·处理中(n)」
      this.navEl = el('nav', 'app-nav');
      const brand = el('span', 'app-brand', 'aidulc 精读工作站');
      const left = el('div', 'app-nav-links app-nav-left');
      const items = [
        ['library', '我的书'],
        ['vocab', '生词本'],
      ];
      items.forEach(([route, label]) => {
        const a = el('button', 'app-nav-link', label);
        a.dataset.route = route;
        a.onclick = () => this.router.navigate(route);
        left.appendChild(a);
      });
      const right = el('div', 'app-nav-links app-nav-right');
      // 导入: 入口指向书库的导入卡片 (原书导入在 library_view)
      const importBtn = el('button', 'app-nav-link', '导入');
      importBtn.dataset.route = 'library';
      importBtn.onclick = () => {
        this.router.navigate('library');
        // 焦点落到导入卡, 让用户下一步明确
        const card = document.querySelector('.import-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      right.appendChild(importBtn);
      // 处理中(n): 徽章常驻, 无任务显示 0 (设计: 入口不消失, 只去徽章 → 常驻 0)
      const prepBtn = el('button', 'app-nav-link', '处理中');
      prepBtn.dataset.route = 'prep';
      prepBtn.onclick = () => this.router.navigate('prep');
      const badge = el('span', 'nav-count', '0');
      prepBtn.appendChild(badge);
      right.appendChild(prepBtn);
      if (global.AiduJobService) {
        const refresh = () => global.AiduJobService.list().then((res) => {
          if (!res.ok) return;
          const count = (res.data || []).filter((job) => ['queued', 'running', 'paused'].includes(job.status)).length;
          badge.textContent = String(count);
        });
        refresh();
        setInterval(refresh, 5000).unref?.();
      }
      const settingsBtn = el('button', 'app-nav-link app-nav-settings', '设置');
      settingsBtn.dataset.route = 'settings';
      settingsBtn.setAttribute('aria-label', '打开设置');
      settingsBtn.onclick = () => this.router.navigate('settings');
      right.appendChild(settingsBtn);
      this.navEl.append(brand, left, right);

      // 全局错误条 (3.5: 后台失败必须可见)
      this.errorEl = el('div', 'global-error');
      this.errorEl.style.display = 'none';

      // 路由容器
      this.viewContainer = el('div', 'app-view');

      this.app.append(this.navEl, this.errorEl, this.viewContainer);
    }

    showError(msg) {
      this.errorEl.textContent = msg;
      this.errorEl.style.display = 'block';
    }

    clearError() {
      this.errorEl.style.display = 'none';
    }

    getViewContainer() {
      return this.viewContainer;
    }

    setActiveNav(route) {
      this.navEl.querySelectorAll('.app-nav-link').forEach(b => {
        b.classList.toggle('active', b.dataset.route === route);
      });
    }
  }

  global.ShellView = ShellView;
})(window);
