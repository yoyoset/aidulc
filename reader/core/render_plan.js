/**
 * core/render_plan.js —— 渐进式渲染的补渲染区间计划(纯逻辑, 无 DOM, R1)
 *
 * 阅读器正文从"一次建完整章"改成"滚动到哪渲染到哪", 但"要补建到哪个下标"
 * 的边界决策必须收敛到一个可单测的纯函数里, 不能让每个调用点各算各的。
 * 本模块被 reader_renderer.js 的 ensureRendered / IntersectionObserver 共用。
 */
(function (global) {
  'use strict';

  /** targetIndex 封顶到合法区间 [0, total-1]; 书为空时返回 -1 */
  function clampTotal(targetIndex, total) {
    if (!total || total <= 0) return -1;
    return Math.max(0, Math.min(targetIndex, total - 1));
  }

  /** 需要补建到的实际下标(封顶 total-1); 已经建过(<= renderedUpTo)或书为空 → -1 */
  function neededUpTo(renderedUpTo, targetIndex, total) {
    const t = clampTotal(targetIndex, total);
    if (t < 0) return -1;
    return t <= renderedUpTo ? -1 : t;
  }

  /**
   * 从当前进度补建到 targetIndex, 返回 [{from, to}] 分片(每片长度 <= batchSize)。
   * 供 ensureRendered(远跳时逐片让帧)和 IntersectionObserver(每次一片)共用。
   * 无需要补建时返回空数组。
   */
  function renderRanges(renderedUpTo, targetIndex, batchSize, total) {
    const need = neededUpTo(renderedUpTo, targetIndex, total);
    if (need < 0) return [];
    const out = [];
    let from = renderedUpTo + 1;
    while (from <= need) {
      const to = Math.min(from + batchSize - 1, need);
      out.push({ from, to });
      from = to + 1;
    }
    return out;
  }

  global.AiduRenderPlan = { clampTotal, neededUpTo, renderRanges };
})(window);
