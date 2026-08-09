import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 阶段3 (F46): 阅读器"加载/错误/重试/返回书库"可见态回归 —— 后端失败不能变成空白页。
// reader_view.js 是普通脚本(IIFE), 用 readFileSync + eval 加载 (与 tests/_smoke_dom.mjs 一致)。
// 用 Object.create(ReaderView.prototype) 绕过重构造器(构造会 new 一堆子模块), 只测方法本身。

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function makeElement(tag) {
  const classes = new Set();
  const children = [];
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    _classes: classes,
    _children: children,
    dataset: {},
    style: { setProperty: () => {} },
    title: '',
    className: '',
    parentNode: null,
    onclick: null,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    get textContent() { return children.map((c) => c.textContent).join('') + (el._text || ''); },
    set textContent(v) { el._text = String(v == null ? '' : v); },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    set innerHTML(v) {
      el._text = '';
      children.length = 0;
    },
    appendChild(child) {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    querySelector(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n._children || []) {
          const cls = c._classes || new Set();
          const want = sel[0] === '.' ? cls.has(sel.slice(1)) : false;
          if (want) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out[0] || null;
    },
    remove() {},
    setAttribute() {},
    addEventListener() {},
  };
  return el;
}

let ReaderView;

beforeAll(() => {
  globalThis.document = {
    createElement: (t) => makeElement(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };
  const code = readFileSync(join(root, 'views/reader_view.js'), 'utf8');
  eval(code);
  ReaderView = globalThis.ReaderView;
});

describe('ReaderView._showReaderState (F46: 后端失败可见 + 重试 + 返回书库)', () => {
  function makeView() {
    const view = Object.create(ReaderView.prototype);
    const state = { backCalls: 0 };
    view.onBack = () => { state.backCalls += 1; };
    return { view, state };
  }

  function contentWith(id) {
    const el = makeElement('div');
    el.id = id;
    globalThis.document.getElementById = (i) => (i === id ? el : null);
    return el;
  }

  it('loading 态渲染 loading 文本, 无按钮', () => {
    const content = contentWith('reader-content');
    const { view } = makeView();
    view._showReaderState('loading', '正在加载书包…');
    expect(content.textContent).toContain('正在加载书包…');
    expect(content.querySelector('.reader-state-actions')).toBeNull();
  });

  it('error 态渲染错误信息 + 重试 + 返回书库按钮', () => {
    const content = contentWith('reader-content');
    const { view, state } = makeView();
    let retried = 0;
    view._showReaderState('error', '加载书包失败: boom', () => { retried += 1; });
    expect(content.textContent).toContain('加载书包失败: boom');
    const actions = content.querySelector('.reader-state-actions');
    expect(actions).not.toBeNull();
    const buttons = actions._children || [];
    expect(buttons.length).toBe(2);
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain('重试');
    expect(labels).toContain('返回书库');
    // 触发重试回调
    const retryBtn = buttons.find((b) => b.textContent === '重试');
    retryBtn.onclick();
    expect(retried).toBe(1);
    // 触发返回
    const backBtn = buttons.find((b) => b.textContent === '返回书库');
    backBtn.onclick();
    expect(state.backCalls).toBe(1);
  });

  it('error 态可再次渲染 (覆盖旧内容, 不叠加)', () => {
    const content = contentWith('reader-content');
    const { view } = makeView();
    view._showReaderState('error', '第一次失败');
    view._showReaderState('error', '第二次失败');
    expect(content.textContent).toContain('第二次失败');
    expect(content.textContent).not.toContain('第一次失败');
    expect(content._children.length).toBe(1);
  });
});
