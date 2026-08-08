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

if (failed) { console.log(`\n${failed} 处对比度不达标 (WCAG AA 正文 ≥ 4.5)`); process.exit(1); }
console.log('\n全部对比度达标');
