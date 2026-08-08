import { describe, it, expect, beforeAll } from 'vitest';

let ReaderState;

beforeAll(async () => {
  await import('../core/reader_state.js');
  ReaderState = globalThis.AiduReaderState;
});

describe('ReaderState - 模式与节奏', () => {
  it('默认先答后核 + 通篇', () => {
    const s = new ReaderState();
    expect(s.displayMode).toBe('guess');
    expect(s.pace).toBe('flow');
  });

  it('非法值回退默认', () => {
    expect(new ReaderState({ displayMode: 'bogus' }).displayMode).toBe('guess');
    expect(new ReaderState({ pace: 'nope' }).pace).toBe('flow');
  });

  it('setMode/setPace 只接受合法值', () => {
    const s = new ReaderState();
    expect(s.setMode('bench')).toBe(true);
    expect(s.displayMode).toBe('bench');
    expect(s.setMode('xyz')).toBe(false);
    expect(s.displayMode).toBe('bench');
    expect(s.setPace('sentence')).toBe(true);
    expect(s.setPace('x')).toBe(false);
    expect(s.pace).toBe('sentence');
  });

  it('togglePace 双向切换', () => {
    const s = new ReaderState();
    expect(s.togglePace()).toBe('sentence');
    expect(s.togglePace()).toBe('flow');
  });
});

describe('ReaderState - 已核对 / 揭示 / 折叠 (先答后核策略)', () => {
  it('首次揭示 → newlyVerified, 之后再揭示不再新记', () => {
    const s = new ReaderState();
    const r1 = s.reveal(3);
    expect(r1.newlyVerified).toBe(true);
    expect(s.isVerified(3)).toBe(true);
    const r2 = s.reveal(3);
    expect(r2.newlyVerified).toBe(false);
  });

  it('reveal 同时计入本访揭示, collapse 移除', () => {
    const s = new ReaderState();
    s.reveal(5);
    expect(s.isRevealed(5)).toBe(true);
    s.collapse(5);
    expect(s.isRevealed(5)).toBe(false);
    expect(s.isVerified(5)).toBe(true); // 已核对不随收起回退
  });

  it('supportFor(guess): 本访正揭示 → revealed', () => {
    const s = new ReaderState();
    s.reveal(0);
    expect(s.supportFor('guess', 0)).toBe('revealed');
  });

  it('supportFor(guess): 已核对未本访揭示 → scar (再次读到折叠细痕)', () => {
    const s = new ReaderState();
    s.reveal(1);
    s.collapse(1);
    expect(s.supportFor('guess', 1)).toBe('scar');
    // 直接 restore 进来的已核对集合同样生效
    const s2 = new ReaderState();
    s2.restoreVerified([7, 9]);
    expect(s2.supportFor('guess', 7)).toBe('scar');
    expect(s2.supportFor('guess', 9)).toBe('scar');
  });

  it('supportFor(guess): 未核对未揭示 → hidden', () => {
    const s = new ReaderState();
    expect(s.supportFor('guess', 2)).toBe('hidden');
  });

  it('supportFor(silent/bench): 一律 hidden, 译文不内联出现', () => {
    const s = new ReaderState();
    s.reveal(0);
    expect(s.supportFor('silent', 0)).toBe('hidden');
    expect(s.supportFor('bench', 0)).toBe('hidden');
  });

  it('hintFor: guess 区分未核对/已核对, silent/bench 不同文案', () => {
    const s = new ReaderState();
    expect(s.hintFor('guess', 0)).toContain('先自己讲一遍');
    s.reveal(0);
    s.collapse(0);
    expect(s.hintFor('guess', 0)).toContain('已核对过');
    expect(s.hintFor('silent', 0)).toContain('T');
    expect(s.hintFor('bench', 0)).toBe('');
  });

  it('onLeave(guess): 收起本访揭示并返回 scar', () => {
    const s = new ReaderState();
    s.reveal(4);
    expect(s.onLeave('guess', 4)).toBe('scar');
    expect(s.isRevealed(4)).toBe(false);
    expect(s.isVerified(4)).toBe(true);
  });

  it('onLeave(silent): 返回 hidden', () => {
    const s = new ReaderState();
    expect(s.onLeave('silent', 4)).toBe('hidden');
  });

  it('verifiedArray 排序去重', () => {
    const s = new ReaderState();
    [5, 1, 5, 3].forEach((i) => s.reveal(i));
    expect(s.verifiedArray()).toEqual([1, 3, 5]);
    expect(s.verifiedCount()).toBe(3);
  });
});
