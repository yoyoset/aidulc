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
    // 2026-08-21 (查词三层重构): forceLlm=true 用于"基底有收录但用户想要结合
    // 这句话的例句/用法"这个手动按钮——跳过基底直接走本地小模型。
    lookup(word, profileId, context, forceLlm) {
      return AiduBridge.invoke('word_lookup', { word, userId: currentUser(), profileId, context, forceLlm: !!forceLlm });
    },
    // K3 (2026-08-11): 用在线 AI 查一次 (本地失败后用户显式点击, 绝不自动回退)
    lookupOnline(word, context) {
      return AiduBridge.invoke('word_lookup_online', { word, context: context || '' });
    },
    addToVocab(word, profileId, context, source) {
      // 阶段6 设计交付 §04: 记录来源句上下文 (词条卡显示"从哪里读到的")
      // V4: source = { editionId, chapterIndex, sentenceIndex } 来源定位
      const s = source || {};
      return AiduBridge.invoke('add_vocab', { req: {
        word, userId: currentUser(), profileId, context: context || '',
        editionId: s.editionId || null, chapterIndex: s.chapterIndex != null ? s.chapterIndex : null,
        sentenceIndex: s.sentenceIndex != null ? s.sentenceIndex : null,
      } });
    },
    list(profileId) { return AiduBridge.invoke('dict_list', { userId: currentUser(), profileId }); },
    search(profileId, q) { return AiduBridge.invoke('dict_search', { userId: currentUser(), profileId, q }); },
    remove(key, profileId) { return AiduBridge.invoke('dict_remove', { key, userId: currentUser(), profileId }); },
    // 生词本 (I-B)
    vocabAll(profileId) { return AiduBridge.invoke('vocab_all', { userId: currentUser(), profileId }); },
    vocabSearch(profileId, q) { return AiduBridge.invoke('vocab_search', { userId: currentUser(), profileId, q }); },
    vocabRemove(profileId, lemma) { return AiduBridge.invoke('vocab_remove', { userId: currentUser(), profileId, lemma }); },
    // H5 (2026-08-11): 词频批量剔除 —— dry-run 预览 + 确认后执行 (备份+单事务)
    vocabCommonPreview(profileId, topN) { return AiduBridge.invoke('vocab_common_preview', { userId: currentUser(), profileId, top_n: topN }); },
    vocabRemoveCommon(profileId, topN) { return AiduBridge.invoke('vocab_remove_common', { userId: currentUser(), profileId, top_n: topN }); },
    // H4 (2026-08-11): 存量打散 —— dry-run 预览 + 确认后执行 (备份+单事务)
    vocabBacklogPreview(profileId, dailyCap) { return AiduBridge.invoke('vocab_backlog_preview', { userId: currentUser(), profileId, daily_cap: dailyCap }); },
    vocabBacklogSpread(profileId, dailyCap) { return AiduBridge.invoke('vocab_backlog_spread', { userId: currentUser(), profileId, daily_cap: dailyCap }); },
    // 背单词调度器 (V2, 2026-08-09)
    srsPreview(profileId, lemma) { return AiduBridge.srs.preview(currentUser(), profileId, lemma); },
    srsGrade(profileId, lemma, grade) { return AiduBridge.srs.grade(currentUser(), profileId, lemma, grade); },
    srsRestore(profileId, entry) { return AiduBridge.srs.restore(currentUser(), profileId, entry); },
    // K29 (2026-08-14): 生词本发音走本地 TTS 常驻守护(与正文朗读同一引擎), 不再是
    // 浏览器系统机械音。ttsSynthWord 返回 base64 WAV; ttsPrewarm 在进入阅读器时调,
    // 让守护提前把模型加载好, 减少生词本首次点发音的等待。
    ttsSynthWord(word) { return AiduBridge.invoke('tts_synth_word', { word }); },
    ttsPrewarm() { return AiduBridge.invoke('tts_prewarm'); },
    // K32 (2026-08-15): 生词发音缓存 —— ttsCacheWord 后台预生成音频落盘(幂等, 加词时
    // fire-and-forget); vocabReadCachedAudio 读缓存 base64(未命中返回 null, 前端降级合成)。
    ttsCacheWord(word) { return AiduBridge.invoke('tts_cache_word', { word }); },
    // 2026-08-17: 批量补发音改成 Rust 侧后台任务(有进度/可取消/切页面不断),
    // 不再是前端 for 循环逐词调 ttsCacheWord。见 application/vocab_audio_task.rs。
    vocabAudioStart(words) { return AiduBridge.invoke('vocab_audio_start', { words }); },
    vocabAudioStatus() { return AiduBridge.invoke('vocab_audio_status'); },
    vocabAudioCancel() { return AiduBridge.invoke('vocab_audio_cancel'); },
    vocabReadCachedAudio(word) { return AiduBridge.invoke('vocab_read_cached_audio', { word }); },
  };

  global.AiduDictionaryService = DictionaryService;
})(window);
