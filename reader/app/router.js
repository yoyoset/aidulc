/**
 * app/router.js —— 极简 hash 路由: #/library #/prep #/reader #/settings
 */
(function (global) {
  'use strict';

  const ROUTES = ['library', 'products', 'prep', 'models', 'vocab', 'review', 'reader', 'settings', 'wizard'];

  class Router {
    constructor(container) {
      this.container = container;
      this.current = 'library';
      this._handlers = {}; // route → fn(viewContainer)
      window.addEventListener('hashchange', () => this._dispatch());
    }

    register(route, handler) {
      this._handlers[route] = handler;
    }

    navigate(route) {
      if (!ROUTES.includes(route)) route = 'library';
      if (this.current === route) {
        // 同路由: 强制刷新一次 (当前视图可能需重新拉数据)
        this._dispatch(route);
        return;
      }
      // Bug fix (审查确认): 只设 hash, 由 hashchange 统一 dispatch (旧实现双重 dispatch)
      window.location.hash = '#/' + route;
    }

    _dispatch(forceRoute) {
      const raw = (forceRoute || (window.location.hash || '#/library')).replace('#/', '');
      // K17 (2026-08-14): hash 允许带 query (如 #/models?focus=tts), 路由匹配只看 ? 前的部分,
      // 视图自己按需从 window.location.hash 里解析 query。
      const route = raw.split('?')[0];
      const target = ROUTES.includes(route) ? route : 'library';
      if (target === this.current && !forceRoute) {
        // hashchange 相同路由 (如重复点击) → 不重复渲染
        return;
      }
      this.current = target;
      const handler = this._handlers[target];
      if (handler) handler(this.container);
    }

    start() {
      // Initial hash is usually empty while current defaults to library.
      // Force the first render instead of treating startup as a duplicate route.
      this._dispatch('library');
    }
  }

  global.AiduRouter = Router;
})(window);
