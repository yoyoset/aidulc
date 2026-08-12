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
    // F4 (2026-08-11): 强制全量重推 —— 清 sync_state, 服务端数据被清/损坏后手动兜底
    forceFull(userId) { return AiduBridge.invoke('sync_force_full', { userId: userId || currentUser() }); },
    authDevice(workerUrl, userId, rootSecret, code, deviceName) {
      return AiduBridge.invoke('sync_auth_device', {
        workerUrl, userId: userId || currentUser(),
        rootSecret: rootSecret || null, code: code || null, deviceName,
      });
    },
    makeCode(userId, codeType, name) {
      return AiduBridge.invoke('sync_make_code', { userId: userId || currentUser(), codeType, name: name || null });
    },
    // P0-C (2026-08-10): 手机扫码配对 —— 生成二维码 (独立 device token, 不覆盖本机 token)
    pairQr(userId) {
      return AiduBridge.invoke('sync_pair_qr', { userId: userId || currentUser() });
    },
    // P0-C: 踢掉配对设备 token (worker /v1/auth/revoke, 删后即失效)
    revokeToken(userId, targetToken) {
      return AiduBridge.invoke('sync_revoke_token', { userId: userId || currentUser(), targetToken });
    },
    configure(workerUrl, token) {
      return AiduBridge.invoke('sync_config_set', { workerUrl, token });
    },
    disconnect(userId) { return AiduBridge.invoke('sync_disconnect', { userId: userId || currentUser() }); },
    // L11 (2026-08-11): 多后端配置 —— "谁的库选谁的"
    backendsList(userId) { return AiduBridge.invoke('sync_backends_list', { userId: userId || currentUser() }); },
    backendAdd(name, url) { return AiduBridge.invoke('sync_backend_add', { name, url }); },
    backendSwitch(name) { return AiduBridge.invoke('sync_backend_switch', { name }); },
    // M3 (2026-08-13): 勾选/取消某后端的「同步此后端」(当前主体 × 该后端一格)
    backendToggle(name, enabled) {
      return AiduBridge.invoke('sync_backend_toggle', { name, enabled: !!enabled, userId: currentUser() });
    },
    backendRemove(name) { return AiduBridge.invoke('sync_backend_remove', { name }); },
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