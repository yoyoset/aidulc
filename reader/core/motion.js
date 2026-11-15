/**
 * core/motion.js —— 系统「减少动态效果」偏好 (纯逻辑, 零 DOM 依赖, E7 2026-11-15)
 *
 * 有前庭敏感或晕动症的用户会在系统里打开「减少动态效果」。CSS 的过渡/动画由 app.css 末尾的
 * `@media (prefers-reduced-motion: reduce)` 统一压掉, 但 JS 里 `behavior: 'smooth'` 的滚动
 * 不受那条规则管 —— 通篇跟读时正文每句都平滑滚一次, 对这类用户是最容易引起不适的一处。
 * 所有 JS 平滑滚动都走这里取 behavior。
 */
(function (global) {
  'use strict';

  /** @param {object} [win] 测试时可传入带 matchMedia 的假 window */
  function prefersReducedMotion(win) {
    const w = win || global;
    try {
      return !!(w && typeof w.matchMedia === 'function' && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false; // 取不到偏好 → 当作没开 (保持原有行为), 不抛错
    }
  }

  /** scrollTo / scrollIntoView 的 behavior 值: 开了减少动态 → 'auto' (瞬间跳), 否则 'smooth' */
  function scrollBehavior(win) {
    return prefersReducedMotion(win) ? 'auto' : 'smooth';
  }

  global.AiduMotion = { prefersReducedMotion, scrollBehavior };
})(window);
