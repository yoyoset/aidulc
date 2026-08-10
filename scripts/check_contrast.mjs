#!/usr/bin/env node
/**
 * check_contrast.mjs —— 令牌对比度门禁 (Round 6, 2026-08-08)
 * 直接解析 reader/styles/tokens.css 的 CSS 变量(不复制值, 防漂移), 计算每个
 * palette × mode 下的关键前景/背景对, WCAG AA 正文 ≥ 4.5:1 不达标即退出非零。
 * 用法: node scripts/check_contrast.mjs
 * 接入: scripts/check.ps1 (contrast 门禁项)
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reader', 'styles', 'tokens.css'), 'utf8');

/** 剥掉 CSS 注释 —— 注释会混进 [^{}]+ 的选择器里, 让 :root 匹配失败 (Round 6 实测踩坑) */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 解析 `selector { ...vars... }` 块, 返回 { selector, vars: Map } 数组 */
function parseBlocks(src) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const selector = m[1].trim();
    const vars = new Map();
    for (const line of m[2].split('\n')) {
      const vm = line.match(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/);
      if (vm) vars.set(vm[1], vm[2]);
    }
    blocks.push({ selector, vars });
  }
  return blocks;
}

function lum(hex) {
  const c = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** CIELAB 转换 + ΔE76 (S6: 通道颜色两两可判别差用, 比对比度更贴近人眼对色相的区分) */
function linC(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function xyz(hex) {
  const c = hex.replace('#', '');
  const r = linC(parseInt(c.slice(0, 2), 16)), g = linC(parseInt(c.slice(2, 4), 16)), b = linC(parseInt(c.slice(4, 6), 16));
  return { x: 0.4124 * r + 0.3576 * g + 0.1805 * b, y: 0.2126 * r + 0.7152 * g + 0.0722 * b, z: 0.0193 * r + 0.1192 * g + 0.9505 * b };
}
function lab(hex) {
  const { x, y, z } = xyz(hex);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116));
  const fx = f(x / 0.95047), fy = f(y / 1.0), fz = f(z / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function dE(a, b) {
  const A = lab(a), B = lab(b);
  return Math.sqrt((A.L - B.L) ** 2 + (A.a - B.a) ** 2 + (A.b - B.b) ** 2);
}

const blocks = parseBlocks(stripComments(css));
const root = blocks.find((b) => b.selector === ':root')?.vars || new Map();
const dark = blocks.find((b) => b.selector === 'body[data-theme="dark"]')?.vars || new Map();
const palettes = {};
for (const p of ['clay', 'sage', 'ocean', 'rose', 'slate']) {
  palettes[p] = {
    light: blocks.find((b) => b.selector === `body[data-palette="${p}"]`)?.vars || new Map(),
    dark: blocks.find((b) => b.selector === `body[data-theme="dark"][data-palette="${p}"]`)?.vars || new Map(),
  };
}

function effective(palette, mode, name) {
  if (palette !== 'clay') {
    const pv = palettes[palette][mode].get(name);
    if (pv) return pv;
  }
  const dv = dark.get(name);
  if (mode === 'dark' && dv) return dv;
  return root.get(name) || null;
}

let failed = 0;
const check = (label, fg, bg) => {
  if (!fg || !bg) { console.log(`SKIP ${label} (缺令牌)`); return; }
  const r = ratio(fg, bg);
  if (r < 4.5) { console.log(`FAIL ${label}: ${fg} on ${bg} = ${r.toFixed(2)} (<4.5)`); failed++; }
  else console.log(`PASS ${label}: ${r.toFixed(2)}`);
};

for (const p of ['clay', 'sage', 'ocean', 'rose', 'slate']) {
  for (const mode of ['light', 'dark']) {
    check(`${p}-${mode} on-primary/primary`, effective(p, mode, 'md-sys-color-on-primary'), effective(p, mode, 'md-sys-color-primary'));
    check(`${p}-${mode} on-primary-container/primary-container`, effective(p, mode, 'md-sys-color-on-primary-container'), effective(p, mode, 'md-sys-color-primary-container'));
    check(`${p}-${mode} on-surface/surface`, effective(p, mode, 'md-sys-color-on-surface'), effective(p, mode, 'md-sys-color-surface'));
    check(`${p}-${mode} on-surface-variant/surface-variant`, effective(p, mode, 'md-sys-color-on-surface-variant'), effective(p, mode, 'md-sys-color-surface-variant'));
  }
}
// 阅读器 --rd-* (仅 root/dark, palette 不覆盖 ink/surface)
for (const mode of ['light', 'dark']) {
  const s = effective('clay', mode, 'rd-surface');
  check(`rd-${mode} ink/surface`, effective('clay', mode, 'rd-ink'), s);
  check(`rd-${mode} ink-2/surface`, effective('clay', mode, 'rd-ink-2'), s);
  check(`rd-${mode} ink-3/surface`, effective('clay', mode, 'rd-ink-3'), s);
}

// ---- S6 (2026-08-10) 阅读器语义通道门禁 ----
// 通道: 当前句标线 rd-accent / 正在朗读 rd-reading-bg / 生词 rd-saved /
//       短语 rd-mark / 摘录 rd-hl。阈值只许提高不许放宽 (写在注释里)。
const CHANNELS = ['rd-accent', 'rd-reading-bg', 'rd-mark', 'rd-saved', 'rd-hl'];
let chFailed = 0;
const checkCh = (label, cond, detail) => {
  if (!cond) { chFailed++; console.log(`FAIL ${label}: ${detail}`); }
  else console.log(`PASS ${label}`);
};

for (const p of ['clay', 'sage', 'ocean', 'rose', 'slate']) {
  for (const mode of ['light', 'dark']) {
    const surf = effective(p, mode, 'rd-surface');
    const ink = effective(p, mode, 'rd-ink');
    const vals = {};
    for (const ch of CHANNELS) vals[ch] = effective(p, mode, ch);

    // ① 朗读底色 vs 纸面: 可察觉亮度差下限 ΔL ≥ 0.05 (当初 #f0e7da vs #fbf8f3 只有
    //    0.03, 跳动看不见; 阈值以"肉眼可辨"为准, 只能提高)
    const dL = Math.abs(lum(vals['rd-reading-bg']) - lum(surf));
    checkCh(`S6-① ${p}-${mode} reading-bg/surface ΔL≥0.05`, dL >= 0.05, `ΔL=${dL.toFixed(4)}`);

    // ② 各通道颜色两两可判别差: ΔE76 ≥ 10 (色盲友好, 不靠单一颜色 —— 但通道间
    //    也不能撞到同色相, 形态是主编码, 颜色是次编码)
    for (let i = 0; i < CHANNELS.length; i++) {
      for (let j = i + 1; j < CHANNELS.length; j++) {
        const a = vals[CHANNELS[i]], b = vals[CHANNELS[j]];
        if (!a || !b) continue;
        const d = dE(a, b);
        checkCh(`S6-② ${p}-${mode} ${CHANNELS[i]}/${CHANNELS[j]} ΔE≥10`, d >= 10, `ΔE=${d.toFixed(1)}`);
      }
    }

    // ③ 正文墨色压在每个通道底色上仍过 WCAG AA (≥4.5) —— reading-bg 是整词底色,
    //    hl 是 28% 软底 (reader.css: color-mix(hl 28%, transparent) 叠在纸面上);
    //    saved/mark/accent 是线条(不承载文字), 只查会承载文字的底色
    const mix = (fg, bg, pct) => {
      // color-mix(in srgb, fg pct%, transparent) 叠在 bg 上 → 与浏览器一致的合成色
      const c1 = fg.replace('#', ''), c2 = bg.replace('#', '');
      return '#' + [0, 2, 4].map((i) => {
        const v = Math.round(parseInt(c1.slice(i, i + 2), 16) * pct + parseInt(c2.slice(i, i + 2), 16) * (1 - pct));
        return v.toString(16).padStart(2, '0');
      }).join('');
    };
    const rReading = ratio(ink, vals['rd-reading-bg']);
    checkCh(`S6-③ ${p}-${mode} ink/rd-reading-bg AA≥4.5`, rReading >= 4.5, `ratio=${rReading.toFixed(2)}`);
    const hlBg = mix(vals['rd-hl'], surf, 0.28); // 摘录软底的真实叠色
    const rHl = ratio(ink, hlBg);
    checkCh(`S6-③ ${p}-${mode} ink/rd-hl(28%) AA≥4.5`, rHl >= 4.5, `ratio=${rHl.toFixed(2)}`);
  }
}
if (chFailed) {
  console.log(`\n${chFailed} 处阅读器语义通道门禁不达标 (S6)`);
  process.exit(1);
}

if (failed) { console.log(`\n${failed} 处对比度不达标 (WCAG AA 正文 ≥ 4.5)`); process.exit(1); }
console.log('\n全部对比度达标');
