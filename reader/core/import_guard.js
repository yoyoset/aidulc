/**
 * core/import_guard.js —— 导入防重入 (纯逻辑, 零 DOM)
 *
 * 阶段2 (F45, 2026-08-09): 把"拖拽/文件选择导入只触发一次"和"listener 不累积"收进可测模块。
 * 历史 bug: render() 每次进书库都 `AiduBridge.listen('tauri://drag-drop')`, 若不清旧 listener,
 * 一次拖拽会让所有累积的 listener 各自触发一次 batch_import → 同一批文件导入多次。
 * 本模块负责两块:
 *   1. listener 槽位: 同时只允许一个活 listener, 注册新的先注销旧的 (保证"重新渲染不累积")。
 *   2. 导入去重: 同一批路径在短窗口内只放行一次 (拖拽事件 + 文件选择同时命中等)。
 */
(function (global) {
  'use strict';

  /** 单一 listener 槽: set() 替换旧 listener (先注销旧的), clear() 注销当前。 */
  class ListenerSlot {
    constructor() {
      this._unlisten = null;
    }

    /** 注册新 listener; 返回 unlisten。自动注销上一个活 listener。 */
    set(unlisten) {
      this.clear();
      this._unlisten = typeof unlisten === 'function' ? unlisten : null;
      return this._unlisten;
    }

    /** 是否还有活 listener (测试用) */
    has() {
      return this._unlisten != null;
    }

    /** 注销当前 listener 并清空槽位 */
    clear() {
      if (this._unlisten) {
        this._unlisten();
        this._unlisten = null;
      }
    }
  }

  /** 导入去重: 相同路径签名在窗口期内只放行一次。 */
  class ImportDedup {
    constructor(windowMs) {
      this.windowMs = windowMs || 2000;
      this._seen = new Map(); // 签名 → 上次放行时间戳
    }

    /** 路径签名 (去重粒度: 路径集 + profile)。 */
    keyFor(paths, profileId) {
      const norm = (paths || []).slice().sort().join('\u0001');
      return (profileId || 'default') + '|' + norm;
    }

    /** 是否应放行本次导入。放行时记录时间戳。 */
    shouldFire(paths, profileId) {
      const key = this.keyFor(paths, profileId);
      const now = Date.now();
      const last = this._seen.get(key);
      if (last != null && now - last < this.windowMs) {
        return false;
      }
      this._seen.set(key, now);
      return true;
    }
  }

  global.AiduListenerSlot = ListenerSlot;
  global.AiduImportDedup = ImportDedup;
})(window);
