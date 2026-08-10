import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

let ShadowMachine;

beforeAll(async () => {
  await import('../core/shadow.js');
  ShadowMachine = globalThis.ShadowMachine;
});

describe('ShadowMachine - 重复播放', () => {
  let sm, actions;

  beforeEach(() => {
    sm = new ShadowMachine();
    actions = [];
    sm.onAction = (a) => actions.push(a);
  });

  it('默认 repeatCount=1: 播完立即进下一句', () => {
    sm.sentenceStarted(0);
    sm.sentenceEnded(0);
    expect(actions).toEqual([{ type: 'next', sentenceIndex: 1 }]);
  });

  it('repeatCount=3: 前两次 repeat, 第三次才 next', () => {
    sm.setRepeat(3);
    sm.sentenceStarted(0);
    sm.sentenceEnded(0);
    sm.sentenceEnded(0);
    sm.sentenceEnded(0);
    expect(actions.map((a) => a.type)).toEqual(['repeat', 'repeat', 'next']);
    expect(actions[2].sentenceIndex).toBe(1);
  });

  it('同一句重复 sentenceStarted 不重置计数(防止重播意外重置重复次数)', () => {
    sm.setRepeat(2);
    sm.sentenceStarted(0);
    sm.sentenceEnded(0); // repeatLeft: 2 -> 1, emit repeat
    sm.sentenceStarted(0); // 同索引, 不应重置 repeatLeft
    sm.sentenceEnded(0); // repeatLeft: 1 -> 0, emit next
    expect(actions.map((a) => a.type)).toEqual(['repeat', 'next']);
  });

  it('换到新句 sentenceStarted 会重置计数', () => {
    sm.setRepeat(2);
    sm.sentenceStarted(0);
    sm.sentenceEnded(0); // repeat
    sm.sentenceStarted(1); // 新句, 重置
    sm.sentenceEnded(1); // repeatLeft: 2 -> 1, emit repeat (不是 next)
    expect(actions.map((a) => a.type)).toEqual(['repeat', 'repeat']);
  });

  it('sentenceEnded 的 index 与当前句不符: 忽略(过期事件, 如快速切句后迟到的回调)', () => {
    sm.sentenceStarted(0);
    sm.sentenceEnded(1); // 不是当前句, 应忽略
    expect(actions).toEqual([]);
  });

  it('onComplete 只在最终 next 时触发, repeat 阶段不触发', () => {
    sm.setRepeat(2);
    let completedCount = 0;
    const onComplete = () => completedCount++;
    sm.sentenceStarted(0);
    sm.sentenceEnded(0, onComplete); // repeat, 不应调用
    expect(completedCount).toBe(0);
    sm.sentenceEnded(0, onComplete); // next, 应调用
    expect(completedCount).toBe(1);
  });
});

describe('ShadowMachine - 参数钳制', () => {
  let sm;
  beforeEach(() => { sm = new ShadowMachine(); });

  it('setRepeat 下限钳制为 1', () => {
    sm.setRepeat(0);
    expect(sm.repeatCount).toBe(1);
    sm.setRepeat(-5);
    expect(sm.repeatCount).toBe(1);
  });

  it('setGap 下限钳制为 0', () => {
    sm.setGap(-100);
    expect(sm.gapMs).toBe(0);
  });

  it('setSpeed 钳制在 [0.5, 2]', () => {
    sm.setSpeed(0.1);
    expect(sm.speed).toBe(0.5);
    sm.setSpeed(10);
    expect(sm.speed).toBe(2);
    sm.setSpeed(1.5);
    expect(sm.speed).toBe(1.5);
  });
});

describe('ShadowMachine - A-B 循环', () => {
  let sm;
  beforeEach(() => { sm = new ShadowMachine(); });

  it('未设置循环: 永不触发跳回', () => {
    expect(sm.shouldLoopBack(999999)).toBeFalsy();
    expect(sm.loopBackPoint()).toBeNull();
  });

  it('设置循环: 到达终点触发跳回, 起点可查', () => {
    sm.setABLoop(1000, 2000);
    expect(sm.shouldLoopBack(1999)).toBe(false);
    expect(sm.shouldLoopBack(2000)).toBe(true); // 边界: >= end_ms
    expect(sm.loopBackPoint()).toBe(1000);
  });

  it('传 null 关闭循环', () => {
    sm.setABLoop(1000, 2000);
    sm.setABLoop(null, null);
    expect(sm.abLoop).toBeNull();
    expect(sm.loopBackPoint()).toBeNull();
  });
});

describe('ShadowMachine - S5 单句停止', () => {
  let sm;
  beforeEach(() => { sm = new ShadowMachine(); });

  it('stopAtMs=null: 永不触发停止', () => {
    expect(sm.shouldStopAt(999999, null)).toBe(false);
  });

  it('未越过句末: 不停', () => {
    expect(sm.shouldStopAt(4999, 5000)).toBe(false);
  });

  it('越过句末: 触发停止判定', () => {
    expect(sm.shouldStopAt(5000, 5000)).toBe(true); // 边界: >= end
    expect(sm.shouldStopAt(5300, 5000)).toBe(true);
  });

  it('S5 验收核心: 单句 stopAt 越界即产出"应停"; 重复未用完 → sentenceEnded 出 repeat 而非停', () => {
    sm.setRepeat(2);
    sm.sentenceStarted(0);
    // 第一次越过句末: shouldStopAt true → 喂给 sentenceEnded
    expect(sm.shouldStopAt(5000, 5000)).toBe(true);
    const actions = [];
    sm.onAction = (a) => actions.push(a);
    sm.sentenceEnded(0); // repeatLeft 2->1 → repeat
    expect(actions.map((a) => a.type)).toEqual(['repeat']);
    // 重复期间时间回跳 (< 句末) → 不触发停止
    expect(sm.shouldStopAt(4000, 5000)).toBe(false);
    // 第二次越过: repeatLeft 1->0 → next (逐句模式下 next 即停)
    sm.sentenceEnded(0);
    expect(actions.map((a) => a.type)).toEqual(['repeat', 'next']);
  });
});
