/**
 * services/model_service.js —— 模型管理用例层 (H3/H4)
 * 视图只调用这里; 语言作为参数 (结构多语言化, 验收聚焦英文)
 */
(function (global) {
  'use strict';

  const ModelService = {
    list() { return AiduBridge.invoke('models_list'); },
    by(family, language) { return AiduBridge.invoke('models_by', { family, language }); },
    recommend(language) { return AiduBridge.invoke('models_recommend', { language }); },
    register(m) {
      return AiduBridge.invoke('models_register', {
        family: m.family, language: m.language, modelId: m.model_id,
        version: m.version || '1.0', variant: m.variant || 'cuda12.4',
        path: m.path, sourceType: m.source_type || 'local', sourceRef: m.source_ref || '',
        sha256: m.sha256 || '', sizeBytes: m.size_bytes || 0, custom: !!m.custom,
      });
    },
    setRecommended(id) { return AiduBridge.invoke('models_set_recommended', { id }); },
    setFamily(id, family) { return AiduBridge.invoke('models_set_family', { id, family }); },
    remove(id) { return AiduBridge.invoke('models_remove', { id }); },
    scan(dir) { return AiduBridge.invoke('models_scan', { modelDir: dir }); },
    // D (2026-08-11): 探测磁盘是否已有模型文件 (present/healthy/size_bytes)
    fileCheck(path, minBytes) { return AiduBridge.invoke('model_file_check', { path, minBytes }); },
    bindBook(bookId, src, tgt, llm, tts, nlp) {
      return AiduBridge.invoke('models_bind_book', {
        bookId, sourceLanguage: src, targetLanguage: tgt,
        llmId: llm || null, ttsId: tts || null, nlpId: nlp || null,
      });
    },
    bookBinding(bookId) {
      return AiduBridge.invoke('models_book_binding', { bookId });
    },
    download(url, dest, sha256, timeoutSecs) {
      // M7 R8: 返回 { token }, 前端轮询 downloadStatus
      return AiduBridge.invoke('models_download', { url, dest, sha256, timeoutSecs });
    },
    downloadStatus(token) {
      return AiduBridge.invoke('models_download_status', { token });
    },
    // J4 (2026-08-11): 自定义模型 —— HF 链接规范成 resolve 直链 + 文件名
    hfNormalize(raw) { return AiduBridge.invoke('models_hf_normalize', { raw }); },
    hardware(dir) { return AiduBridge.invoke('hardware_detect', { modelDir: dir }); },

    // 向导
    wizardState() { return AiduBridge.invoke('wizard_state'); },
    wizardSubmit(step, status) { return AiduBridge.invoke('wizard_submit', { step, status }); },
    wizardFinish() { return AiduBridge.invoke('wizard_finish'); },
    wizardReset() { return AiduBridge.invoke('wizard_reset'); },
  };

  global.AiduModelService = ModelService;
})(window);
