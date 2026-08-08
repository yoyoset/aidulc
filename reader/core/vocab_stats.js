/**
 * core/vocab_stats.js —— 生词积累统计 (纯逻辑, 零 DOM, M7 R34)
 * 近 N 天每日新增生词条形图数据。数据源: vocab 条目的 added_at (epoch ms)。
 */
(function (global) {
  'use strict';

  const DAY_MS = 86400000;

  /**
   * 近 days 天每日新增数。返回 [{day: 当天零点 epoch ms, count}] 从旧到新。
   * added_at 在未来(时钟错乱)或太老(超窗口)的条目不计入。
   */
  function dailyBuckets(entries, days, now) {
    const n = days || 14;
    const nowMs = now || Date.now();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      out.push({ day: nowMs - i * DAY_MS, count: 0 });
    }
    (entries || []).forEach((e) => {
      const t = e.added_at || 0;
      if (!t) return;
      const idx = Math.floor((nowMs - t) / DAY_MS);
      if (idx >= 0 && idx < n) out[n - 1 - idx].count++;
    });
    return out;
  }

  global.AiduVocabStats = { dailyBuckets, DAY_MS };
})(window);
