/**
 * views/reader/settings_overlay.js —— 页面设置浮层 (S5, 设计 §2.6/§3)
 * 字号/行距/栏宽/语速全部图形化档位, 不出现裸数字输入框:
 *   Aa 四档 · 行距三档线条示意 · 栏宽三档条形 · 语速五格柱
 * 另有主题 / 儿童取值两个开关。改动经 onPatch 回写 settings 并即时应用。
 */
(function (global) {
  'use strict';

  // 档位取值表 (与 ReaderSettings 字段一一对应)
  const FONT_SIZES = [16, 19, 22, 27];
  const LINE_HEIGHTS = [1.6, 1.85, 2.1];
  const CONTENT_WIDTHS = [560, 660, 760];
  const SPEEDS = [0.7, 0.8, 0.9, 1.0, 1.2];

  function indexOf(list, value) {
    const i = list.indexOf(value);
    return i >= 0 ? i : 0;
  }

  class SettingsOverlay {
    /**
     * @param {object} deps
     *   settings: ReaderSettings 当前值
     *   onPatch(patch): 应用 + 落盘
     */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('div');
      this.el.className = 'rd-settings';
      this._build();
    }

    _build() {
      const s = this.deps.settings || {};
      const el = this.el;

      const title = document.createElement('div');
      title.className = 'rd-settings-title';
      title.textContent = '页面设置';
      el.appendChild(title);

      // 字号 四档 Aa
      const fs = this._row('字号', 'Aa', FONT_SIZES, indexOf(FONT_SIZES, s.font_size), (v) => this.deps.onPatch({ font_size: v }));
      el.appendChild(fs);

      // 行距 三档线条
      const lh = this._row('行距', '', LINE_HEIGHTS, indexOf(LINE_HEIGHTS, s.line_height), (v) => this.deps.onPatch({ line_height: v }));
      el.appendChild(lh);

      // 栏宽 三档条形
      const cw = this._row('栏宽', '', CONTENT_WIDTHS, indexOf(CONTENT_WIDTHS, s.content_width), (v) => this.deps.onPatch({ content_width: v }));
      el.appendChild(cw);

      // 语速 五格柱
      const sp = this._row('语速', '', SPEEDS, indexOf(SPEEDS, s.speed), (v) => this.deps.onPatch({ speed: v }));
      el.appendChild(sp);

      // 高亮粒度 (词节奏 / 句节奏)
      const gran = this._textRow('高亮', ['词', '句'], s.highlight_granularity === 'word' ? 0 : 1,
        (v) => this.deps.onPatch({ highlight_granularity: v === 0 ? 'word' : 'sentence' }));
      el.appendChild(gran);

      // 主题
      const theme = this._toggleRow('深色主题', s.theme === 'dark', (v) => this.deps.onPatch({ theme: v ? 'dark' : 'light' }));
      el.appendChild(theme);

      // M7 R23: 主题色系 (palette, 与明暗正交) —— 色块 chips + 自定义
      const PALETTES = [['clay', '陶土', 'var(--swatch-clay)'], ['sage', '青苔', 'var(--swatch-sage)'],
        ['ocean', '海蓝', 'var(--swatch-ocean)'], ['rose', '蔷薇', 'var(--swatch-rose)'], ['slate', '灰蓝', 'var(--swatch-slate)']];
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'rd-settings-row';
      const chipLabel = document.createElement('span');
      chipLabel.className = 'rd-settings-label';
      chipLabel.textContent = '主题色';
      chipsWrap.appendChild(chipLabel);
      const chips = document.createElement('div');
      chips.className = 'rd-theme-chips';
      const activePalette = s.palette || 'clay';
      PALETTES.forEach(([key, label, color]) => {
        const c = document.createElement('button');
        c.className = 'rd-theme-chip' + (activePalette === key ? ' active' : '');
        c.title = label;
        c.style.setProperty('--chip', color);
        c.onclick = () => {
          chips.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
          c.classList.add('active');
          colorRow.style.display = 'none';
          this.deps.onPatch({ palette: key });
        };
        chips.appendChild(c);
      });
      const customChip = document.createElement('button');
      customChip.className = 'rd-theme-chip' + (activePalette === 'custom' ? ' active' : '');
      customChip.title = '自定义颜色';
      customChip.style.setProperty('--chip', 'conic-gradient(#b06a4b, #4a6a80, #5d7a58, #96626d, #b06a4b)');
      customChip.onclick = () => {
        chips.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
        customChip.classList.add('active');
        colorRow.style.display = '';
        this.deps.onPatch({ palette: 'custom' });
      };
      chips.appendChild(customChip);
      chipsWrap.appendChild(chips);
      el.appendChild(chipsWrap);

      // 自定义色输入 (仅 custom 显示)
      const colorRow = document.createElement('div');
      colorRow.className = 'rd-settings-row';
      const colorLabel = document.createElement('span');
      colorLabel.className = 'rd-settings-label';
      colorLabel.textContent = '自定义色';
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = /^#[0-9a-fA-F]{6}$/.test(s.custom_color || '') ? s.custom_color : '#3b6b8a';
      colorRow.append(colorLabel, colorInput);
      colorRow.style.display = activePalette === 'custom' ? '' : 'none';
      colorInput.onchange = () => this.deps.onPatch({ palette: 'custom', custom_color: colorInput.value });
      el.appendChild(colorRow);

      // 儿童取值
      const kid = this._toggleRow('儿童取值', !!s.child_mode, (v) => this.deps.onPatch({ child_mode: v }));
      el.appendChild(kid);
    }

    _textRow(label, labels, selectedIndex, onPick) {
      const row = document.createElement('div');
      row.className = 'rd-settings-row';
      const lab = document.createElement('span');
      lab.className = 'rd-settings-label';
      lab.textContent = label;
      row.appendChild(lab);
      const seg = document.createElement('div');
      seg.className = 'rd-settings-seg';
      labels.forEach((txt, i) => {
        const btn = document.createElement('button');
        btn.className = 'rd-settings-opt rd-settings-text';
        btn.textContent = txt;
        if (i === selectedIndex) btn.classList.add('active');
        btn.onclick = () => {
          seg.querySelectorAll('.rd-settings-opt').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          onPick(i);
        };
        seg.appendChild(btn);
      });
      row.appendChild(seg);
      return row;
    }

    _row(label, symbol, values, selectedIndex, onPick) {
      const row = document.createElement('div');
      row.className = 'rd-settings-row';
      const lab = document.createElement('span');
      lab.className = 'rd-settings-label';
      lab.textContent = label;
      row.appendChild(lab);
      const seg = document.createElement('div');
      seg.className = 'rd-settings-seg';
      values.forEach((v, i) => {
        const btn = document.createElement('button');
        btn.className = 'rd-settings-opt';
        if (i === selectedIndex) btn.classList.add('active');
        if (symbol) {
          btn.textContent = symbol;
          btn.classList.add('rd-settings-a' + (i + 1));
        } else {
          btn.classList.add('rd-settings-dot-' + values.length);
        }
        btn.title = String(v);
        btn.onclick = () => {
          seg.querySelectorAll('.rd-settings-opt').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          onPick(v);
        };
        seg.appendChild(btn);
      });
      row.appendChild(seg);
      return row;
    }

    _toggleRow(label, checked, onToggle) {
      const row = document.createElement('div');
      row.className = 'rd-settings-row';
      const lab = document.createElement('span');
      lab.className = 'rd-settings-label';
      lab.textContent = label;
      row.appendChild(lab);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.onchange = () => onToggle(box.checked);
      row.appendChild(box);
      return row;
    }

    /** 打开前由宿主更新当前设置快照 (render 早于 open, 构造时的 settings 可能为空) */
    setSettings(settings) {
      this.deps.settings = settings;
    }

    open() {
      // 每次打开重建档位 → 高亮始终反映当前值 (字号/语速可能被预设/微调改过)
      this.el.innerHTML = '';
      this._build();
      this.el.classList.add('open');
    }

    close() {
      this.el.classList.remove('open');
    }

    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }

    isOpen() {
      return this.el.classList.contains('open');
    }
  }

  SettingsOverlay.FONT_SIZES = FONT_SIZES;
  SettingsOverlay.LINE_HEIGHTS = LINE_HEIGHTS;
  SettingsOverlay.CONTENT_WIDTHS = CONTENT_WIDTHS;
  SettingsOverlay.SPEEDS = SPEEDS;

  global.SettingsOverlay = SettingsOverlay;
})(window);
