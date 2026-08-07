import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let SearchIndex;

beforeAll(async () => {
  await import('../core/search_index.js');
  SearchIndex = globalThis.SearchIndex;
});

describe('SearchIndex', () => {
  let idx;
  beforeEach(() => { idx = new SearchIndex(); });

  const chapters = [
    {
      sentences: [
        { original_text: 'The quick brown fox.' },
        { original_text: 'jumps over the lazy dog.' },
        {}, // 缺 original_text(失败句/占位), 不应进索引也不应崩溃
      ],
    },
    {
      sentences: [
        { original_text: 'Second chapter starts HERE.' },
      ],
    },
  ];

  it('build 跳过缺 original_text 的句子, 不崩溃', () => {
    expect(() => idx.build(chapters)).not.toThrow();
    expect(idx.items.length).toBe(3);
  });

  it('build 处理空/null chapters', () => {
    expect(() => idx.build(null)).not.toThrow();
    expect(() => idx.build([])).not.toThrow();
    idx.build([{ sentences: [] }]);
    expect(idx.items.length).toBe(0);
  });

  it('search 大小写不敏感', () => {
    idx.build(chapters);
    const hits = idx.search('here');
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe('Second chapter starts HERE.');
  });

  it('search 携带正确的 chapter/index 定位信息', () => {
    idx.build(chapters);
    const hits = idx.search('lazy');
    expect(hits).toEqual([{ chapter: 0, index: 1, text: 'jumps over the lazy dog.' }]);
  });

  it('search 空查询返回空数组', () => {
    idx.build(chapters);
    expect(idx.search('')).toEqual([]);
    expect(idx.search('   ')).toEqual([]);
    expect(idx.search(null)).toEqual([]);
  });

  it('search 无命中返回空数组', () => {
    idx.build(chapters);
    expect(idx.search('nonexistent-xyz')).toEqual([]);
  });

  it('search 命中数量在 500 条截断("防爆")', () => {
    const manySentences = Array.from({ length: 600 }, (_, i) => ({
      original_text: `repeated needle sentence number ${i}`,
    }));
    idx.build([{ sentences: manySentences }]);
    const hits = idx.search('needle');
    expect(hits.length).toBe(500);
  });

  it('first 返回首个命中或 null', () => {
    idx.build(chapters);
    expect(idx.first('fox').text).toBe('The quick brown fox.');
    expect(idx.first('nonexistent-xyz')).toBeNull();
  });
});
