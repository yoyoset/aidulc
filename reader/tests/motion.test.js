import { describe, it, expect, beforeAll } from 'vitest';

let M;

beforeAll(async () => {
  await import('../core/motion.js');
  M = globalThis.AiduMotion;
});

const fakeWin = (matches) => ({
  matchMedia: (q) => ({ matches: q.includes('prefers-reduced-motion') ? matches : false }),
});

describe('AiduMotion', () => {
  it('系统开了「减少动态效果」→ 滚动用 auto (瞬间跳)', () => {
    expect(M.prefersReducedMotion(fakeWin(true))).toBe(true);
    expect(M.scrollBehavior(fakeWin(true))).toBe('auto');
  });

  it('没开 → 保持平滑滚动', () => {
    expect(M.prefersReducedMotion(fakeWin(false))).toBe(false);
    expect(M.scrollBehavior(fakeWin(false))).toBe('smooth');
  });

  it('环境没有 matchMedia 或它抛错 → 当作没开, 不抛', () => {
    expect(M.scrollBehavior({})).toBe('smooth');
    expect(M.scrollBehavior({ matchMedia: () => { throw new Error('boom'); } })).toBe('smooth');
  });

  it('查询的是 prefers-reduced-motion: reduce', () => {
    let seen = '';
    M.prefersReducedMotion({ matchMedia: (q) => { seen = q; return { matches: false }; } });
    expect(seen).toBe('(prefers-reduced-motion: reduce)');
  });
});
