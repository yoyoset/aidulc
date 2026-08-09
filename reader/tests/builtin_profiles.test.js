import { describe, it, expect, beforeAll } from 'vitest';

let BP;

beforeAll(async () => {
  await import('../core/builtin_profiles.js');
  BP = globalThis.AiduBuiltinProfiles;
});

describe('BuiltinProfiles - 内建档案单一真相源 (2026-08-09 硬编码去重)', () => {
  it('default / kid 参数与历史一致 (import_service 与 settings_view 曾各写一份)', () => {
    expect(BP.builtinProfile('default')).toMatchObject({
      id: 'default', name: '成人自读', explain_strategy: 'brief',
      voice: 'af_heart', speed: 1.0, highlight_granularity: 'sentence',
    });
    expect(BP.builtinProfile('kid')).toMatchObject({
      id: 'kid', name: '陪小孩读', explain_strategy: 'deep',
      voice: 'af_heart', speed: 0.9, highlight_granularity: 'word',
    });
  });

  it('未知 id 回退 default, 空 id 也回退 default', () => {
    expect(BP.builtinProfile('nope').id).toBe('default');
    expect(BP.builtinProfile(undefined).id).toBe('default');
    expect(BP.builtinProfile('').id).toBe('default');
  });

  it('builtinProfile 返回拷贝, 改动不污染常量表', () => {
    const a = BP.builtinProfile('default');
    a.speed = 99;
    expect(BP.builtinProfile('default').speed).toBe(1.0);
    expect(BP.BUILTIN_PROFILES.default.speed).toBe(1.0);
  });

  it('ensureBuiltins 补缺失内建项: default 队首 / kid 队尾, 已有则不重复', () => {
    expect(BP.ensureBuiltins([]).map((p) => p.id)).toEqual(['default', 'kid']);
    const got = BP.ensureBuiltins([{ id: 'x', name: '自建' }]);
    expect(got.map((p) => p.id)).toEqual(['default', 'x', 'kid']);
    // 已存在 → 不再补
    expect(BP.ensureBuiltins([{ id: 'default' }, { id: 'kid' }]).map((p) => p.id)).toEqual(['default', 'kid']);
  });

  it('ensureBuiltins 不改动原数组', () => {
    const src = [{ id: 'a' }];
    BP.ensureBuiltins(src);
    expect(src.length).toBe(1);
  });

  it('音色候选非空且默认音色在前', () => {
    expect(BP.VOICES.length).toBeGreaterThanOrEqual(1);
    expect(BP.VOICES[0][0]).toBe('af_heart');
  });
});
