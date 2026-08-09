/**
 * services/dictionary_service.js —— 查词/生词用例层 (I-A)
 */
(function (global) {
  'use strict';

  const DictionaryService = {
    lookup(word, profileId, context) {
      return AiduBridge.invoke('word_lookup', { word, profileId, context });
    },
    addToVocab(word, profileId, context) {
      // 阶段6 设计交付 §04: 记录来源句上下文 (词条卡显示"从哪里读到的")
      return AiduBridge.invoke('add_vocab', { word, profileId, context: context || '' });
    },
    list(profileId) { return AiduBridge.invoke('dict_list', { profileId }); },
    search(profileId, q) { return AiduBridge.invoke('dict_search', { profileId, q }); },
    remove(key, profileId) { return AiduBridge.invoke('dict_remove', { key, profileId }); },
    // 生词本 (I-B)
    vocabAll(profileId) { return AiduBridge.invoke('vocab_all', { profileId }); },
    vocabSearch(profileId, q) { return AiduBridge.invoke('vocab_search', { profileId, q }); },
    vocabRemove(profileId, lemma) { return AiduBridge.invoke('vocab_remove', { profileId, lemma }); },
    vocabStats(profileId) { return AiduBridge.invoke('vocab_stats', { profileId }); },
  };

  global.AiduDictionaryService = DictionaryService;
})(window);
