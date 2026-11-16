/**
 * core/notify.js —— E3 (2026-11-16): 备料任务结束时的系统通知
 *
 * 备料一本书要几十分钟到几小时, 用户多半切去做别的事。页内 toast 只在 aidulc 窗口
 * 可见时才看得到, 所以窗口不在前台时补一条系统通知。
 *
 * 用 WebView 自带的 Notification API (不引入 Rust 插件/新依赖); 偏好是"这台机器"的
 * 显示偏好, 同 aidulc.lib.compact 等, 存 localStorage, 默认开。
 *
 * 纯决策逻辑 (该不该发/发什么字) 与 DOM/权限副作用分开, 前者零依赖可测。
 */
(function (global) {
  'use strict';

  const KEY = 'aidulc.notify';

  /** 偏好: 缺省/读不到 = 开; 只有显式存了 '0' 才算关 */
  function isEnabled(storage) {
    try {
      const s = storage || global.localStorage;
      return !s || s.getItem(KEY) !== '0';
    } catch (e) {
      return true;
    }
  }

  function setEnabled(on, storage) {
    try {
      (storage || global.localStorage).setItem(KEY, on ? '1' : '0');
    } catch (e) { /* 无 localStorage 不阻塞 */ }
  }

  /** 只在用户"没在看"时发: 窗口在前台 (页内 toast 已够) 不重复打扰 */
  function shouldNotify({ enabled, focused, permission }) {
    return !!enabled && !focused && permission === 'granted';
  }

  /** job: jobs 表一行 ({id, book_path, status}) → { title, body } */
  function buildMessage(job) {
    const path = String((job && job.book_path) || '');
    const name = path.split(/[\\/]/).pop() || (job && job.id) || '一本书';
    if (job && job.status === 'failed') {
      return { title: '处理失败', body: `《${name}》没有处理成功, 回到 aidulc 的"阅读准备"查看原因` };
    }
    if (job && job.status === 'partial') {
      return { title: '处理完成 (部分句子失败)', body: `《${name}》可以阅读了, 个别句子没处理成功, 阅读时会有标记` };
    }
    return { title: '处理完成', body: `《${name}》可以开始阅读了` };
  }

  /** 在用户打开开关时调用 (用户手势里): 向系统要通知权限 */
  function requestPermission() {
    try {
      if (global.Notification && global.Notification.permission === 'default') {
        return Promise.resolve(global.Notification.requestPermission());
      }
      return Promise.resolve(global.Notification ? global.Notification.permission : 'unsupported');
    } catch (e) {
      return Promise.resolve('unsupported');
    }
  }

  /** 任务结束时调用; 任何失败都吞掉 (通知是锦上添花, 不能影响主流程) */
  function notifyJob(job) {
    try {
      if (!global.Notification) return false;
      const ok = shouldNotify({
        enabled: isEnabled(),
        focused: typeof document !== 'undefined' && document.hasFocus && document.hasFocus(),
        permission: global.Notification.permission,
      });
      if (!ok) return false;
      const m = buildMessage(job);
      new global.Notification(m.title, { body: m.body });
      return true;
    } catch (e) {
      return false;
    }
  }

  global.AiduNotify = { KEY, isEnabled, setEnabled, shouldNotify, buildMessage, requestPermission, notifyJob };
})(typeof window !== 'undefined' ? window : globalThis);
