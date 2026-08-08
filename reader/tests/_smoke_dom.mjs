/**
 * _smoke_dom.mjs —— 阅读器渲染路径的冒烟测试 (node 直跑, 非 vitest)
 * 用一个极简 DOM stub 驱动 AtomicBlock + ReaderRenderer, 验证:
 *   - 三种模式建块不抛错
 *   - 词级/句级高亮 classList 切换
 *   - 先答后核: 揭示/折叠/细痕状态切换
 *   - 当前句锚点切换 + 离开已揭示句折叠
 * 不引入 jsdom (项目约定: 核心与渲染逻辑用轻量 shim 测试)。
 * 运行: node tests/_smoke_dom.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ---------- 极简 DOM stub ----------
function makeElement(tag) {
  const classes = new Set();
  const children = [];
  const attrs = {};
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    _classes: classes,
    _children: children,
    _attrs: attrs,
    dataset: {},
    style: { setProperty: () => {}, cssText: '' },
    textContent: '',
    title: '',
    id: '',
    parentNode: null,
    innerHTML: '',
    onclick: null,
    ondblclick: null,
    onmouseenter: null,
    onmouseleave: null,
    onchange: null,
    oninput: null,
    onkeydown: null,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const has = classes.has(c);
        const want = force === undefined ? !has : !!force;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains: (c) => classes.has(c),
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((c) => c !== child);
      child.parentNode = el;
      children.push(child);
      return child;
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((c) => c !== child);
      child.parentNode = el;
      const i = ref ? children.indexOf(ref) : -1;
      if (i >= 0) children.splice(i, 0, child); else children.push(child);
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
        if (el.dataset[camel] !== undefined) return String(el.dataset[camel]);
      }
      return k in attrs ? attrs[k] : null;
    },
    querySelector: (sel) => queryAll(el, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(el, sel),
    closest(sel) {
      let n = el;
      while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
      return null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    offsetLeft: 0,
    offsetWidth: 10,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };
  return el;
}

function matches(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  let rest = sel.trim();
  // tag
  if (rest[0] && rest[0] !== '.' && rest[0] !== '[') {
    const m = rest.match(/^([a-zA-Z]+)/);
    if (!m) return false;
    if (node.tagName !== m[1].toUpperCase()) return false;
    rest = rest.slice(m[1].length).trim();
  }
  const tokens = rest.match(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g) || [];
  for (const tk of tokens) {
    if (tk[0] === '.') {
      if (!node.classList.contains(tk.slice(1))) return false;
    } else {
      const m = tk.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      const val = node.getAttribute(m[1]);
      if (m[2] === undefined) { if (val === null) return false; }
      else if (val !== m[2]) return false;
    }
  }
  return true;
}

function queryAll(rootNode, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n._children || []) {
      if (matches(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(rootNode);
  return out;
}

globalThis.document = {
  createElement: (tag) => makeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  body: makeElement('body'),
  documentElement: makeElement('html'),
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.IntersectionObserver = undefined;
globalThis.AiduLibraryService = { readImage: async () => ({ ok: false }) };
globalThis.AiduRenderPlan = undefined;

// ---------- 加载源码 ----------
function load(rel) {
  const code = readFileSync(join(root, rel), 'utf8');
  eval(code);
}
['core/timeline.js', 'core/shadow.js', 'core/render_plan.js',
  'core/reader_state.js', 'core/follow_presets.js',
  'components/atomic_block.js', 'components/reader_renderer.js'].forEach(load);

// ---------- 测试句子 ----------
const sentence = {
  original_text: 'The quick brown fox jumps over the lazy dog.',
  translation: '敏捷的棕色狐狸跳过了懒狗。',
  explanation: '主谓宾结构: The fox jumps over the dog。',
  status: 'ok',
  segments: [
    ['The', 'DET', 'the'], ['quick', 'ADJ', 'quick'], ['brown', 'ADJ', 'brown'],
    ['fox', 'NOUN', 'fox'], ['jumps', 'VERB', 'jump'], ['over', 'ADP', 'over'],
    ['the', 'DET', 'the'], ['lazy', 'ADJ', 'lazy'], ['dog', 'NOUN', 'dog'], ['.', 'PUNCT', '.'],
  ],
  phrasal_verbs: [{ text: 'jumps over', indices: [4, 5], lemma: 'jump over', translation: '跳过' }],
  audio: { chapter: 0, start_ms: 0, end_ms: 3000 },
  words: [
    { seg_idx: 0, start_ms: 0, end_ms: 200 }, { seg_idx: 1, start_ms: 200, end_ms: 400 },
    { seg_idx: 2, start_ms: 400, end_ms: 600 }, { seg_idx: 3, start_ms: 600, end_ms: 800 },
    { seg_idx: 4, start_ms: 800, end_ms: 1000 },
  ],
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const rd = new globalThis.AiduReaderState();
const handlers = {
  onPlay: () => {}, onSelect: () => {}, onBubbleClick: () => {},
  onBookmark: () => {}, onFollowToggle: () => {}, onRevealToggle: () => {},
};

console.log('== AtomicBlock: guess 模式建块 ==');
const blk = globalThis.AtomicBlock.create(sentence, 0, handlers, {
  mode: 'guess', current: true, savedSet: new Set(['quick']), verifiedSet: new Set(),
});
check('块类名含 atomic-block blk', blk.className.includes('atomic-block') && blk.className.includes('blk'));
check('句内三开关存在', blk.querySelectorAll('.atool').length === 3);
check('saved 词有下划线类', blk.querySelectorAll('.bubble.saved').length >= 1);
check('短语动词成员有强调线类', blk.querySelectorAll('.bubble.phrasal-member').length >= 2);
check('未核对当前句: 提示行可见', blk.querySelector('.hint').classList.contains('visible'));
check('初始 hidden 支撑', blk.classList.contains('support-hidden'));

console.log('== R1-2: 生词高亮 lemma+word 双键 (变位词) ==');
// "jumps" 的 spaCy lemma 是 "jump" —— 用户加词本存的是词面 "jumps",
// 只有 lemma 键时不高亮; 双键后必须高亮。
const blkInflected = globalThis.AtomicBlock.create(sentence, 0, handlers, {
  mode: 'guess', current: true, savedSet: new Set(['jumps']), verifiedSet: new Set(),
});
const jumpsTok = blkInflected.querySelector('.bubble[data-seg-idx="4"]');
check('词面 "jumps" 命中高亮 (即使 lemma 是 jump)', jumpsTok && jumpsTok.classList.contains('saved'));

console.log('== R21: 摘录精确 span 高亮 ==');
const blkHl = globalThis.AtomicBlock.create(sentence, 0, handlers, {
  mode: 'guess', current: true,
  highlights: [{ sentence_index: 0, start_seg: 1, end_seg: 2 }],
});
check('摘录句块有 highlighted 标记', blkHl.classList.contains('highlighted'));
check('seg 1 精确标黄', blkHl.querySelector('.bubble[data-seg-idx="1"]').classList.contains('hl-span'));
check('seg 2 精确标黄', blkHl.querySelector('.bubble[data-seg-idx="2"]').classList.contains('hl-span'));
check('seg 0 不被误标', !blkHl.querySelector('.bubble[data-seg-idx="0"]').classList.contains('hl-span'));

console.log('== 先答后核: 揭示 → 已核对 → 折叠细痕 ==');
const ab = blk._ab;
check('isRevealed 初始 false', !ab.isRevealed());
ab.showSupport('revealed');
check('揭示后 class support-revealed', blk.classList.contains('support-revealed'));
check('揭示后支撑体显示', queryAll(blk, '.support-body').every((s) => s !== null) && blk.querySelector('.support-body') !== null);
check('揭示后 ↥ 按钮', ab.el.querySelector('.atool-reveal').textContent === '↥');
ab.showSupport('scar');
check('折叠细痕 class support-scar', blk.classList.contains('support-scar'));
ab.showSupport('hidden');
check('回 hidden', blk.classList.contains('support-hidden'));

console.log('== 词级/句级朗读高亮 ==');
const ab2 = (() => {
  const b = globalThis.AtomicBlock.create(sentence, 0, handlers, { mode: 'guess', current: true });
  return b._ab;
})();
ab2.setWordReading(4);
const el4 = ab2._bubble(4);
check('seg_idx=4 词加 word-reading', el4 && el4.classList.contains('word-reading'));
ab2.setWordReading(1);
check('切词后旧词移除', el4 && !el4.classList.contains('word-reading'));
check('新词加上', ab2._bubble(1).classList.contains('word-reading'));
ab2.clearWordReading();
check('clear 后无 word-reading', ab2._bubble(1) && !ab2._bubble(1).classList.contains('word-reading'));

console.log('== ReaderRenderer: 三模式渲染 ==');
const rootEl = globalThis.document.createElement('div');
const renderer = new globalThis.ReaderRenderer(rootEl);
renderer.state = rd;
const sentences = [sentence, {
  ...sentence, original_text: 'A second sentence for testing.', translation: '第二句译文。',
  segments: [['A', 'DET', 'a'], ['second', 'ADJ', 'second'], ['sentence', 'NOUN', 'sentence'], ['.', 'PUNCT', '.']],
  words: [{ seg_idx: 0, start_ms: 0, end_ms: 100 }],
}];
renderer.render({ sentences, mode: 'guess', currentIndex: 0, readerState: rd, verifiedSet: new Set(), savedSet: new Set(), bookmarkIndices: new Set() }, handlers);
check('首屏建出句块', renderer._blockCache.size === 2);
check('contentArea dataset.mode=guess', renderer.contentArea.dataset.mode === 'guess');

renderer.render({ sentences, mode: 'bench', currentIndex: 0, readerState: rd, verifiedSet: new Set(), savedSet: new Set(), bookmarkIndices: new Set() }, handlers);
check('bench 重建不抛错', renderer._blockCache.size === 2);
check('bench dataset.mode', renderer.contentArea.dataset.mode === 'bench');

renderer.render({ sentences, mode: 'silent', currentIndex: 0, readerState: rd, verifiedSet: new Set(), savedSet: new Set(), bookmarkIndices: new Set() }, handlers);
check('silent 重建不抛错', renderer._blockCache.size === 2);

console.log('== 当前句切换 + 离开已揭示句折叠 ==');
rd.setMode('guess');
renderer.render({ sentences, mode: 'guess', currentIndex: 0, readerState: rd, verifiedSet: new Set(), savedSet: new Set(), bookmarkIndices: new Set() }, handlers);
const c0 = renderer._blockCache.get(0);
check('锚点句 current 类', c0.block.classList.contains('current'));
renderer.setCurrentSentence(1);
check('新锚点 current', renderer._blockCache.get(1).block.classList.contains('current'));
check('旧锚点移除 current', !c0.block.classList.contains('current'));

// 回到句0 揭示它 → 切到句1 → 应折叠成 scar, 且状态机 _revealed 被摘掉
renderer.setCurrentSentence(0);
rd.reveal(0);
const c0b = renderer._blockCache.get(0);
c0b.ab.showSupport('revealed');
renderer.setCurrentSentence(1);
check('离开已揭示句折叠成 scar', c0b.block.classList.contains('support-scar'));
check('状态机 _revealed 被摘掉', !rd.isRevealed(0));
renderer.setCurrentSentence(0);
check('回到已核对句 → scar', c0b.block.classList.contains('support-scar'));
check('提示文案含 已核对过', c0b.block.querySelector('.hint').textContent.includes('已核对过'));
check('supportFor 回到已核对句 = scar', rd.supportFor('guess', 0) === 'scar');
check('未核对句 supportFor = hidden', rd.supportFor('guess', 1) === 'hidden');

console.log('== bench 词级: 节奏线 (预测量 + transform) ==');
rd.setMode('bench');
renderer.render({ sentences, mode: 'bench', currentIndex: 0, readerState: rd, verifiedSet: new Set(), savedSet: new Set(), bookmarkIndices: new Set() }, handlers);
renderer.setGranularity('word');
const b0 = renderer._blockCache.get(0);
check('bench 当前句节奏线可见', b0.ab.getSweepEl().style.display === 'block');
renderer.highlightAt(850, sentences); // 词 4 (800-1000)
check('节奏线 transform 用预测量', /translate3d/.test(b0.ab.getSweepEl().style.transform) && /scaleX\(/.test(b0.ab.getSweepEl().style.transform));
renderer.highlightAt(250, sentences); // 词 1 (200-400)
check('词变节奏线跟着动', /translate3d/.test(b0.ab.getSweepEl().style.transform));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
