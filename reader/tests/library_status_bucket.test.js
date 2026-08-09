import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 阶段6 设计交付 §01: 书库状态分段(全部/已就绪/处理中/未处理)的桶映射是纯逻辑。
// 用 Object.create(prototype) 绕过重构造器, 只测 _inStatusBucket 映射语义。
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let LibraryView;

beforeAll(() => {
  // library_view.js 顶层 el() 引用 document; 构造器引用 AiduListenerSlot/ImportDedup。
  // 用 Object.create(prototype) 绕过构造器, 但 IIFE 需要 window/document 存在。
  globalThis.document = {
    createElement: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: () => {} },
    documentElement: {},
  };
  globalThis.AiduListenerSlot = class {};
  globalThis.AiduImportDedup = class {};
  const code = readFileSync(join(root, 'views/library_view.js'), 'utf8');
  eval(code);
  LibraryView = globalThis.LibraryView;
});

function makeView() {
  return Object.create(LibraryView.prototype);
}

describe('LibraryView._inStatusBucket (阶段6: 状态分段语义)', () => {
  const cases = [
    // [status, ready, processing, pending]
    ['ready', true, false, false],
    ['done', true, false, false],     // mark_original_done 后 = 已就绪
    ['partial', true, false, false],  // 有失败句也算已就绪(可读)
    ['processing', false, true, false],
    ['pending', false, false, true],
    ['failed', false, false, true],
  ];
  cases.forEach(([status, inReady, inProc, inPending]) => {
    it(`${status} → ready=${inReady} processing=${inProc} pending=${inPending}`, () => {
      const v = makeView();
      const book = { status };
      expect(v._inStatusBucket(book, 'ready')).toBe(inReady);
      expect(v._inStatusBucket(book, 'processing')).toBe(inProc);
      expect(v._inStatusBucket(book, 'pending')).toBe(inPending);
    });
  });

  it('all 桶恒 true', () => {
    const v = makeView();
    ['ready', 'processing', 'pending', 'failed', 'weird'].forEach((status) => {
      expect(v._inStatusBucket({ status }, 'all')).toBe(true);
    });
  });

  it('未知状态不进任何具体桶(不误导)', () => {
    const v = makeView();
    const book = { status: 'mystery' };
    expect(v._inStatusBucket(book, 'ready')).toBe(false);
    expect(v._inStatusBucket(book, 'processing')).toBe(false);
    expect(v._inStatusBucket(book, 'pending')).toBe(false);
  });
});
