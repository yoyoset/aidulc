/**
 * core/theme.js —— 主题色派生 (纯逻辑, 零 DOM, M7 R23)
 *
 * 五套预设之外, 允许用户自选强调色: 从一个 #rrggbb 推导出应用主色/容器/state 层/
 * 阅读器 accent。中性纸面/墨色不随自定义变(纸的底色是品牌)。
 *
 * on-primary 按 WCAG 相对亮度自动黑/白: 亮度 > 0.179 用黑字, 否则白字
 * (白色 on-primary 达标需 primary 亮度 ≤ ~0.179, 这是 WCAG 的临界点)。
 */
(function (global) {
  'use strict';

  function parseHex(hex) {
    const c = String(hex || '').replace('#', '');
    if (c.length === 3) return c.split('').map((x) => parseInt(x + x, 16));
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  function relativeLuminance(hex) {
    const rgb = parseHex(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  function contrast(a, b) {
    const l1 = relativeLuminance(a), l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /** 混色: t=0 → a, t=1 → b */
  function mix(a, b, t) {
    const A = parseHex(a), B = parseHex(b);
    return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
  }

  /**
   * L9 (2026-08-11): 解析主题设置 → 实际明暗值。
   * 支持三种: light / dark / system (跟随系统 prefers-color-scheme)。
   * @param {string|null|undefined} theme 设置的 theme 字段
   * @param {() => boolean} [systemDark] 注入系统深色判定 (测试用); 默认用 matchMedia
   * @returns {'light'|'dark'}
   */
  function resolveTheme(theme, systemDark) {
    if (theme === 'dark') return 'dark';
    if (theme === 'system') {
      if (systemDark !== undefined) return systemDark ? 'dark' : 'light';
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      return 'light';
    }
    return 'light';
  }

  /**
   * 从自定义强调色推导完整色变量表 (JS 内联写 --md-sys-* / --rd-*, 不碰 tokens.css)。
   * @returns {Object<string,string>} CSS 变量名 → 值
   */
  function deriveCustomPalette(hex) {
    const p = rgbToHex(parseHex(hex || '#9c6a4a'));
    const lum = relativeLuminance(p);
    const onPrimary = lum > 0.179 ? '#000000' : '#ffffff';
    const [r, g, b] = parseHex(p);
    const light = mix(p, '#ffffff', 0.82);   // primary-container (浅 tint)
    const deep = mix(p, '#000000', 0.58);    // on-primary-container (深 tint)
    return {
      '--md-sys-color-primary': p,
      '--md-sys-color-on-primary': onPrimary,
      '--md-sys-color-primary-container': light,
      '--md-sys-color-on-primary-container': deep,
      '--md-sys-color-inverse-primary': mix(p, '#ffffff', 0.32),
      '--md-sys-state-hover': `rgba(${r}, ${g}, ${b}, 0.08)`,
      '--md-sys-state-focus': `rgba(${r}, ${g}, ${b}, 0.12)`,
      '--md-sys-state-pressed': `rgba(${r}, ${g}, ${b}, 0.14)`,
      '--rd-accent': p,
      '--rd-reading-bg': mix(p, '#ffffff', 0.82),
    };
  }

  global.AiduTheme = { deriveCustomPalette, contrast, relativeLuminance, parseHex, mix, resolveTheme };
})(window);
