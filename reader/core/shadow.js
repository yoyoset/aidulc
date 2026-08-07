/**
 * shadow.js —— 跟读状态机(纯逻辑, 无 DOM)
 *
 * 模式:
 * - repeat_n: 当前句重复 N 次 (每次播完句末留白)
 * - ab_loop: A-B 区间循环
 * - gap: 句末留白 ms
 * - speed: 变速不变调 (HTML5 audio.playbackRate 支持)
 *
 * 状态机输入: 时间事件 (sentence done / user actions), 输出: 应执行的动作。
 */
(function (global) {
  'use strict';

  class ShadowMachine {
    constructor() {
      this.repeatCount = 1;      // 单句重复 N 次
      this.repeatLeft = 0;
      this.abLoop = null;        // {start_ms, end_ms}
      this.gapMs = 500;          // 句末留白
      this.speed = 1.0;
      this.currentSentence = -1;
      this.onAction = null;      // (action: {type, sentenceIndex}) 回调
    }

    /** 句开始播放时调用: 重置重复计数 */
    sentenceStarted(index) {
      if (index !== this.currentSentence) {
        this.currentSentence = index;
        this.repeatLeft = this.repeatCount;
      }
    }

    /** 句播放完成时调用: 决定下一动作 */
    sentenceEnded(index, onComplete) {
      if (index !== this.currentSentence) return;
      this.repeatLeft--;
      if (this.repeatLeft > 0) {
        // 需要重复本句
        if (this.onAction) this.onAction({ type: 'repeat', sentenceIndex: index, gapMs: this.gapMs });
      } else {
        // 本句重复完毕, 播下一句
        if (this.onAction) this.onAction({ type: 'next', sentenceIndex: index + 1 });
        if (onComplete) onComplete();
      }
    }

    setRepeat(n) { this.repeatCount = Math.max(1, n); }
    setGap(ms) { this.gapMs = Math.max(0, ms); }
    setSpeed(s) { this.speed = Math.min(2, Math.max(0.5, s)); }

    /** A-B 循环: 设置区间; 传 null 关闭 */
    setABLoop(startMs, endMs) {
      this.abLoop = (startMs != null && endMs != null) ? { start_ms: startMs, end_ms: endMs } : null;
    }

    /** 判断当前时间是否应跳回 A (由 rAF 驱动调用) */
    shouldLoopBack(currentMs) {
      return this.abLoop && currentMs >= this.abLoop.end_ms;
    }

    loopBackPoint() {
      return this.abLoop ? this.abLoop.start_ms : null;
    }
  }

  global.ShadowMachine = ShadowMachine;
})(window);
