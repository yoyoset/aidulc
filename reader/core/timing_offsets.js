/**
 * timing_offsets.js —— 跟读时间轴人工校准的纯逻辑(无 DOM,可单测)
 *
 * 背景 (2026-08-31 实测): 打包出来的章节 opus 可能是**陈旧**的(上一轮跑的那份),
 * 与当前时间轴差出几秒到十几秒。实测误差形状是**阶跃函数** —— 跳变点前恒定、之后恒定,
 * 用单一常量偏移能让该段所有句边界落在真实静音 150ms 内(Winn-Dixie ch007 命中 10/10)。
 * 所以"从某句起整体平移一个常量"是有效的校正方式,而不是权宜之计。
 *
 * 锚点语义: `{from, offset}` 表示"从第 from 句起平移 offset 毫秒",生效到下一条锚点为止。
 * 存的是**绝对偏移**不是增量 —— 增量在反复微调时会累积浮动,也没法直接显示"当前偏移多少"。
 *
 * 性能: 偏移在**章节加载时一次性**平移进 sentence.audio.start_ms/end_ms(一趟 O(n)),
 * 之后每帧的 findSentenceIndex / highlightAt 完全不受影响、零额外开销。词级时间轴是
 * **句内相对**的(见 core/timeline.js),句子一挪词自动跟着走,不需要遍历词。
 */
(function (global) {
  'use strict';

  /** 第 i 句生效的偏移 = 最后一条 from <= i 的锚点值;没有则 0 */
  function offsetAt(anchors, sentenceIndex) {
    if (!anchors || anchors.length === 0) return 0;
    let off = 0;
    for (let k = 0; k < anchors.length; k++) {
      if (anchors[k].from <= sentenceIndex) off = anchors[k].offset;
      else break; // anchors 按 from 升序
    }
    return off;
  }

  /** 规范化: 过滤非法项、按 from 升序、丢掉与前一条等值的冗余锚点 */
  function normalize(anchors) {
    const list = (anchors || [])
      .filter((a) => a && Number.isFinite(a.from) && Number.isFinite(a.offset) && a.from >= 0)
      .map((a) => ({ from: Math.floor(a.from), offset: Math.round(a.offset) }))
      .sort((a, b) => a.from - b.from);
    const out = [];
    let prev = 0;
    for (const a of list) {
      if (a.offset === prev) continue; // 与继承值相同 = 冗余
      out.push(a);
      prev = a.offset;
    }
    return out;
  }

  /**
   * 在第 sentenceIndex 句处叠加 deltaMs,返回新的锚点数组(不修改入参)。
   * 归零/冗余的锚点会被 normalize 剪掉,所以反复微调不会让锚点无限增长。
   */
  function nudge(anchors, sentenceIndex, deltaMs) {
    const cur = normalize(anchors);
    const target = offsetAt(cur, sentenceIndex) + Math.round(deltaMs);
    const rest = cur.filter((a) => a.from !== sentenceIndex);
    rest.push({ from: Math.floor(sentenceIndex), offset: target });
    return normalize(rest);
  }

  /**
   * 把锚点应用到句子数组的 audio 时间上(**原地修改**,调用方传的是刚加载的章节数据)。
   *
   * 关键: core/timeline.js 的 findSentenceIndex 是二分查找,**要求 start_ms 单调不减**。
   * 在某句处平移一个大负值会让它跑到前一句前面、破坏二分前提(实测 ch005 要 -4150ms,
   * 而句长只有 2-4s,必然越界)。所以平移后必须跟一趟单调性修复。
   *
   * 返回被修改过的句数,供调用方判断是否需要重绘。
   */
  function applyToSentences(sentences, anchors) {
    const list = normalize(anchors);
    if (!sentences || sentences.length === 0) return 0;
    let touched = 0;
    for (let i = 0; i < sentences.length; i++) {
      const a = sentences[i] && sentences[i].audio;
      if (!a) continue;
      // 首次应用时快照原始时间。**必须基于快照重算而不是在现值上累加** ——
      // 用户实时微调会反复调用本函数, 累加式会把偏移叠好几遍; 而且下面的单调性
      // 修复是有损钳位, 钳过一次原值就找不回来了, 再想调回去就调不准。
      if (a._base_start === undefined) {
        a._base_start = a.start_ms;
        a._base_end = a.end_ms;
      }
      const off = offsetAt(list, i);
      a.start_ms = a._base_start + off;
      a.end_ms = a._base_end + off;
      if (off !== 0) touched++;
    }
    repairMonotonic(sentences);
    return touched;
  }

  /**
   * 单调性修复: start 不得小于前一句的 start,end 不得小于自己的 start。
   * 只在锚点处的接缝上真正起作用(段内平移量相同,顺序天然保持)。
   */
  function repairMonotonic(sentences) {
    let prevStart = -Infinity;
    for (let i = 0; i < sentences.length; i++) {
      const a = sentences[i] && sentences[i].audio;
      if (!a) continue;
      if (a.start_ms < prevStart) a.start_ms = prevStart;
      if (a.start_ms < 0) a.start_ms = 0;
      if (a.end_ms < a.start_ms) a.end_ms = a.start_ms;
      prevStart = a.start_ms;
    }
  }

  /**
   * 「以当前句对齐」: 用户听到正在念的是第 sentenceIndex 句、而播放头在 playheadMs,
   * 求需要叠加的增量 —— 即把这一句的起点搬到播放头上。
   * 比手动试 ±0.1s 快得多,是主操作。
   */
  function alignDelta(sentences, sentenceIndex, playheadMs) {
    const s = sentences && sentences[sentenceIndex];
    if (!s || !s.audio) return 0;
    return Math.round(playheadMs - s.audio.start_ms);
  }

  /** 人话显示: -4150 → "-4.15s";0 → "无偏移" */
  function formatOffset(ms) {
    if (!ms) return '无偏移';
    const sign = ms > 0 ? '+' : '-';
    return sign + (Math.abs(ms) / 1000).toFixed(2) + 's';
  }

  global.AiduTimingOffsets = {
    offsetAt,
    normalize,
    nudge,
    applyToSentences,
    repairMonotonic,
    alignDelta,
    formatOffset,
  };
})(typeof window !== 'undefined' ? window : globalThis);
