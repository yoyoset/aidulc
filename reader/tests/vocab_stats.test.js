import { describe, it, expect, beforeAll } from 'vitest';

let S;

beforeAll(async () => {
  await import('../core/vocab_stats.js');
  S = globalThis.AiduVocabStats;
});

const NOW = 1_000_000_000_000; // 固定时间点, 测试可复现
const DAY = 86400000; // 字面量: S 在 beforeAll 后才可用, 模块级不能用 S.DAY_MS

describe('AiduVocabStats.dailyBuckets', () => {
  it('返回 days 天, 从旧到新', () => {
    const b = S.dailyBuckets([], 7, NOW);
    expect(b.length).toBe(7);
    expect(b[0].day).toBeLessThan(b[6].day);
  });

  it('当天加入 → 最后一个桶', () => {
    const b = S.dailyBuckets([{ added_at: NOW - 60_000 }], 7, NOW);
    expect(b[6].count).toBe(1);
    expect(b[5].count).toBe(0);
  });

  it('3 天前加入 → 对应桶', () => {
    const b = S.dailyBuckets([{ added_at: NOW - 3 * DAY }, { added_at: NOW - 3 * DAY - 1000 }], 7, NOW);
    expect(b[3].count).toBe(2);
  });

  it('超窗口/未来时间不计入', () => {
    const b = S.dailyBuckets([
      { added_at: NOW - 20 * DAY }, // 太老
      { added_at: NOW + DAY },      // 未来
      { added_at: 0 },              // 无时间
    ], 7, NOW);
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(0);
  });

  it('多天分布求和等于窗口内总数', () => {
    const entries = [0, 1, 2, 5, 6].map((i) => ({ added_at: NOW - i * DAY }));
    const b = S.dailyBuckets(entries, 7, NOW);
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(5);
  });
});
