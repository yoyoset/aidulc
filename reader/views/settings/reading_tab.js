/**
 * views/settings/reading_tab.js —— 设置页「阅读显示」tab (主题/主题色/儿童模式)
 * 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 settings_view.js 拆出。
 * PALETTES 仍是 SettingsView 的静态成员(见该文件), 这里在调用时按运行时全局引用
 * (脚本加载顺序不影响, 因为只在 render 实际执行时才读取, 不在模块解析期读取)。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsReadingTab {
    /** @param {HTMLElement} pane 挂载点(「阅读显示」tab 的 pane) */
    render(pane) {
      // L9 (2026-08-11): 阅读显示这节放**真正的全局设置** —— 主题/主题色/儿童模式。
      // 字号/行距/栏宽/高亮只在阅读器浮层里调 (改的时候能看到效果), 设置页不再放只读摘要。
      // 先点明与「学习档案」的边界: 档案是处理参数(影响生成的内容), 这里是显示偏好(不影响生成)。
      AiduSettingsService.get('default').then((res) => {
        if (!res.ok) { pane.appendChild(el('div', 'global-error', '读设置失败: ' + res.error)); return; }
        const s = res.data || {};
        const form = el('div', 'settings-form');

        form.appendChild(el('div', 'settings-hint',
          '这里只影响**显示外观** (怎么读), 不影响已生成的内容。字号/行距/栏宽/高亮在阅读器内调整。'));
        form.appendChild(el('div', 'settings-hint settings-warn',
          '与「学习档案」不同: 档案 (成人自读/陪小孩读) 是处理参数, 决定讲解深度/音色/语速, 影响下次生成的内容; 这里只改显示, 不碰生成。'));

        // 主题 (浅色/深色/跟随系统) —— M6 (2026-08-12): 主题在上, 主题色紧随其下,
        // 标签紧贴各自控件 (此前"主题色"标签被先 append, 实际顺序变成 主题色→主题→色点,
        // 用户指出"标签与控件错位")。
        const themeLabel = el('div', 'settings-hint', '主题');
        const themeRow = el('div', 'prep-row');
        const themeSel = el('select', 'prep-select');
        const THEMES = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
        THEMES.forEach(([k, l]) => {
          const opt = el('option', null, l); opt.value = k;
          themeSel.appendChild(opt);
        });
        themeSel.value = ['light', 'dark', 'system'].includes(s.theme) ? s.theme : 'light';
        themeSel.onchange = () => this._saveReadingSettings(Object.assign({}, s, { theme: themeSel.value, updated_at: Date.now() }), themeSel);
        themeRow.appendChild(themeSel);
        form.appendChild(themeLabel);
        form.appendChild(themeRow);
        // 主题色 (色块 chips, 与阅读器浮层同一套 PALETTES) —— 标签紧随主题之下
        const paletteLabel = el('div', 'settings-hint', '主题色');
        const palettes = SettingsView.PALETTES;
        const activePalette = s.palette || 'clay';
        const chipsRow = el('div', 'rd-theme-chips');
        form.appendChild(paletteLabel);
        palettes.forEach(([key, label, color]) => {
          const c = el('button', 'rd-theme-chip' + (activePalette === key ? ' active' : ''));
          c.style.setProperty('--chip', color);
          c.title = label;
          c.dataset.palette = key;
          c.onclick = () => {
            chipsRow.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
            c.classList.add('active');
            this._saveReadingSettings(Object.assign({}, s, { palette: key, updated_at: Date.now() }));
          };
          chipsRow.appendChild(c);
        });
        form.appendChild(chipsRow);
        // 儿童模式: 勾选框 + 必须说明它到底改了什么 (L9 要求写明)
        const kidRow = el('label', 'settings-row');
        const kidCheck = el('input', '');
        kidCheck.type = 'checkbox';
        kidCheck.checked = !!s.child_mode;
        kidCheck.onchange = () => this._saveReadingSettings(Object.assign({}, s, { child_mode: kidCheck.checked, updated_at: Date.now() }), kidCheck);
        kidRow.appendChild(kidCheck);
        kidRow.appendChild(el('span', null, '儿童模式'));
        const kidExplain = el('div', 'settings-hint',
          '儿童模式改的是显示: 字号更大、对比度更高、默认词级高亮 (更适合跟读)。只影响显示, 不影响生成的内容。');

        form.append(kidRow, kidExplain);
        pane.appendChild(form);
        this._applyCss(s);
      });
    }

    /** L9 (2026-08-11): 阅读显示全局设置保存 —— 完整 ReaderSettings upsert (只改这几个字段) */
    _saveReadingSettings(merged, controlEl) {
      AiduSettingsService.upsert(merged).then((r) => {
        if (!r.ok) {
          if (controlEl) controlEl.disabled = false;
          if (typeof AiduToast !== 'undefined') AiduToast.show('保存失败: ' + r.error, 'error');
          return;
        }
        this._applyCss(merged);
        if (typeof AiduToast !== 'undefined') AiduToast.show('已保存', 'success');
      });
    }

    _applyCss(s) {
      const root = document.documentElement;
      root.style.setProperty('--rd-text', (s.font_size || 19) + 'px');
      root.style.setProperty('--rd-lh', s.line_height || 1.85);
      root.style.setProperty('--rd-measure', (s.content_width || 660) + 'px');
      root.dataset.kid = s.child_mode ? '1' : '0';
      // L9 (2026-08-11): theme 支持 system (跟随系统) —— 解析后再上 body
      document.body.dataset.theme = (global.AiduTheme && AiduTheme.resolveTheme)
        ? AiduTheme.resolveTheme(s.theme)
        : (s.theme || 'light');
      document.body.dataset.palette = s.palette || 'clay';
    }
  }

  global.SettingsReadingTab = SettingsReadingTab;
})(window);
