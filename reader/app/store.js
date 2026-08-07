/**
 * app/store.js —— 统一应用状态 (书库/当前书/设置/任务) + 订阅
 * 视图渲染时从 store 读, 变更通过 emit 通知订阅者。
 */
(function (global) {
  'use strict';

  class Store {
    constructor() {
      this.state = {
        books: [],          // 书库列表
        currentBook: null,  // 当前打开的书 (含 bookpack)
        settings: null,     // 阅读设置
        profiles: [],
        jobs: [],           // 任务列表 (P4 完善)
        ready: false,
      };
      this._listeners = new Map(); // event → Set<fn>
    }

    on(event, fn) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(fn);
      return () => this._listeners.get(event)?.delete(fn);
    }

    emit(event, payload) {
      this._listeners.get(event)?.forEach(fn => {
        try { fn(payload); } catch (e) { console.error('[store] listener error:', e); }
      });
    }

    set(patch) {
      Object.assign(this.state, patch);
      this.emit('change', this.state);
    }
  }

  global.AiduStore = Store;
})(window);
