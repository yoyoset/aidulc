import { describe, it, expect, beforeAll } from 'vitest';

let H;

beforeAll(async () => {
  await import('../core/sentence_health.js');
  H = globalThis.AiduSentenceHealth;
});

describe('AiduSentenceHealth.issuesOf', () => {
  it('正常句 → 没有问题', () => {
    expect(H.issuesOf({ original_text: 'Hi.', status: 'ok', failedStages: [] })).toEqual([]);
    expect(H.isFlagged({ original_text: 'Hi.' })).toBe(false); // 老书包没有这两个字段
  });

  it('失败环节翻成人话, 并按流水线顺序排 (不管后端数组顺序)', () => {
    const r = H.issuesOf({ status: 'partial', failedStages: ['align', 'tts', 'translate'] });
    expect(r.map((x) => x.stage)).toEqual(['translate', 'tts', 'align']);
    expect(H.describe(r)).toBe('翻译、朗读、逐词高亮');
  });

  it('重复阶段去重', () => {
    expect(H.issuesOf({ failedStages: ['tts', 'tts'] }).length).toBe(1);
  });

  it('未知阶段名原样保留, 不吞掉', () => {
    const r = H.issuesOf({ failedStages: ['future-stage'] });
    expect(r).toEqual([{ stage: 'future-stage', label: 'future-stage' }]);
  });

  it('status 是 partial/failed 但没写明环节 → 仍然标出, 不能因缺细节当没事', () => {
    expect(H.issuesOf({ status: 'failed', failedStages: [] }).length).toBe(1);
    expect(H.issuesOf({ status: 'partial' })[0].stage).toBe('unknown');
  });

  it('译文为空不算失败 (原文无可翻译内容会被刻意跳过, 不猜)', () => {
    expect(H.isFlagged({ original_text: '* * *', translation: '', status: 'ok', failedStages: [] })).toBe(false);
  });

  it('坏输入不抛', () => {
    expect(H.issuesOf(null)).toEqual([]);
    expect(H.issuesOf('x')).toEqual([]);
    expect(H.issuesOf({ failedStages: 'tts' })).toEqual([]); // 不是数组
    expect(H.describe(undefined)).toBe('');
  });

  it('countFlagged 数一章里有问题的句子', () => {
    const ch = [{ status: 'ok' }, { failedStages: ['tts'] }, { status: 'partial' }, {}];
    expect(H.countFlagged(ch)).toBe(2);
    expect(H.countFlagged(undefined)).toBe(0);
  });
});
