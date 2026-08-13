/**
 * services/job_service.js —— 任务/批次用例层 (G4)
 * 视图只调用这里, 不直接 invoke 命令名。
 */
(function (global) {
  'use strict';

  const JobService = {
    list() { return AiduBridge.invoke('job_list'); },
    remove(id) { return AiduBridge.invoke('job_remove', { id }); },
    retryFailed(id) { return AiduBridge.invoke('job_retry_failed', { id }); },
    // 自定义重跑 (2026-08-13): 手动重选模型 + 指定重跑范围 (forceStages 为空 = 自动)
    retryCustom(id, llmId, ttsId, nlpId, forceStages) {
      return AiduBridge.invoke('job_retry_custom', {
        id,
        llmId: llmId || null,
        ttsId: ttsId || null,
        nlpId: nlpId || null,
        forceStages: forceStages && forceStages.length ? forceStages : null,
      });
    },
    detail(id) { return AiduBridge.invoke('job_detail', { id }); }, // M7 R24
    cancel() { return AiduBridge.invoke('cancel_prep_job'); },
    // R3: 暂停/继续
    pause(id) { return AiduBridge.invoke('job_pause', { id }); },
    resume(id) { return AiduBridge.invoke('job_resume', { id }); },
    pauseAll() { return AiduBridge.invoke('pause_all'); },
    resumeAll() { return AiduBridge.invoke('resume_all'); },
    // R1: 两段式导入 (登记 + 开始)
    importBooks(paths, profile, languages) {
      return AiduBridge.invoke('batch_import', {
        bookPaths: paths, profile,
        sourceLanguage: (languages && languages.source) || 'en',
        targetLanguage: (languages && languages.target) || 'zh-CN',
      });
    },
    startPrep(batchId, bookIds, profile) {
      return AiduBridge.invoke('batch_start_prep', { batchId, bookIds, profile, models: {} });
    },

    startBatch(paths, profile, models, languages) {
      return AiduBridge.invoke('batch_start', {
        bookPaths: paths, profile, models,
        sourceLanguage: (languages && languages.source) || 'en',
        targetLanguage: (languages && languages.target) || 'zh-CN',
      });
    },
    startSingle(path, profile, models) {
      return AiduBridge.invoke('start_prep_job', {
        bookPath: path, profile, models,
        sourceLanguage: 'en', targetLanguage: 'zh-CN',
      });
    },
    listBatches() { return AiduBridge.invoke('batch_list'); },
    batchDetail(id) { return AiduBridge.invoke('batch_detail', { id }); },
  };

  global.AiduJobService = JobService;
})(window);
