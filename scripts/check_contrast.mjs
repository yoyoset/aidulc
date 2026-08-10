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
// C (2026-08-11): 门禁量的是**渲染后的合成色**, 不是令牌原色 —— 页面用 color-mix
// 稀释后渲染, 量原色会造成"门禁全绿、眼睛还是看不见"。合成色比例直接从 reader.css
// 解析 (单一真相), 比例一改门禁自动跟上; 解析不到 = 渲染形态变了但门禁没跟上 → 必须失败。
const readerCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reader', 'styles', 'reader.css'), 'utf8');
const readerCssRel = 'reader/styles/reader.css';
/** color-mix(in srgb, fg pct%, transparent) 叠在 bg 上 → 与浏览器一致的合成色 */
function mix(fg, bg, pct) {
  const c1 = fg.replace('#', ''), c2 = bg.replace('#', '');
  return '#' + [0, 2, 4].map((i) => {
    const v = Math.round(parseInt(c1.slice(i, i + 2), 16) * pct + parseInt(c2.slice(i, i + 2), 16) * (1 - pct));
    return v.toString(16).padStart(2, '0');
  }).join('');
}
function readRuleMixPct(selPattern, varName) {
  const blockRe = new RegExp(selPattern + '[^{]*\\{([^}]*)\\}');
  const bm = blockRe.exec(readerCss);
  if (!bm) return null;
  const varRe = new RegExp('var\\(--' + varName + '\\)\\s*(\\d+)%');
  const vm = varRe.exec(bm[1]);
  return vm ? parseInt(vm[1], 10) / 100 : null;
}
const CS_PCT = readRuleMixPct('\\.atomic-block\\.sentence-reading', 'rd-accent');
const HL_SEN_PCT = readRuleMixPct('\\.atomic-block\\.highlighted', 'rd-hl');
const HL_WORD_PCT = readRuleMixPct('\\.bubble\\.hl-span', 'rd-hl');
for (const [name, v] of [['当前句 accent', CS_PCT], ['摘录句 hl', HL_SEN_PCT], ['摘录词 hl', HL_WORD_PCT]]) {
  if (!v || v <= 0 || v > 1) {
    console.log(`FAIL C: ${readerCssRel} 里解析不到 ${name} 的 color-mix 比例 (渲染形态变了, 门禁没跟上)`);
    process.exit(1);
  }
}

// C (2026-08-11): 文本选中通道 --rd-select —— 5 色系 × 明暗 10 组必须全定义,
// 缺一个就是"这个模式下选中看不见", 直接失败。
const CHANNELS = ['rd-accent', 'rd-reading-bg', 'rd-mark', 'rd-saved', 'rd-hl', 'rd-select'];
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

    // C: --rd-select 必须存在 (缺令牌直接失败, 而不是被 ΔE 跳过)
    checkCh(`C-① ${p}-${mode} --rd-select 已定义`, !!vals['rd-select'], `缺 --rd-select`);

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

    // C-② (2026-08-11): 渲染后合成色逐通道 ΔL≥0.05 可见性下限 —— 门禁量的就是
    // 页面渲染的 (color-mix 稀释比例来自 reader.css), 不再是令牌原色。
    //   reading-bg 全强度 (整词底色) / 当前句 accent×csPct / 摘录句 hl×hlSenPct(左标线)
    //   / 摘录词 hl×hlWordPct (词软底)
    const rendered = {
      'reading-bg': vals['rd-reading-bg'],
      'current-sentence': mix(vals['rd-accent'], surf, CS_PCT),
      'hl-sentence': mix(vals['rd-hl'], surf, HL_SEN_PCT),
      'hl-word': mix(vals['rd-hl'], surf, HL_WORD_PCT),
    };
    for (const [ch, col] of Object.entries(rendered)) {
      if (!col) continue;
      const d = Math.abs(lum(col) - lum(surf));
      const pct = ch === 'reading-bg' ? '100%' : ch === 'current-sentence' ? `${Math.round(CS_PCT*100)}%` : ch === 'hl-sentence' ? `${Math.round(HL_SEN_PCT*100)}%` : `${Math.round(HL_WORD_PCT*100)}%`;
      checkCh(`C-② ${p}-${mode} ${ch}(${pct})/surface ΔL≥0.05`, d >= 0.05, `ΔL=${d.toFixed(4)}`);
    }

    // ③ 正文墨色压在每个通道底色上仍过 WCAG AA (≥4.5) —— reading-bg 是整词底色,
    //    hl 是 28% 软底 (reader.css: color-mix(hl 28%, transparent) 叠在纸面上);
    //    saved/mark/accent 是线条(不承载文字), 只查会承载文字的底色
    const rReading = ratio(ink, vals['rd-reading-bg']);
    checkCh(`S6-③ ${p}-${mode} ink/rd-reading-bg AA≥4.5`, rReading >= 4.5, `ratio=${rReading.toFixed(2)}`);
    // C-③ (2026-08-11): 摘录词/当前句也是承载文字的底色 → AA 用渲染后合成色算
    const hlBg = mix(vals['rd-hl'], surf, HL_WORD_PCT);
    const rHl = ratio(ink, hlBg);
    checkCh(`C-③ ${p}-${mode} ink/rd-hl(${Math.round(HL_WORD_PCT*100)}%) AA≥4.5`, rHl >= 4.5, `ratio=${rHl.toFixed(2)}`);
    const csBg = mix(vals['rd-accent'], surf, CS_PCT);
    const rCs = ratio(ink, csBg);
    checkCh(`C-③ ${p}-${mode} ink/current-sentence(${Math.round(CS_PCT*100)}%) AA≥4.5`, rCs >= 4.5, `ratio=${rCs.toFixed(2)}`);
  }
}
if (chFailed) {
  console.log(`\n${chFailed} 处阅读器语义通道门禁不达标 (S6)`);
  process.exit(1);
}

if (failed) { console.log(`\n${failed} 处对比度不达标 (WCAG AA 正文 ≥ 4.5)`); process.exit(1); }
console.log('\n全部对比度达标');
