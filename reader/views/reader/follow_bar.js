/**
 * views/reader/follow_bar.js —— 逐句跟读条 (S5, 设计 §2.7/§3)
 * 仅逐句节奏存在。三个命名预设 + 节拍点(第几遍) + 参数说明 + 快捷键提示;
 * 数字仍可展开微调, 但默认不出现。跟读时注意力在耳朵和嘴上, 不在屏幕。
 */
(function (global) {
  'use strict';

  class FollowBar {
    /**
     * @param {object} deps
     *   presets: [{key,name,repeat,gapMs,speed,blind,desc}] (AiduFollowPresets.allPresets())
     *   activePreset: string key
     *   onSelectPreset(key)
     *   onFineTune(patch)   —— 展开的微调数字变化 {repeat|gapMs|speed}
     *   onExit()            —— 退出逐句跟读 (回通篇)
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-follow';
      this._build();
    }

    _build() {
      const el = this.el;
      el.innerHTML = '';

      const left = document.createElement('div');
      left.className = 'rd-follow-left';

      const presetsWrap = document.createElement('div');
      presetsWrap.className = 'rd-follow-presets';
      (this.deps.presets || []).forEach((p) => {
        const b = document.createElement('button');
        b.className = 'rd-follow-preset';
        b.textContent = p.name;
        b.title = p.desc;
        b.dataset.key = p.key;
        if (p.key === this.deps.activePreset) b.classList.add('active');
        b.onclick = () => this.deps.onSelectPreset(p.key);
        presetsWrap.appendChild(b);
      });
      left.appendChild(presetsWrap);

      // 节拍点 (第几遍)
      this.beatsEl = document.createElement('div');
      this.beatsEl.className = 'rd-follow-beats';
      left.appendChild(this.beatsEl);

      // 参数说明 (当前预设描述 + 数值)
      this.paramsEl = document.createElement('div');
      this.paramsEl.className = 'rd-follow-params';
      left.appendChild(this.paramsEl);

      // 微调展开区 (默认隐藏)
      this.fineEl = document.createElement('div');
      this.fineEl.className = 'rd-follow-fine';
      const fineToggle = document.createElement('button');
      fineToggle.className = 'rd-follow-fine-toggle';
      fineToggle.textContent = '微调';
      fineToggle.onclick = () => {
        this.fineEl.classList.toggle('open');
        fineToggle.classList.toggle('active');
      };
      left.appendChild(fineToggle);
      left.appendChild(this.fineEl);
      this._fineInputs = {};
      el.appendChild(left);

      const right = document.createElement('div');
      right.className = 'rd-follow-right';
      const exit = document.createElement('button');
      exit.className = 'rd-follow-exit';
      exit.textContent = '退出跟读 (S)';
      exit.onclick = () => this.deps.onExit && this.deps.onExit();
      const hint = document.createElement('span');
      hint.className = 'rd-follow-hint';
      hint.textContent = 'Space 重播 · ↻ 切句';
      right.append(exit, hint);
      el.appendChild(right);
    }

    _makeFineInput(key, label, value, step, min, max) {
      const lab = document.createElement('label');
      lab.className = 'rd-follow-fine-item';
      lab.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = value;
      input.step = step;
      input.min = min;
      input.max = max;
      input.onchange = () => {
        let v = parseFloat(input.value);
        if (Number.isNaN(v)) v = 1;
        const patch = {};
        patch[key] = v;
        this.deps.onFineTune && this.deps.onFineTune(patch);
      };
      this._fineInputs[key] = input;
      lab.appendChild(input);
      return lab;
    }

    /**
     * 预设切换后的展示状态。
     * @param {object} p 当前预设 (AiduFollowPresets 的条目)
     */
    setPreset(p) {
      this.el.querySelectorAll('.rd-follow-preset').forEach((b) => {
        b.classList.toggle('active', b.dataset.key === p.key);
      });
      this.paramsEl.textContent = `${p.name}: ${p.repeat} 遍 · 留白 ${p.gapMs}ms · ${p.speed}x` + (p.blind ? ' · 只亮当前词' : '');
      // 重建微调区
      this.fineEl.innerHTML = '';
      this._fineInputs = {};
      this.fineEl.appendChild(this._makeFineInput('repeat', '重复', p.repeat, 1, 1, 10));
      this.fineEl.appendChild(this._makeFineInput('gapMs', '留白ms', p.gapMs, 100, 0, 3000));
      this.fineEl.appendChild(this._makeFineInput('speed', '速度', p.speed, 0.1, 0.5, 2));
    }

    /** 节拍点: 第几遍 (1..repeat) */
    setBeats(currentPass, totalPasses) {
      this.beatsEl.innerHTML = '';
      for (let i = 1; i <= totalPasses; i++) {
        const dot = document.createElement('span');
        dot.className = 'rd-follow-beat';
        if (i === currentPass) dot.classList.add('active');
        dot.textContent = String(i);
        this.beatsEl.appendChild(dot);
      }
    }
  }

  global.FollowBar = FollowBar;
})(window);
