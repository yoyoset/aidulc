/**
 * services/library_service.js —— 书库用例层 (G4)
 */
(function (global) {
  'use strict';

  /** K5 (2026-08-14): 书架阅读进度/笔记数/书签数要跟着当前切换的用户走
   *  (同 reading_service.js 已有的 currentUser() 写法)。 */
  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  const LibraryService = {
    list(kind) {
      return AiduBridge.library.list
        ? AiduBridge.library.list(kind, currentUser())
        : AiduBridge.invoke('library_list', { kind: kind || null, userId: currentUser() });
    },
    open(id) { return AiduBridge.library.open(id); },
    editionLookup(editionId) { return AiduBridge.library.editionLookup(editionId); },
    remove(id, deleteFiles) { return AiduBridge.library.remove(id, deleteFiles); },
    loadBookpack(bookId) { return AiduBridge.bookpack.load(bookId); },
    loadBookpackChapter(bookId, chapterIndex) { return AiduBridge.bookpack.loadChapter(bookId, chapterIndex); },
    readAudioRange(basePath, file, offset, length) {
      return AiduBridge.invoke('read_audio_range', { basePath, file, offset, length });
    },
    // R4: 读原书插图 (base64)
    readImage(basePath, file) { return AiduBridge.bookpack.readImage(basePath, file); },
    preview(bookId) { return AiduBridge.invoke('library_preview', { bookId }); },
    // P1.5: 书包导出/导入(zip, 跨设备迁移的产品成品资产)
    exportBook(id) { return AiduBridge.invoke('book_export', { id }); },
    importBook() { return AiduBridge.invoke('book_import'); },
    // L10 (2026-08-11): 书设置弹窗改学习档案 (影响下次生成, 不动已生成译本)
    setBookProfile(bookId, profileId) {
      return AiduBridge.invoke('library_book_set_profile', { bookId, profileId });
    },
  };

  global.AiduLibraryService = LibraryService;
})(window);
