/**
 * services/reading_service.js —— 阅读进度/书签用例层 (M 系列: 补缺失的 service)
 */
(function (global) {
  'use strict';

  const ReadingService = {
    save(state) { return AiduBridge.reading.save(state); },
    get(bookKey) { return AiduBridge.reading.get(bookKey); },
  };

  global.AiduReadingService = ReadingService;
})(window);
