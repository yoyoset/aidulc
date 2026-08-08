// render_plan.js —— 渐进式渲染补建区间计划(纯逻辑, 零 DOM)
// R1 后置验证: ensureRendered / IntersectionObserver 共用同一份边界决策,
// 这里锁死"补建到哪个下标、分几片"的边界行为。
import { describe, it, expect, beforeAll } from 'vitest';

let Plan;

beforeAll(async () => {
  await import('../core/render_plan.js');
  Plan = globalThis.AiduRenderPlan;
});

describe('AiduRenderPlan', () => {
  it('neededUpTo: 未建时补到目标, 已建过则不需要', () => {
    expect(Plan.neededUpTo(-1, 10, 100)).toBe(10);
    expect(Plan.neededUpTo(5, 10, 100)).toBe(10);
    expect(Plan.neededUpTo(10, 10, 100)).toBe(-1);
    expect(Plan.neededUpTo(50, 10, 100)).toBe(-1);
  });

  it('neededUpTo: 封顶到合法区间, 空书返回 -1', () => {
    expect(Plan.neededUpTo(-1, 999, 100)).toBe(99);
    expect(Plan.neededUpTo(-1, -5, 100)).toBe(0);
    expect(Plan.neededUpTo(-1, 10, 0)).toBe(-1);
    expect(Plan.neededUpTo(-1, 10, -1)).toBe(-1);
  });

  it('renderRanges: 从当前进度分片, 每片不超过 batchSize', () => {
    const ranges = Plan.renderRanges(-1, 9, 5, 100);
    expect(ranges).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 9 },
    ]);
  });

  it('renderRanges: 不足一片时只有一片', () => {
    const ranges = Plan.renderRanges(2, 5, 10, 100);
    expect(ranges).toEqual([{ from: 3, to: 5 }]);
  });

  it('renderRanges: 不需要补建时返回空', () => {
    expect(Plan.renderRanges(10, 5, 10, 100)).toEqual([]);
    expect(Plan.renderRanges(-1, 10, 10, 0)).toEqual([]);
  });

  it('renderRanges: 目标超出总句数时封顶到最后一句', () => {
    const ranges = Plan.renderRanges(95, 999, 10, 100);
    expect(ranges).toEqual([{ from: 96, to: 99 }]);
  });

  it('clampTotal: 越界封顶', () => {
    expect(Plan.clampTotal(50, 100)).toBe(50);
    expect(Plan.clampTotal(200, 100)).toBe(99);
    expect(Plan.clampTotal(-1, 100)).toBe(0);
    expect(Plan.clampTotal(0, 0)).toBe(-1);
  });
});
