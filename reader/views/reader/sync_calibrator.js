/**
 * views/reader/sync_calibrator.js —— 跟读时间轴人工校准面板
 *
 * 为什么需要人工校准: 章节 opus 可能与时间轴差出几秒到十几秒 (陈旧产物, 根因已修但
 * 存量书需重跑)。算法治不了拟声词/哑音这类东西, 所以留一条人工纠偏的路。
 *
 * 只有两个操作: **手动微调** 和 **复位本章**。
 *
 * 2026-09-01 删掉了「自动对齐」(让用户点出自己正听到的那一句, 按两句起点之差平移)。
 * 不是嫌它麻烦, 是它**分辨率不够**, 用户实测两轮各撞到一个坎:
 *
 *   第一轮: 锚点打在"听到的那句"上, 而锚点语义是"从第 N 句起平移、之前的原封不动",
 *           高亮落后时播放头所在的那句排在锚点前面, 于是当场纹丝不动。改成锚在靠前
 *           那句后, 真实时间轴 9/9 全对 (见 git 1402c69)。
 *   第二轮: **句子够长时它根本无解**。错位小于句长时, 用户听到的就是高亮那一句
 *           (H == A), 起点之差 = 0, 按下去显示"未校准"、什么也没发生。而句子长到
 *           十几秒是常态 —— 也就是说在最常见的量级上它是失效的。
 *
 * 要做到句内精度, 选择粒度就得降到**词**(词级时间轴是有的)。那是另一套交互, 在
 * 手动微调已经够用的前提下不值得再叠一层 —— 用户的原话是"我可以通过调整来把语音和
 * 高亮对齐"。**一个用不上的按钮比没有更糟**, 所以是删而不是留着当摆设。
 *
 * 另外两条设计约束是实测踩出来的, 改这个文件前先读:
 * - **校准目标句要冻结**。通篇模式下高亮随播放不断前进, 不冻结的话连按几次微调会在
 *   几个不同句上各建一条锚点 (实测库里 ch5 留下 55/56/57/60 四条)。目标句在**打开
 *   面板时**取当前句并冻结; 想换一句就收起再打开 (⏱ 按两下)。
 * - **面板里不出现裸的 ±ms**。"偏移 +0.5s"= 句子区间整体后移 = 用户看到的高亮**变晚**,
 *   数值方向和观感方向天生相反, 实测没人能一次按对。按钮和读数一律用观感说话。
 *
 * 本组件只做 UI 与交互, 时间计算全在 core/timing_offsets.js (纯函数, 有单测)。
 */
(function (global) {
  'use strict';

  const T = () => global.AiduTimingOffsets;

  // 观感方向 → 偏移符号: "高亮提前" = 句子区间整体前移 = 负偏移。
  // 步长 ±0.5/±2s: 实测错位是秒级 (Winn-Dixie ch16 差 13.5s), 0.1s 一格要按上百次。
  const STEPS = [
    { label: '2s', delta: -2000, dir: 'earlier' },
    { label: '0.5s', delta: -500, dir: 'earlier' },
    { label: '0.5s', delta: 500, dir: 'later' },
    { label: '2s', delta: 2000, dir: 'later' },
  ];

  class SyncCalibrator {
    /**
     * @param {object} deps {
     *   getHighlightIndex(): number,   // 高亮此刻停在哪句 (打开面板时取一次, 之后冻结)
     *   getAnchors(): Array,           // 本章锚点
     *   onNudge(fromSentence, deltaMs),// 叠加增量 (落库 + 重新应用)
     *   onReset(),                     // 复位本章
     * }
     */
    constructor(deps) {
      this.deps = deps;
      /** 校准目标句: 冻结值。所有微调都落到这一条锚点上, 不随播放漂移 (见文件头) */
      this._from = 0;
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

      this.hintEl = document.createElement('div');
      this.hintEl.className = 'rd-calibrator-hint';
      this.el.appendChild(this.hintEl);

      // 微调: 按观感分成"提前"和"延后"两组, 面板里不出现裸的 ±ms (见文件头)
      const row = document.createElement('div');
      row.className = 'rd-calibrator-row';
      const groups = {
        earlier: this._group('高亮提前', '声音已经念到后面了, 高亮还在原地'),
        later: this._group('高亮延后', '高亮跑到声音前面去了'),
      };
      STEPS.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rd-calibrator-step';
        b.textContent = s.label;
        b.title = (s.dir === 'earlier' ? '高亮提前 ' : '高亮延后 ') + s.label;
        b.onclick = () => this._nudge(s.delta);
        groups[s.dir].appendChild(b);
      });
      row.append(groups.earlier.parentNode, groups.later.parentNode);
      this.el.appendChild(row);

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'rd-calibrator-reset';
      reset.textContent = '复位本章 (回到原始时间轴)';
      reset.onclick = () => this.deps.onReset && this.deps.onReset();
      this.el.appendChild(reset);
    }

    /** 一组方向按钮: <div class=group><span 标题><div 按钮容器>> */
    _group(label, why) {
      const box = document.createElement('div');
      box.className = 'rd-calibrator-group';
      box.title = why;
      const cap = document.createElement('span');
      cap.className = 'rd-calibrator-cap';
      cap.textContent = label;
      box.appendChild(cap);
      const btns = document.createElement('div');
      btns.className = 'rd-calibrator-btns';
      box.appendChild(btns);
      return btns;
    }

    _nudge(delta) {
      if (this.deps.onNudge) this.deps.onNudge(this._from, delta);
      this.refresh();
    }

    /** 锚点变化后刷新显示 */
    refresh() {
      if (this.el.hidden) return; // 收起时不做无谓计算 (播放中每次切句都会调到这里)
      const off = T().offsetAt(this.deps.getAnchors ? this.deps.getAnchors() : [], this._from);
      this.valueEl.textContent = T().describeOffset(off);
      this.valueEl.classList.toggle('is-zero', !off);
      this.hintEl.textContent =
        `从第 ${this._from + 1} 句起生效, 之前的不受影响 (收起再打开可改到当前句)`;
    }

    toggle() {
      if (this.el.hidden) this.show();
      else this.hide();
    }

    show() {
      // 打开时把校准目标冻结在当前句, 之后微调不再随播放漂移。
      const i = this.deps.getHighlightIndex ? this.deps.getHighlightIndex() : -1;
      this._from = i >= 0 ? i : 0;
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
