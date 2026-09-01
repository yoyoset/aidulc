/**
 * timing_offsets.js —— 跟读时间轴人工校准的纯逻辑(无 DOM,可单测)
 *
 * 背景 (2026-08-31 实测): 打包出来的章节 opus 可能是**陈旧**的(上一轮跑的那份),
 * 与当前时间轴差出几秒到十几秒。
 *
 * 误差形状 —— 这里有一处要更正 (2026-09-01 复测): 最初只看了 Winn-Dixie ch007, 那一章
 * 确实是**阶跃**的(跳变点前后各自恒定, 单一常量能让该段句边界全落在真实静音 150ms 内,
 * 10/10 命中), 于是写成了"误差是阶跃函数"。同日用 silencedetect 逐句核 ch005 发现不是:
 * 前 34 句吻合(残差恒定 -140ms, 是静音中点与句边界的取法差), 从第 34 句起残差**持续
 * 累积**, 到章尾攒到 -3.9s。也就是说一章里可能要打好几个锚点, 而不是一个。
 * 所以锚点设计成"从某句起生效、可以有多条"是对的, 但"一次平移管到章尾"只对部分章成立。
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
    // 第二趟 (2026-09-01 补): end 不得越过下一句的 start。
    // 只修 start 是不够的 —— 向下(负偏移)的接缝上, 上一句的 end 会盖住后面好几句,
    // 区间一重叠 findSentenceIndex 的二分前提就失效: 二分先命中前一句直接返回,
    // 高亮在那句上卡十几秒再突然连跳好几句 (用户报"高亮明显快很多")。
    // 实测复现: ch005 锚点 {54:+4146, 55:-4832} → 句54 区间变成 207921..222271,
    // 而句55 起点 213293, 重叠 9 秒。
    let nextStart = Infinity;
    for (let i = sentences.length - 1; i >= 0; i--) {
      const a = sentences[i] && sentences[i].audio;
      if (!a) continue;
      if (a.end_ms > nextStart) a.end_ms = nextStart;
      if (a.end_ms < a.start_ms) a.end_ms = a.start_ms;
      nextStart = a.start_ms;
    }
  }

  /** 原始数值显示: -4150 → "-4.15s";0 → "无偏移" (调试/日志用, 面板不再用它, 见下) */
  function formatOffset(ms) {
    if (!ms) return '无偏移';
    const sign = ms > 0 ? '+' : '-';
    return sign + (Math.abs(ms) / 1000).toFixed(2) + 's';
  }

  /**
   * 观感显示: 面板里给人看的一律是"高亮怎么动了", 不是偏移数值的正负。
   * 负偏移 = 句子区间整体前移 = 同一时刻高亮落到更靠后的句子 = **高亮提前**。
   * 数值方向和观感方向天生相反, 第一版直接把 ±ms 摆在面板上, 实测没人能一次按对。
   */
  function describeOffset(ms) {
    if (!ms) return '未校准';
    const s = (Math.abs(ms) / 1000).toFixed(2) + 's';
    return (ms < 0 ? '高亮提前 ' : '高亮延后 ') + s;
  }

  global.AiduTimingOffsets = {
    offsetAt,
    normalize,
    nudge,
    applyToSentences,
    repairMonotonic,
    formatOffset,
    describeOffset,
  };
})(typeof window !== 'undefined' ? window : globalThis);
