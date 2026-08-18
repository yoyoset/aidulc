import { describe, it, expect, beforeAll } from 'vitest';

let realFailures;

beforeAll(async () => {
  await import('../core/quality_notice.js');
  realFailures = globalThis.AiduQualityNotice.realFailures;
});

const entry = (stages) => ({ index: 0, stages });

describe('AiduQualityNotice.realFailures', () => {
  it('全是 nlp_realign → 全部排除', () => {
    expect(realFailures([entry(['nlp_realign']), entry(['nlp_realign', 'nlp_realign'])])).toEqual([]);
  });

  it('混合 → 只保留含真实阶段的条目', () => {
    const kept = realFailures([
      entry(['nlp_realign']),
      entry(['tts', 'nlp_realign']),
      entry(['nlp_realign', 'parse']),
      entry(['tts']),
    ]);
    expect(kept).toHaveLength(3);
    expect(kept.map((f) => f.stages)).toEqual([
      ['tts', 'nlp_realign'],
      ['nlp_realign', 'parse'],
      ['tts'],
    ]);
  });

  it('完全没有 nlp_realign → 全保留', () => {
    expect(realFailures([entry(['tts']), entry(['parse', 'tts'])])).toHaveLength(2);
  });

  it('stages 缺失的条目按真实失败算', () => {
    expect(realFailures([{ index: 0 }, entry(['nlp_realign'])])).toHaveLength(1);
  });
});

describe('quality_notice 空 stages', () => {
  it('空 stages 数组按真实失败算 (与 Rust 侧同判据)', () => {
    // 原实现走 [].some() → false → 被静默过滤掉, 和注释写的相反
    expect(realFailures([{ index: 0, stages: [] }]).length).toBe(1);
  });
});
