/**
 * services/import_service.js —— 书籍导入用例层 (统一组装 job_request 参数)
 * 书库导入 + 备料台共用: profile 完整对象 + models 路径快照 (schema 契约)
 */
(function (global) {
  'use strict';

  const ImportService = {
    /** 内建档案兜底 (查不到档案 / 档案表为空时用), 参数统一走 core/builtin_profiles */
    _builtinProfile(id) {
      return AiduBuiltinProfiles.builtinProfile(id);
    },

    /**
     * M6 (2026-08-08): 从档案表取真实 profile (音色/策略/速度/粒度由用户自建档案决定),
     * 查不到回退内建默认。之前 buildProfile 是硬编码的 —— "每个人不同的英文库"从这里开始。
     */
    async getProfile(id) {
      const pid = id || 'default';
      try {
        const res = await AiduBridge.profiles.list();
        if (res.ok && Array.isArray(res.data)) {
          const found = res.data.find((p) => p.id === pid);
          // 2026-08-18: 原来这里是就地写一份显式白名单, 漏了 K33 的
          // explain_max_chars / explain_min_sentence_chars —— 用户在设置里配的
          // 讲解字数上限/触发门槛在新书这条路上被静默丢弃(详见 fromRow 的说明)。
          if (found) return AiduBuiltinProfiles.fromRow(found, pid);
        }
      } catch (e) { /* 档案查询失败不阻断导入, 落内建默认 */ }
      return this._builtinProfile(pid);
    },

    /** 组装完整 profile (schema 要求 5 字段; 同步版本, 只用于非关键路径) */
    buildProfile(id) {
      return this._builtinProfile(id);
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

    /** STDIMPORT (2026-08-17): 导入前源书体检 (S1-S6)。返回与 paths 同序的结果数组;
     *  侧车不可用/超时时 Rust 侧已降级成 verdict='unknown', 不会让整批导入失败。 */
    async auditSources(paths) {
      const res = await AiduBridge.invoke('book_audit_sources', { paths });
      return (res.ok && res.data) || [];
    },

    /** 启动批量导入: 组装完整参数 → batch_import (R1: 只登记 source, 不开始处理)
     *  AUTOSTANDARDIZE (2026-08-19): 第 4 参数 pendingStandardize —— 体检不达标的书,
     *  照常登记并让 Rust 侧对这些路径后台尝试自动转换。命令参数名 needsStandardize
     *  (camelCase) 与前端数组名不同是故意的, 对应后端命令签名。*/
    async importBooks(paths, profileId, languages, pendingStandardize) {
      const profile = await this.getProfile(profileId);
      return AiduBridge.invoke('batch_import', {
        bookPaths: paths, profile,
        sourceLanguage: (languages && languages.source) || 'en',
        targetLanguage: (languages && languages.target) || 'zh-CN',
        needsStandardize: pendingStandardize || [],
      });
    },

    /** 开始阅读准备: 前置检查 → 通过入队 (R2) */
    async startPrep(batchId, bookIds, profileId) {
      const profile = await this.getProfile(profileId);
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
