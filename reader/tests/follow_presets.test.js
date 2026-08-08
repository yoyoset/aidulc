import { describe, it, expect, beforeAll } from 'vitest';

let FollowPresets;

beforeAll(async () => {
  await import('../core/follow_presets.js');
  FollowPresets = globalThis.AiduFollowPresets;
});

describe('FollowPresets - 三个命名预设', () => {
  it('三预设参数符合设计 §2.7', () => {
    const p = FollowPresets.presetByKey('first');
    expect(p).toMatchObject({ repeat: 1, gapMs: 0, speed: 1.0, blind: false });
    const sh = FollowPresets.presetByKey('shadow');
    expect(sh).toMatchObject({ repeat: 2, gapMs: 900, speed: 0.9, blind: false });
    const bl = FollowPresets.presetByKey('blind');
    expect(bl).toMatchObject({ repeat: 3, gapMs: 1200, speed: 0.8, blind: true });
  });

  it('allPresets 按展示顺序返回', () => {
    expect(FollowPresets.allPresets().map((p) => p.key)).toEqual(['first', 'shadow', 'blind']);
  });

  it('applyPreset 把参数写进 shadow, 返回预设', () => {
    const shadow = { setRepeat: (n) => (shadow.repeat = n), setGap: (n) => (shadow.gap = n), setSpeed: (n) => (shadow.speed = n) };
    const p = FollowPresets.applyPreset('blind', shadow);
    expect(shadow.repeat).toBe(3);
    expect(shadow.gap).toBe(1200);
    expect(shadow.speed).toBe(0.8);
    expect(p.key).toBe('blind');
  });

  it('未知 key: applyPreset 返回 null 不改值, presetByKey 返回 null', () => {
    const shadow = { setRepeat() { throw new Error('不应调用'); }, setGap() {}, setSpeed() {} };
    expect(FollowPresets.applyPreset('nope', shadow)).toBeNull();
    expect(FollowPresets.presetByKey('nope')).toBeNull();
  });
});
