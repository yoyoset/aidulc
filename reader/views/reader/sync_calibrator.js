/**
 * views/reader/sync_calibrator.js —— 跟读时间轴人工校准面板 (2026-08-31, 09-01 重做交互)
 *
 * 为什么需要人工校准: 章节 opus 可能与时间轴差出几秒到十几秒 (陈旧 opus, 根因已修但
 * 存量书需重跑)。算法治不了拟声词/哑音这类东西, 所以留一条人工纠偏的路。
 *
 * 2026-09-01 重做, 起因是第一版实测三处不可用 (每处都有数据佐证, 见各条注释):
 *
 * 1. **「以当前句对齐」算的是废数** —— 它拿"高亮当前停在哪句"当作"用户听到的是哪句",
 *    可这两者不同正是要校准的原因。delta = 播放头 - 该句起点, 永远落在 [0, 句长) 里,
 *    是个几百毫秒的正数, 修不了几秒的错位。实测残留在库里的锚点 (ch5 句54 = +4146ms)
 *    就是这么来的。**必须由用户指出他真正听到的是哪一句**, 所以改成"点正文选句"。
 * 2. **微调按钮会撒锚点** —— 通篇模式下 _anchorIndex 随播放不断前进, 连按四次 ±0.1s
 *    会在四个不同句上各建一条锚点 (实测库里 ch5 有 55/56/57/60 四条)。现在校准目标
 *    在打开面板/选句时**冻结**, 之后所有微调都改同一条锚点。
 * 3. **±号读反** —— "偏移 +0.5s"意味着句子区间整体后移, 用户看到的是**高亮变晚**。
 *    数值方向和观感方向相反, 没人能一次按对。现在按钮和读数一律用观感说话:
 *    「高亮提前 / 高亮延后」, 面板里不出现裸的 ±ms。
 *
 * 步长也从 ±0.1/±0.5 改成 ±0.5/±2 —— 实测错位是秒级 (ch5 末尾 3.9s), 0.1s 一格要按
 * 四十次。
 *
 * 本组件只做 UI 与交互, 时间计算全在 core/timing_offsets.js (纯函数, 有单测)。
 */
(function (global) {
  'use strict';

  const T = () => global.AiduTimingOffsets;

  // 观感方向 → 偏移符号: "高亮提前" = 句子区间整体前移 = 负偏移。
  const STEPS = [
    { label: '2s', delta: -2000, dir: 'earlier' },
    { label: '0.5s', delta: -500, dir: 'earlier' },
    { label: '0.5s', delta: 500, dir: 'later' },
    { label: '2s', delta: 2000, dir: 'later' },
  ];

  class SyncCalibrator {
    /**
     * @param {object} deps {
     *   getHighlightIndex(): number,   // 高亮此刻停在哪句 (时间轴说的, 可能是错的那句)
     *   getAnchors(): Array,           // 本章锚点
     *   onNudge(fromSentence, deltaMs),// 叠加增量 (落库 + 重新应用)
     *   onAlign(heardIndex, highlightedIndex), // 「我听到的其实是这句」
     *   onReset(),                     // 复位本章
     *   beginPick(cb),                 // 进入选句模式, 用户点正文某句后回调 cb(index)
     *   cancelPick(),                  // 退出选句模式
     *   pausePlayback(),               // 进选句模式前暂停 (否则边听边点, 听到的句一直在变)
     * }
     */
    constructor(deps) {
      this.deps = deps;
      /** 校准目标句: 冻结值。所有微调都落到这一条锚点上, 不随播放漂移 (见文件头 #2) */
      this._from = 0;
      this._picking = false;
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

      // 主操作: 由用户指出他**真正听到**的是哪一句 (见文件头 #1)
      this.alignBtn = document.createElement('button');
      this.alignBtn.type = 'button';
      this.alignBtn.className = 'rd-calibrator-align';
      this.alignBtn.onclick = () => this._togglePick();
      this.el.appendChild(this.alignBtn);

      // 微调: 按观感分成"提前"和"延后"两组, 面板里不出现裸的 ±ms (见文件头 #3)
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
      reset.onclick = () => {
        this._cancelPick();
        if (this.deps.onReset) this.deps.onReset();
      };
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
      this._cancelPick();
      if (this.deps.onNudge) this.deps.onNudge(this._from, delta);
      this.refresh();
    }

    _togglePick() {
      if (this._picking) { this._cancelPick(); return; }
      if (!this.deps.beginPick) return;
      // 暂停再选: 边播边选的话, "我正在听的这句"在用户抬手点下去时已经过去了。
      if (this.deps.pausePlayback) this.deps.pausePlayback();
      const highlighted = this.deps.getHighlightIndex ? this.deps.getHighlightIndex() : -1;
      this._picking = true;
      this._syncPickUI();
      this.deps.beginPick((picked) => {
        this._picking = false;
        const shown = highlighted >= 0 ? highlighted : picked;
        // 锚点由 onAlign 决定 (靠前那句, 见 core/timing_offsets.js::alignAnchor),
        // 不是用户点的那句 —— 后续微调必须落到同一条锚点上, 否则又是撒一片。
        const from = this.deps.onAlign ? this.deps.onAlign(picked, shown) : picked;
        this._from = Number.isFinite(from) ? from : picked;
        this.refresh();
      });
    }

    _cancelPick() {
      if (!this._picking) return;
      this._picking = false;
      if (this.deps.cancelPick) this.deps.cancelPick();
      this._syncPickUI();
    }

    _syncPickUI() {
      this.alignBtn.textContent = this._picking
        ? '↓ 现在点正文里你听到的那一句 (再点此处取消)'
        : '对齐: 我听到的其实是另一句';
      this.alignBtn.classList.toggle('is-picking', this._picking);
      this.el.classList.toggle('is-picking', this._picking);
    }

    /** 锚点或当前句变化后刷新显示 */
    refresh() {
      if (this.el.hidden) return; // 收起时不做无谓计算 (播放中每次切句都会调到这里)
      const off = T().offsetAt(this.deps.getAnchors ? this.deps.getAnchors() : [], this._from);
      this.valueEl.textContent = T().describeOffset(off);
      this.valueEl.classList.toggle('is-zero', !off);
      this.hintEl.textContent = `从第 ${this._from + 1} 句起生效, 之前的不受影响`;
      this._syncPickUI();
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
      this._cancelPick();
      this.el.hidden = true;
    }

    get visible() {
      return !this.el.hidden;
    }
  }

  global.SyncCalibrator = SyncCalibrator;
})(window);
