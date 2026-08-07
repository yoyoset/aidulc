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

      // 顶部导航
      this.navEl = el('nav', 'app-nav');
      const brand = el('span', 'app-brand', 'aidulc 精读工作站');
      const links = el('div', 'app-nav-links');
      const items = [
        ['library', '书库'],
        ['products', '我的书'],
        ['prep', '阅读准备'],
        ['models', '模型中心'],
        ['vocab', '生词本'],
        ['settings', '设置'],
      ];
      items.forEach(([route, label]) => {
        const a = el('button', 'app-nav-link', label);
        a.dataset.route = route;
        a.onclick = () => this.router.navigate(route);
        links.appendChild(a);
      });
      this.navEl.append(brand, links);

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
