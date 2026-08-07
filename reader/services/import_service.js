/**
 * services/import_service.js —— 书籍导入用例层 (统一组装 job_request 参数)
 * 书库导入 + 备料台共用: profile 完整对象 + models 路径快照 (schema 契约)
 */
(function (global) {
  'use strict';

  const ImportService = {
    /** 组装完整 profile (schema 要求 5 字段) */
    buildProfile(id) {
      const pid = id || 'default';
      return {
        id: pid,
        name: pid === 'kid' ? '陪小孩读' : '成人自读',
        explain_strategy: pid === 'kid' ? 'deep' : 'brief',
        voice: 'af_heart',
        speed: pid === 'kid' ? 0.9 : 1.0,
        highlight_granularity: pid === 'kid' ? 'word' : 'sentence',
      };
    },

    /** 组装 models 快照 (从运行时配置取 llm/tts 路径; 缺失返回 null 由调用方提示) */
    async buildModels() {
      const res = await AiduBridge.invoke('runtime_config');
      if (!res.ok) throw new Error('读运行时配置失败: ' + res.error);
      const d = res.data || {};
      const models = {};
      if (d.llm_model) models.llm = d.llm_model;
      if (d.tts_model) models.tts = d.tts_model;
      return models;
    },

    /** 启动批量导入: 组装完整参数 → batch_import (R1: 只登记书, 不开始处理) */
    async importBooks(paths, profileId, languages) {
      const profile = this.buildProfile(profileId);
      return AiduBridge.invoke('batch_import', {
        bookPaths: paths, profile,
        sourceLanguage: (languages && languages.source) || 'en',
        targetLanguage: (languages && languages.target) || 'zh-CN',
      });
    },

    /** 开始阅读准备: 前置检查 → 通过入队 (R2) */
    async startPrep(batchId, bookIds, profileId) {
      const profile = this.buildProfile(profileId);
      return AiduBridge.invoke('batch_start_prep', {
        batchId, bookIds, profile, models: {},
      });
    },

    /** 旧接口兼容 (老调用方) */
    async startBatch(paths, profileId, languages) {
      const profile = this.buildProfile(profileId);
      const models = await this.buildModels();
      return AiduJobService.startBatch(paths, profile, models, languages || { source: 'en', target: 'zh-CN' });
    },
  };

  global.AiduImportService = ImportService;
})(window);
