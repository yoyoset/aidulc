/**
 * timeline.js —— 词级时间轴二分查找(纯函数,无 DOM)
 * words[] = [{seg_idx, start_ms, end_ms}, ...] —— 词时间是**句内相对 ms** (Kokoro 输出),
 * 查找时要用 audio.currentTime - sentence.audio.start_ms 换算成句内时间。
 */
(function (global) {
  'use strict';

  /** 二分查找 currentTimeMs (句内相对) 命中的词,返回 words 下标;无命中返回 -1 */
  function findWordIndex(words, currentTimeMs) {
    if (!words || words.length === 0) return -1;
    let lo = 0, hi = words.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = words[mid];
      if (currentTimeMs < w.start_ms) hi = mid - 1;
      else if (currentTimeMs >= w.end_ms) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /**
   * 找当前句: 用音频绝对时间定位句子 (audio.start_ms/end_ms 是章节累计绝对 ms, 连续递增)。
   * P0: 从线性查找改为二分 (3000+ 句时线性查找在 60Hz 下有明显成本)。
   */
  function findSentenceIndex(sentences, currentTimeMs) {
    if (!sentences || sentences.length === 0) return -1;
    let lo = 0, hi = sentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = sentences[mid].audio;
      if (!a) { hi = mid - 1; continue; }
      if (currentTimeMs < a.start_ms) hi = mid - 1;
      else if (currentTimeMs >= a.end_ms) lo = mid + 1;
      else return mid;
    }
    // 未命中区间: 落在句间留白里, 返回最近的上一个句子 (句间 400ms 留白时高亮保持上一句)
    if (lo > 0 && lo <= sentences.length) return lo - 1;
    return -1;
  }

  global.AiduTimeline = { findWordIndex, findSentenceIndex };
})(window);
