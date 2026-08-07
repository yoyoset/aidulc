/**
 * services/misc_service.js —— 杂项用例层 (M 系列: 诊断/运行时配置)
 * 承载 settings_view 曾直接裸 invoke 的 log_path / components_health / runtime_config
 */
(function (global) {
  'use strict';

  const MiscService = {
    logPath() { return AiduBridge.invoke('log_path'); },
    componentsHealth() { return AiduBridge.invoke('components_health'); },
    runtimeConfig() { return AiduBridge.invoke('runtime_config'); },
    openPath(path) { return AiduBridge.openPath(path); },
  };

  global.AiduMiscService = MiscService;
})(window);
