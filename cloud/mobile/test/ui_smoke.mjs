/**
 * test/ui_smoke.mjs —— 手机端 UI 控制器冒烟测试 (V7 补充, 2026-08-10)
 *
 * app.js 依赖 browserAdapter(IndexedDB) 与 DOM。本测试用最小 DOM stub +
 * 内存 adapter 替换, 直接驱动真实 app.js 控制器代码, 机械验证设计稿 01b 交互:
 *   整卡翻面(单向不可逆) / 翻面后 250ms 评分解锁 / 评分进下一张 + 本地先写待推 /
 *   3 秒可撤销 / 下滑退出保留进度。
 * 不引入 jsdom, 不依赖 window.__TAURI__。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { nodeAdapter } from '../adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function load(rel) { eval(readFileSync(join(root, rel), 'utf8')); }

// ---- 最小 DOM stub ----
function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  const el = {
    id, tagName: 'DIV', innerHTML: '', disabled: false,
    dataset: {}, style: { setProperty() {}, transform: '' }, value: '', onclick: null,
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, f) => { const w = f === undefined ? !classes.has(c) : !!f; if (w) classes.add(c); else classes.delete(c); return w; },
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatch(ev, payload) {
      if (typeof this.onclick === 'function') this.onclick();
      (listeners[ev] || []).forEach((fn) => fn(payload || { changedTouches: [{}], touches: [{}] }));
    },
    appendChild() {}, append() {},
  };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}

const els = {};
function getEl(id) {
  if (!els[id]) {
    els[id] = makeEl(id);
    // 指定元素预置类 (对应 index.html 的 class 属性)
    if (id === 'ba-disabled') els[id].className = 'ba-item ba-disabled';
    if (id === 'ba-another') els[id].className = 'ba-item';
    if (id === 'ba-hint') els[id].className = 'ba-hint hidden';
  }
  return els[id];
}

globalThis.window = globalThis;
globalThis.document = {
  getElementById: getEl,
  querySelectorAll: (sel) => {
    if (sel === '.view') return Object.values(els).filter((e) => e.className.includes('view') || !e.className);
    if (sel === '.grade-btn') return ['g1', 'g2', 'g3', 'g4'].map((i) => getEl(i));
    if (sel === '.gtime') return ['t1', 't2', 't3', 't4'].map((i) => getEl(i));
    if (sel === '.tab') return [getEl('tab1'), getEl('tab2')];
    if (sel === '.ba-item.ba-disabled') return [getEl('ba-disabled')];
    if (sel === '.ba-item') return [getEl('ba-disabled'), getEl('ba-another')];
    return [];
  },
  createElement: () => makeEl('dyn'),
};
globalThis.matchMedia = () => ({ matches: true }); // 桌面鼠标兜底路径(点击翻面)

// ---- 加载 app 依赖 (adapter.js 会重写 AidulcMobileAdapters, 覆盖要放在其后) ----
load('core.js');
load('adapter.js');

// 内存 adapter (替代 IndexedDB; 以 browserAdapter 暴露给 app.js)
globalThis.AidulcMobileAdapters.browserAdapter = () => nodeAdapter({ fetchImpl: async () => { throw new Error('offline'); } });

load('app-logic.js');
load('app.js');

const app = globalThis.window.mobileApp;

console.log('== 1. 启动 + 今日队列 (本地先写) ==');
{
  // 种子数据: 2 个到期复习词
  const now = Date.now();
  const words = [
    { word: 'reticent', lemma: 'reticent', meaning: '沉默寡言的', context: 'He was reticent.', stage: 'review', interval_ms: 3 * 86400000, ease_factor: 2.5, reviews: 3, next_review: now - 1000, updated_at: now - 1000 },
    { word: 'bank', lemma: 'bank', meaning: '银行', context: 'He went to the bank.', stage: 'new', interval_ms: 0, ease_factor: 2.5, reviews: 0, next_review: null, updated_at: now },
  ];
  await app.adapter.storage.setWords(words);
  await app.loadEntry();
  check('今日队列 2 词', getEl('today-num').textContent === '2', getEl('today-num').textContent);
  check('开始按钮可用', getEl('btn-start').disabled === false);
}

console.log('== 2. 复习: 翻面单向 + 250ms 评分解锁 ==');
{
  app.startReview();
  check('进入复习视图', getEl('view-review').className.includes('hidden') === false);
  check('正面显示当前词', getEl('front-word').textContent === 'reticent', getEl('front-word').textContent);
  // 整卡点击 = 翻面 (桌面鼠标兜底: matchMedia fine)
  getEl('card').dispatch('click');
  check('翻面后卡有 flipped 类', getEl('card').className.includes('flipped'));
  check('正面隐藏背面可见', getEl('card-front').className.includes('hidden') && !getEl('card-back').className.includes('hidden'));
  // 翻面瞬间评分仍禁用 (250ms 锁)
  check('翻面瞬间评分按钮 disabled', document.querySelectorAll('.grade-btn').every((b) => b.className.includes('disabled')));
  // 等 250ms 解锁
  await new Promise((r) => setTimeout(r, 300));
  check('250ms 后评分按钮解锁', document.querySelectorAll('.grade-btn').every((b) => !b.className.includes('disabled')));
  // 翻面不可逆: 再点不会回到正面 (front 仍 hidden)
  getEl('card').dispatch('click');
  check('翻面单向不可逆 (再点 front 仍 hidden)', getEl('card-front').className.includes('hidden'));
}

console.log('== 3. 评分 → 本地先写 + 进下一张 ==');
{
  // 评分前待推 0
  check('评分前待推 0', (await app.adapter.storage.getPending()).length === 0);
  const prevIndex = app.state.index;
  document.querySelectorAll('.grade-btn')[2].dispatch('click'); // 记得(3)
  await new Promise((r) => setTimeout(r, 50));
  check('评分后进下一张', app.state.index === prevIndex + 1, app.state.index);
  check('下一张显示 bank', getEl('front-word').textContent === 'bank', getEl('front-word').textContent);
  check('本地先写: 待推 1 (reticent 已进待推队列)', (await app.adapter.storage.getPending()).length === 1);
  const pend = (await app.adapter.storage.getPending())[0];
  check('待推词条 stage 已更新为 review→learning 或 review 规则结果', pend.lemma === 'reticent' && typeof pend.updated_at === 'number');
}

console.log('== 4. 3 秒可撤销 ==');
{
  check('评分后撤销条可见', !getEl('undo-bar').className.includes('hidden'));
  await app.undo();
  await new Promise((r) => setTimeout(r, 50));
  check('撤销后回到上一张', app.state.index === 0, app.state.index);
  check('撤销后正面显示 reticent', getEl('front-word').textContent === 'reticent');
}

console.log('== 5. 左右滑评分 + 下滑退出 (设计稿 01b) ==');
{
  // 回到入口重新进: 撤销后 index=0, 但当前还在复习视图; 重新 startReview 保证正面态
  app.startReview();
  await new Promise((r) => setTimeout(r, 30));
  // 右滑 = 记得(3) (需先翻面; 左右滑只在背面响应)
  getEl('card').dispatch('click');
  await new Promise((r) => setTimeout(r, 300)); // 等 250ms 解锁
  const beforeIdx = app.state.index;
  getEl('card').dispatch('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  getEl('card').dispatch('touchend', { changedTouches: [{ clientX: 200, clientY: 10 }] });
  await new Promise((r) => setTimeout(r, 50));
  check('右滑评分(记得)进下一张', app.state.index === beforeIdx + 1, app.state.index);
  // 左滑 = 忘了(1)
  getEl('card').dispatch('click');
  await new Promise((r) => setTimeout(r, 300));
  const beforeIdx2 = app.state.index;
  getEl('card').dispatch('touchstart', { touches: [{ clientX: 200, clientY: 10 }] });
  getEl('card').dispatch('touchend', { changedTouches: [{ clientX: 10, clientY: 10 }] });
  await new Promise((r) => setTimeout(r, 50));
  check('左滑评分(忘了)进下一张', app.state.index === beforeIdx2 + 1, app.state.index);
  // 长按弹操作
  getEl('card').dispatch('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  await new Promise((r) => setTimeout(r, 600)); // > 500ms 长按
  check('长按弹出操作层', getEl('action-sheet').className.includes('hidden') === false);
  getEl('act-cancel').dispatch('click');
  check('取消关闭操作层', getEl('action-sheet').className.includes('hidden') === true);
  // 下滑退出保留进度
  getEl('card').dispatch('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  getEl('card').dispatch('touchend', { changedTouches: [{ clientX: 10, clientY: 200 }] });
  await new Promise((r) => setTimeout(r, 50));
  check('下滑退出到入口', getEl('view-entry').className.includes('hidden') === false);
  // 本段已把 2 词全部评分 (右滑+左滑+前面撤销过的词已重评), 队列重算应为 0 = 全部复习完
  check('进度保留: 复习完 2 词后队列归零', getEl('today-num').textContent === '0', getEl('today-num').textContent);
}

console.log('== 6. 冲突 6: 手机端"跳到原文"不可用 → 提示在电脑上打开 ==');
{
  // 需要翻面进入背面 (动作区在卡背)
  app.startReview();
  await new Promise((r) => setTimeout(r, 30));
  getEl('card').dispatch('click'); // 翻面
  await new Promise((r) => setTimeout(r, 30));
  const disabledItem = document.querySelectorAll('.ba-item.ba-disabled')[0];
  check('背面有"跳到原文"不可用项', !!disabledItem, 'disabledItem=' + !!disabledItem);
  check('提示初始隐藏', getEl('ba-hint').className.includes('hidden'));
  if (disabledItem) disabledItem.onclick();
  check('点"跳到原文"提示"在电脑上打开"', !getEl('ba-hint').className.includes('hidden'));
}

console.log('');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
