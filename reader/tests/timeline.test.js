import { describe, it, expect, beforeAll } from 'vitest';

let findWordIndex, findSentenceIndex;

beforeAll(async () => {
  await import('../core/timeline.js');
  ({ findWordIndex, findSentenceIndex } = globalThis.AiduTimeline);
});

describe('findWordIndex', () => {
  const words = [
    { seg_idx: 0, start_ms: 0, end_ms: 200 },
    { seg_idx: 2, start_ms: 200, end_ms: 500 }, // seg_idx 稀疏(跳过标点), 时间轴仍连续
    { seg_idx: 3, start_ms: 600, end_ms: 900 }, // 与上一词间有 100ms 间隙(非连续)
  ];

  it('空/null 输入返回 -1', () => {
    expect(findWordIndex(null, 100)).toBe(-1);
    expect(findWordIndex([], 100)).toBe(-1);
  });

  it('命中区间内返回下标', () => {
    expect(findWordIndex(words, 0)).toBe(0);
    expect(findWordIndex(words, 150)).toBe(0);
    expect(findWordIndex(words, 700)).toBe(2);
  });

  it('区间左闭右开: start_ms 命中, end_ms 不命中(算下一词)', () => {
    expect(findWordIndex(words, 200)).toBe(1); // words[0].end_ms === words[1].start_ms
  });

  it('落在词间间隙(非连续时间轴)返回 -1', () => {
    expect(findWordIndex(words, 550)).toBe(-1); // 500~600 之间的间隙
  });

  it('早于第一词 / 晚于最后一词返回 -1', () => {
    expect(findWordIndex(words, -1)).toBe(-1);
    expect(findWordIndex(words, 900)).toBe(-1);
  });

  it('单词数组', () => {
    expect(findWordIndex([{ start_ms: 0, end_ms: 100 }], 50)).toBe(0);
  });
});

describe('findSentenceIndex', () => {
  it('空/null 输入返回 -1', () => {
    expect(findSentenceIndex(null, 0)).toBe(-1);
    expect(findSentenceIndex([], 0)).toBe(-1);
  });

  it('命中句内区间返回下标', () => {
    const sentences = [
      { audio: { start_ms: 0, end_ms: 1000 } },
      { audio: { start_ms: 1400, end_ms: 2400 } }, // 句间 400ms 留白
    ];
    expect(findSentenceIndex(sentences, 500)).toBe(0);
    expect(findSentenceIndex(sentences, 2000)).toBe(1);
  });

  it('落在句间留白: 保持上一句高亮(产品设计意图, 非"未命中")', () => {
    const sentences = [
      { audio: { start_ms: 0, end_ms: 1000 } },
      { audio: { start_ms: 1400, end_ms: 2400 } },
    ];
    expect(findSentenceIndex(sentences, 1200)).toBe(0);
  });

  it('早于第一句返回 -1', () => {
    const sentences = [{ audio: { start_ms: 1000, end_ms: 2000 } }];
    expect(findSentenceIndex(sentences, 500)).toBe(-1);
  });

  it('晚于最后一句: 仍返回最后一句下标(与句间留白语义一致, 非 -1)', () => {
    const sentences = [{ audio: { start_ms: 0, end_ms: 1000 } }];
    expect(findSentenceIndex(sentences, 5000)).toBe(0);
  });

  it('句子缺失 audio 字段: 不崩溃, 但会二分到错误的更早句(已知窄边界, 见下方说明)', () => {
    // 实测锁定的真实行为(不是预期行为): 当前实现把 !a 统一当成"目标在更早位置"
    // 处理(hi = mid - 1), 不管真实目标其实在更晚的位置。对这组输入, 时间 1200ms
    // 明明落在 sentences[2] 的区间内, 但因为中间的 sentences[1] 缺 audio 把二分
    // "带偏"了, 实际返回 0 而不是 2 —— 这是本次写测试时用运行结果核实出来的,
    // 不是猜测的预期值。
    //
    // 生产环境理论上不会撞到这个输入: pack.py 的 B3 修复(memory/pipeline.md)保证
    // 失败句也会写静音占位 audio, 不会真的缺字段。这里测试的是"万一"(旧版书包/
    // 手工编辑/未来 pipeline 改动引入回归) —— 前端至少不能崩溃, 具体二分结果的
    // 正确性留作已知限制, 不在 S1 范围内修。
    const sentences = [
      { audio: { start_ms: 0, end_ms: 500 } },
      { audio: null },
      { audio: { start_ms: 1000, end_ms: 1500 } },
    ];
    expect(() => findSentenceIndex(sentences, 1200)).not.toThrow();
    expect(findSentenceIndex(sentences, 1200)).toBe(0);
  });
});
