/**
 * services/reading_service.js —— 阅读进度/书签用例层 (M 系列: 补缺失的 service)
 * V1 (2026-08-09): save 里带当前 user; get/stats 显式传 userId。
 */
(function (global) {
  'use strict';

  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  const ReadingService = {
    save(state) {
      const s = Object.assign({}, state, { userId: currentUser() });
      return AiduBridge.reading.save(s);
    },
    get(bookKey) { return AiduBridge.reading.get(bookKey, currentUser()); },
    stats(bookKey, days) { return AiduBridge.invoke('reading_stats', { bookKey, userId: currentUser(), days }); }, // M7 R37
  };

  global.AiduReadingService = ReadingService;
})(window);
