/**
 * rerun_scope.js —— 重跑范围建议(纯逻辑, 无 DOM)
 *
 * STDIMPORT (2026-08-17): 「重新处理」对话框里用户改了模型/档案之后, 默认该重跑哪个
 * 阶段是可推导的——改了讲解相关设置只需重跑讲解(几分钟), 改了音色只需重跑语音,
 * 没必要每次都全量重跑(一本书几小时)。这里只做推导给出默认选中项, 用户仍可手动改。
 *
 * 判定顺序即代价顺序: 越上游的东西变了, 作废的下游越多。
 */
(function (global) {
  'use strict';

  /** 讲解结果只跟这三个 profile 字段有关 (K33 起) */
  var EXPLAIN_KEYS = ['explain_strategy', 'explain_max_chars', 'explain_min_sentence_chars'];
  /** 语音结果只跟这两个有关 */
  var VOICE_KEYS = ['voice', 'speed'];

  function differs(a, b, keys) {
    if (!a || !b) return false; // 缺任一侧就当"没依据判断变化", 不瞎猜
    return keys.some(function (k) { return a[k] !== b[k]; });
  }

  /**
   * @param {object} opts
   *   oldProfile / newProfile: 档案对象 (可空)
   *   llmChanged / ttsChanged / nlpChanged: 对应模型下拉是否被换掉
   * @returns {''|'translate'|'explain'|'tts'|'all'} '' = 自动(只跑失败/未完成句)
   */
  function suggest(opts) {
    var o = opts || {};
    // 分词变了 → 句子边界都可能变, 下游全部作废
    if (o.nlpChanged) return 'all';
    // 翻译引擎变了 → 翻译和讲解都由它生成
    if (o.llmChanged) return 'translate';

    var explainChanged = differs(o.oldProfile, o.newProfile, EXPLAIN_KEYS);
    var voiceChanged = !!o.ttsChanged || differs(o.oldProfile, o.newProfile, VOICE_KEYS);

    if (explainChanged && voiceChanged) return 'all';
    if (explainChanged) return 'explain';
    if (voiceChanged) return 'tts';
    return '';
  }

  global.AiduRerunScope = { suggest: suggest };
})(typeof globalThis !== 'undefined' ? globalThis : this);
