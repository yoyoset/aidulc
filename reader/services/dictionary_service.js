/**
 * services/dictionary_service.js —— 查词/生词用例层 (I-A)
 * V1 (2026-08-09): 所有调用带当前 user (顶栏切人后各自数据)。
 */
(function (global) {
  'use strict';

  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  const DictionaryService = {
    lookup(word, profileId, context) {
      return AiduBridge.invoke('word_lookup', { word, userId: currentUser(), profileId, context });
    },
    addToVocab(word, profileId, context) {
      // 阶段6 设计交付 §04: 记录来源句上下文 (词条卡显示"从哪里读到的")
      return AiduBridge.invoke('add_vocab', { word, userId: currentUser(), profileId, context: context || '' });
    },
    list(profileId) { return AiduBridge.invoke('dict_list', { userId: currentUser(), profileId }); },
    search(profileId, q) { return AiduBridge.invoke('dict_search', { userId: currentUser(), profileId, q }); },
    remove(key, profileId) { return AiduBridge.invoke('dict_remove', { key, userId: currentUser(), profileId }); },
    // 生词本 (I-B)
    vocabAll(profileId) { return AiduBridge.invoke('vocab_all', { userId: currentUser(), profileId }); },
    vocabSearch(profileId, q) { return AiduBridge.invoke('vocab_search', { userId: currentUser(), profileId, q }); },
    vocabRemove(profileId, lemma) { return AiduBridge.invoke('vocab_remove', { userId: currentUser(), profileId, lemma }); },
    vocabStats(profileId) { return AiduBridge.invoke('vocab_stats', { userId: currentUser(), profileId }); },
    // 背单词调度器 (V2, 2026-08-09)
    srsPreview(profileId, lemma) { return AiduBridge.srs.preview(currentUser(), profileId, lemma); },
    srsGrade(profileId, lemma, grade) { return AiduBridge.srs.grade(currentUser(), profileId, lemma, grade); },
  };

  global.AiduDictionaryService = DictionaryService;
})(window);
