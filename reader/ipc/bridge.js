/**
 * ipc/bridge.js —— 唯一 Tauri invoke/listen 出口 (3.7 安全边界)
 * 视图禁止直接调用 window.__TAURI__; 所有跨边界调用走这里。
 */
(function (global) {
  'use strict';

  const core = (window.__TAURI__?.core) || null;

  function requireTauri() {
    if (!core) throw new Error('Tauri 环境不可用 (请从 aidulc.exe 启动)');
  }

  /** 统一 invoke 封装: 错误归一化为 { ok:false, error } */
  async function invoke(cmd, args) {
    requireTauri();
    try {
      const r = await core.invoke(cmd, args || {});
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /** 订阅 Tauri event */
  function listen(event, handler) {
    requireTauri();
    const p = window.__TAURI__.event.listen(event, handler);
    // 返回同步可调用的 unlisten (event.listen 返回 Promise<unlisten>)
    return function unlisten() {
      p.then(fn => { if (typeof fn === 'function') fn(); }).catch(() => {});
    };
  }

  /** 文件选择对话框 (M 系列: 视图禁止直连 __TAURI__) */
  function pickFiles(extensions) {
    return invoke('pick_files', { extensions: extensions || ['epub', 'pdf', 'txt'] });
  }

  /** 打开外部文件 (M 系列: 视图禁止直连 __TAURI__) */
  function openPath(path) {
    return invoke('plugin:opener|open_path', { path });
  }

  // ---- 书库 ----
  const library = {
    list: (kind) => invoke('library_list', { kind: kind || null }),
    register: (b) => invoke('library_register', {
      id: b.id, title: b.title, sourcePath: b.sourcePath,
      packDir: b.packDir, profileId: b.profileId,
      chapterCount: b.chapterCount, failedCount: b.failedCount,
    }),
    remove: (id, deleteFiles) => invoke('library_remove', { id, deleteFiles }),
    open: (id) => invoke('library_open', { id }),
  };

  // ---- 书包 ----
  const bookpack = {
    load: (bookId) => invoke('load_bookpack', { bookId }),
    // 修复(2026-08-07): 大书(90MB+)不能整本传, 按需只要当前章
    loadChapter: (bookId, chapterIndex) => invoke('load_bookpack_chapter', { bookId, chapterIndex }),
    readAudio: (basePath, file) => invoke('read_audio', { basePath, file }),
    // R4 (2026-08-08): 读原书插图 (base64)
    readImage: (basePath, file) => invoke('read_image', { basePath, file }),
  };

  // ---- profile / 设置 ----
  const profiles = {
    list: () => invoke('profile_list'),
    upsert: (profile) => invoke('profile_upsert', { profile }),
  };
  const settings = {
    get: (profileId) => invoke('settings_get', { profileId }),
    upsert: (settings) => invoke('settings_upsert', { settings }),
  };

  // ---- 阅读状态 ----
  const reading = {
    save: (s) => invoke('reading_save', { state: {
      book_key: s.bookKey, chapter: s.chapter,
      position_ms: s.position_ms, bookmarks: s.bookmarks,
    } }),
    get: (bookKey) => invoke('reading_get', { bookKey }),
  };

  global.AiduBridge = { invoke, listen, pickFiles, openPath, library, bookpack, profiles, settings, reading };
})(window);
