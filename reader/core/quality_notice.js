/**
 * quality_notice.js —— 失败句"真实阶段"过滤 (纯逻辑, 无 DOM)
 *
 * A2 (2026-08-18): prep 侧新跑的书不再把 nlp_realign 写进 failedSentences, 但磁盘上
 * 已有 10 本书的 quality_report.json 仍混着它, 不能要求用户重跑一遍才看对数字。
 * 书库卡片 / 任务失败原因 / 任务详情三个消费方数失败句时都走这里, 排除 stages **只含**
 * nlp_realign 的条目 —— 条目若同时含 nlp_realign 和真实阶段, 仍算失败。
 */
(function (global) {
  'use strict';

  // prep 侧记账用的伪阶段名。2026-08-18 起新跑的书不会再产出它(改走 quality 的
  // notice 通道), 这里只为读懂**存量**报告而保留。
  var NOTICE_STAGE = 'nlp_realign';

  /**
   * @param {object[]} arr quality_report.failedSentences
   * @returns {object[]} 只保留 stages 里存在非 nlp_realign 阶段的条目
   */
  function realFailures(arr) {
    return (arr || []).filter(function (f) {
      var stages = f && f.stages;
      // 无 stages / 空 stages 都无从排除, 按真实失败算 —— 这些条目带着 reason,
      // 确实是记下来的失败, 宁可多报也不要静默吞掉 (与 Rust 侧 quality_notice.rs 同判据)
      if (!Array.isArray(stages) || stages.length === 0) return true;
      return stages.some(function (s) { return s !== NOTICE_STAGE; });
    });
  }

  global.AiduQualityNotice = { realFailures: realFailures };
})(typeof globalThis !== 'undefined' ? globalThis : this);
