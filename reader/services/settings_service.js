/**
 * services/settings_service.js —— 阅读设置用例层 (M 系列: 补缺失的 service)
 */
(function (global) {
  'use strict';

  /** K8 (2026-08-14): 阅读器设置是"用户级偏好", 但之前后端命令连 user_id 入参都
   *  没有, 多档案共享一台设备时字体/主题/儿童模式会互相覆盖(同 highlights.js
   *  的 K4——镜像已有的 currentUser() 写法)。 */
  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  const SettingsService = {
    get(profileId) { return AiduBridge.settings.get(profileId, currentUser()); },
    upsert(settings) {
      const s = Object.assign({}, settings, { user_id: currentUser() });
      return AiduBridge.settings.upsert(s);
    },
  };

  global.AiduSettingsService = SettingsService;
})(window);
