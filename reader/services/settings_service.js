/**
 * services/settings_service.js —— 阅读设置用例层 (M 系列: 补缺失的 service)
 */
(function (global) {
  'use strict';

  const SettingsService = {
    get(profileId) { return AiduBridge.settings.get(profileId); },
    upsert(settings) { return AiduBridge.settings.upsert(settings); },
  };

  global.AiduSettingsService = SettingsService;
})(window);
