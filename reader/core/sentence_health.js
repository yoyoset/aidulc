/**
 * core/sentence_health.js —— 句子哪些环节没处理成功 (纯逻辑, 零 DOM, E2 2026-11-15)
 *
 * 备料可以"部分成功": 某句翻译/讲解/朗读失败时, 书包照常生成 (失败句写静音占位), 句子上记
 * `status` (ok|partial|failed) 和 `failedStages` (nlp/translate/explain/tts/align)。
 * 之前阅读器完全不看这两个字段 —— 读到一句没译文或没声音, 用户分不清是程序坏了还是这句本来
 * 就没处理成功, 也没有就地补救的入口。
 *
 * 判定只信 `failedStages`/`status` 这两个后端明确写下的事实, **不去猜"译文为空 = 失败"**:
 * 原文本身无可翻译内容的句子 (纯标点/图注) 会被刻意跳过, 译文为空是正常的, 猜了就是误报。
 */
(function (global) {
  'use strict';

  /** 阶段名 → 给用户看的人话 (后端阶段名见 contracts/bookpack.schema.json) */
  const STAGE_LABELS = {
    nlp: '分词',
    translate: '翻译',
    explain: '讲解',
    tts: '朗读',
    align: '逐词高亮',
  };

  /** 展示顺序 = 备料流水线顺序, 不管后端数组里是什么顺序 */
  const STAGE_ORDER = ['nlp', 'translate', 'explain', 'tts', 'align'];

  /**
   * 一句没处理成功的环节 → [{ stage, label }] (按流水线顺序、去重)。没问题返回 []。
   * 未知阶段名原样保留 (label=阶段名), 不吞掉 —— 后端将来加了新阶段, 至少能看见。
   * status 是 partial/failed 但 failedStages 为空 → 返回一条 stage='unknown', 不能因为缺细节就当没事。
   */
  function issuesOf(sentence) {
    if (!sentence || typeof sentence !== 'object') return [];
    const raw = Array.isArray(sentence.failedStages) ? sentence.failedStages : [];
    const seen = new Set();
    const known = [];
    const extra = [];
    raw.forEach((st) => {
      const key = String(st);
      if (seen.has(key)) return;
      seen.add(key);
      (STAGE_ORDER.includes(key) ? known : extra).push(key);
    });
    known.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
    const out = known.concat(extra).map((stage) => ({ stage, label: STAGE_LABELS[stage] || stage }));
    if (!out.length && (sentence.status === 'partial' || sentence.status === 'failed')) {
      out.push({ stage: 'unknown', label: '部分环节' });
    }
    return out;
  }

  function isFlagged(sentence) {
    return issuesOf(sentence).length > 0;
  }

  /** [{label}] → "翻译、朗读" */
  function describe(issues) {
    return (issues || []).map((i) => i.label).join('、');
  }

  /** 一章里有问题的句子数 */
  function countFlagged(sentences) {
    return (sentences || []).reduce((n, s) => n + (isFlagged(s) ? 1 : 0), 0);
  }

  global.AiduSentenceHealth = { issuesOf, isFlagged, describe, countFlagged, STAGE_LABELS };
})(window);
