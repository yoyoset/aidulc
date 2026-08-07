/**
 * services/library_service.js —— 书库用例层 (G4)
 */
(function (global) {
  'use strict';

  const LibraryService = {
    list(kind) { return AiduBridge.library.list ? AiduBridge.library.list(kind) : AiduBridge.invoke('library_list', { kind: kind || null }); },
    open(id) { return AiduBridge.library.open(id); },
    remove(id, deleteFiles) { return AiduBridge.library.remove(id, deleteFiles); },
    loadBookpack(bookId) { return AiduBridge.bookpack.load(bookId); },
    readAudioRange(basePath, file, offset, length) {
      return AiduBridge.invoke('read_audio_range', { basePath, file, offset, length });
    },
    preview(bookId) { return AiduBridge.invoke('library_preview', { bookId }); },
  };

  global.AiduLibraryService = LibraryService;
})(window);
