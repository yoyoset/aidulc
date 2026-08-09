import { describe, it, expect, beforeAll, vi } from 'vitest';

let ListenerSlot, ImportDedup;

beforeAll(async () => {
  await import('../core/import_guard.js');
  ListenerSlot = globalThis.AiduListenerSlot;
  ImportDedup = globalThis.AiduImportDedup;
});

describe('ListenerSlot (F34/F45: 拖拽监听不累积)', () => {
  it('set() 替换旧 listener, 先注销旧的再保留新的', () => {
    const slot = new ListenerSlot();
    let unlistenA = 0, unlistenB = 0;
    slot.set(() => { unlistenA += 1; });
    slot.set(() => { unlistenB += 1; });
    expect(unlistenA).toBe(1, '注册 B 时应先注销 A');
    expect(slot.has()).toBe(true);
  });

  it('clear() 注销当前 listener', () => {
    const slot = new ListenerSlot();
    let un = 0;
    slot.set(() => { un += 1; });
    slot.clear();
    expect(un).toBe(1);
    expect(slot.has()).toBe(false);
  });

  it('重复注册两次后仍只有一个活 listener (重新渲染不累积)', () => {
    const slot = new ListenerSlot();
    slot.set(() => {});
    slot.set(() => {});
    // 第二次 set 已注销第一次的 listener; 唯一活 listener 是第二次注册的
    let alive = 0;
    slot.set(() => { alive += 1; });
    slot.clear();
    expect(alive).toBe(1);
  });
});

describe('ImportDedup (单次拖拽/选择只导入一次)', () => {
  it('同一批路径 + 同 profile 在窗口内只放行一次', () => {
    const dedup = new ImportDedup(5000);
    expect(dedup.shouldFire(['/a.epub', '/b.epub'], 'default')).toBe(true);
    expect(dedup.shouldFire(['/a.epub', '/b.epub'], 'default')).toBe(false);
    expect(dedup.shouldFire(['/b.epub', '/a.epub'], 'default')).toBe(false, '路径顺序不影响去重');
  });

  it('不同路径或不同 profile 各自放行', () => {
    const dedup = new ImportDedup(5000);
    expect(dedup.shouldFire(['/a.epub'], 'default')).toBe(true);
    expect(dedup.shouldFire(['/a.epub'], 'kid')).toBe(true);
    expect(dedup.shouldFire(['/c.epub'], 'default')).toBe(true);
  });

  it('窗口期过后再次放行', () => {
    vi.useFakeTimers();
    const dedup = new ImportDedup(2000);
    expect(dedup.shouldFire(['/a.epub'], 'default')).toBe(true);
    expect(dedup.shouldFire(['/a.epub'], 'default')).toBe(false, '窗口期内去重');
    vi.advanceTimersByTime(2001);
    expect(dedup.shouldFire(['/a.epub'], 'default')).toBe(true, '窗口期过后再放行');
    vi.useRealTimers();
  });
});
