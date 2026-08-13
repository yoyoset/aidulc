import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 阶段6 设计交付 §01: 书库状态分段(全部/已就绪/处理中/未处理)的桶映射是纯逻辑。
// K2-3 (2026-08-13): 逻辑拆到 views/library/status.js (AiduLibraryStatus), 不再需要
// Object.create(LibraryView.prototype) 绕构造器的写法——现在就是纯函数。
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let AiduLibraryStatus;

beforeAll(() => {
  const code = readFileSync(join(root, 'views/library/status.js'), 'utf8');
  eval(code);
  AiduLibraryStatus = globalThis.AiduLibraryStatus;
});

describe('AiduLibraryStatus.inStatusBucket (阶段6: 状态分段语义)', () => {
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
      const book = { status };
      expect(AiduLibraryStatus.inStatusBucket(book, 'ready')).toBe(inReady);
      expect(AiduLibraryStatus.inStatusBucket(book, 'processing')).toBe(inProc);
      expect(AiduLibraryStatus.inStatusBucket(book, 'pending')).toBe(inPending);
    });
  });

  it('all 桶恒 true', () => {
    ['ready', 'processing', 'pending', 'failed', 'weird'].forEach((status) => {
      expect(AiduLibraryStatus.inStatusBucket({ status }, 'all')).toBe(true);
    });
  });

  it('未知状态不进任何具体桶(不误导)', () => {
    const book = { status: 'mystery' };
    expect(AiduLibraryStatus.inStatusBucket(book, 'ready')).toBe(false);
    expect(AiduLibraryStatus.inStatusBucket(book, 'processing')).toBe(false);
    expect(AiduLibraryStatus.inStatusBucket(book, 'pending')).toBe(false);
  });
});
