/**
 * views/reader/sync_calibrator.js —— 跟读时间轴人工校准面板 (2026-08-31)
 *
 * 为什么需要人工校准 (实测背景见 core/timing_offsets.js 与 memory/pipeline.md):
 * 章节 opus 可能与时间轴差出几秒到十几秒, 且误差是**阶跃**的 —— 在某一句突然产生、
 * 之后恒定。所以"读到错位处, 从当前句起整体平移一次"就能管到章尾, 这不是权宜之计,
 * 是与实测误差形状匹配的正确操作。
 *
 * 本组件只做 UI 与交互, 所有时间计算在 core/timing_offsets.js (纯函数, 有单测)。
 * 落库交给 reader_view 的回调, 组件自身不碰 IPC。
 */
(function (global) {
  'use strict';

  const T = () => global.AiduTimingOffsets;

  class SyncCalibrator {
    /**
     * @param {object} deps {
     *   getAnchorIndex(): number,     // 当前正在播/停在哪一句
     *   getPlayheadMs(): number,      // 当前播放头 (ms)
     *   getAnchors(): Array,          // 本章锚点
     *   onNudge(fromSentence, deltaMs),// 叠加增量 (落库 + 重新应用)
     *   onAlign(fromSentence, deltaMs),// 「以当前句对齐」
     *   onReset(),                    // 复位本章
     * }
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-calibrator';
      this.el.hidden = true;
      this._build();
    }

    _build() {
      const head = document.createElement('div');
      head.className = 'rd-calibrator-head';

      const title = document.createElement('span');
      title.className = 'rd-calibrator-title';
      title.textContent = '跟读校准';
      head.appendChild(title);

      this.valueEl = document.createElement('span');
      this.valueEl.className = 'rd-calibrator-value';
      head.appendChild(this.valueEl);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'rd-calibrator-close';
      close.textContent = '×';
      close.title = '收起';
      close.onclick = () => this.hide();
      head.appendChild(close);
      this.el.appendChild(head);

      // 说明: 让用户知道调整从哪里开始生效, 避免"我以为是全章"的误解
      this.hintEl = document.createElement('div');
      this.hintEl.className = 'rd-calibrator-hint';
      this.el.appendChild(this.hintEl);

      // 主操作: 以当前句对齐 —— 比手动试 ±0.1s 快得多
      const alignBtn = document.createElement('button');
      alignBtn.type = 'button';
      alignBtn.className = 'rd-calibrator-align';
      alignBtn.textContent = '以当前句对齐';
      alignBtn.title = '把正在念的这句搬到当前播放位置 (最快的校准方式)';
      alignBtn.onclick = () => this._align();
      this.el.appendChild(alignBtn);

      // 微调
      const row = document.createElement('div');
      row.className = 'rd-calibrator-row';
      [
        ['-0.5s', -500], ['-0.1s', -100], ['+0.1s', 100], ['+0.5s', 500],
      ].forEach(([label, delta]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rd-calibrator-step';
        b.textContent = label;
        b.title = delta < 0 ? '高亮往前赶 (声音跑在前面时用)' : '高亮往后推';
        b.onclick = () => this._nudge(delta);
        row.appendChild(b);
      });
      this.el.appendChild(row);

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'rd-calibrator-reset';
      reset.textContent = '复位本章';
      reset.onclick = () => this.deps.onReset && this.deps.onReset();
      this.el.appendChild(reset);
    }

    _currentIndex() {
      const i = this.deps.getAnchorIndex ? this.deps.getAnchorIndex() : -1;
      return i >= 0 ? i : 0;
    }

    _nudge(delta) {
      if (this.deps.onNudge) this.deps.onNudge(this._currentIndex(), delta);
    }

    _align() {
      if (!this.deps.onAlign) return;
      this.deps.onAlign(this._currentIndex(), this.deps.getPlayheadMs ? this.deps.getPlayheadMs() : 0);
    }

    /** 锚点或当前句变化后刷新显示 */
    refresh() {
      if (this.el.hidden) return; // 收起时不做无谓计算 (播放中每次切句都会调到这里)
      const i = this._currentIndex();
      const off = T().offsetAt(this.deps.getAnchors ? this.deps.getAnchors() : [], i);
      this.valueEl.textContent = T().formatOffset(off);
      this.valueEl.classList.toggle('is-zero', !off);
      this.hintEl.textContent = `调整从第 ${i + 1} 句起生效, 之前的不受影响`;
    }

    toggle() {
      if (this.el.hidden) this.show();
      else this.hide();
    }

    show() {
      this.el.hidden = false;
      this.refresh();
    }

    hide() {
      this.el.hidden = true;
    }

    get visible() {
      return !this.el.hidden;
    }
  }

  global.SyncCalibrator = SyncCalibrator;
})(window);
