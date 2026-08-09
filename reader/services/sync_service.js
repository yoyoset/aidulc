/**
 * services/sync_service.js —— 同步用例层 (I-C, V6 按 user 分账)
 */
(function (global) {
  'use strict';

  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  const SyncService = {
    status(userId) { return AiduBridge.invoke('sync_status', { userId: userId || currentUser() }); },
    now(userId) { return AiduBridge.invoke('sync_now', { userId: userId || currentUser() }); },
    pull(userId) { return AiduBridge.invoke('sync_pull_now', { userId: userId || currentUser() }); },
    authDevice(workerUrl, userId, rootSecret, code, deviceName) {
      return AiduBridge.invoke('sync_auth_device', {
        workerUrl, userId: userId || currentUser(),
        rootSecret: rootSecret || null, code: code || null, deviceName,
      });
    },
    makeCode(userId, codeType, name) {
      return AiduBridge.invoke('sync_make_code', { userId: userId || currentUser(), codeType, name: name || null });
    },
    configure(workerUrl, token) {
      return AiduBridge.invoke('sync_config_set', { workerUrl, token });
    },
    disconnect(userId) { return AiduBridge.invoke('sync_disconnect', { userId: userId || currentUser() }); },
    statusLabel(s) {
      return {
        unconfigured: '未配置',
        offline: '离线',
        synced: '已同步',
        pending: '待推',
        failed: '失败',
      }[s.status] || s.status;
    },
  };

  global.AiduSyncService = SyncService;
})(window);