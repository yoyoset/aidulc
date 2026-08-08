/**
 * services/sync_service.js —— 同步用例层 (I-C)
 */
(function (global) {
  'use strict';

  const SyncService = {
    status() { return AiduBridge.invoke('sync_status'); },
    now() { return AiduBridge.invoke('sync_now'); },
    pull() { return AiduBridge.invoke('sync_pull_now'); },
    configure(workerUrl, token) {
      return AiduBridge.invoke('sync_config_set', { workerUrl, token });
    },
    disconnect() { return AiduBridge.invoke('sync_disconnect'); },
    statusLabel(s) {
      return {
        unconfigured: '未配置',
        offline: '离线',
        synced: '已同步',
        failed: '失败',
      }[s.status] || s.status;
    },
  };

  global.AiduSyncService = SyncService;
})(window);
