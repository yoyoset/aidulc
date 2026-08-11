import { describe, it, expect, beforeAll } from 'vitest';

let T;

beforeAll(async () => {
  await import('../core/theme.js');
  T = globalThis.AiduTheme;
});

describe('AiduTheme.deriveCustomPalette', () => {
  it('深色强调色 → 白字 (WCAG 达标)', () => {
    const p = T.deriveCustomPalette('#3b6b8a');
    expect(p['--md-sys-color-on-primary']).toBe('#ffffff');
    const ratio = T.contrast(p['--md-sys-color-on-primary'], p['--md-sys-color-primary']);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('浅色强调色 → 黑字 (WCAG 达标)', () => {
    const p = T.deriveCustomPalette('#e8b88a');
    expect(p['--md-sys-color-on-primary']).toBe('#000000');
    const ratio = T.contrast(p['--md-sys-color-on-primary'], p['--md-sys-color-primary']);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('默认陶土 → 白字且容器对达标', () => {
    const p = T.deriveCustomPalette('#9c6a4a');
    expect(p['--md-sys-color-on-primary']).toBe('#ffffff');
    const c = T.contrast(p['--md-sys-color-on-primary-container'], p['--md-sys-color-primary-container']);
    expect(c).toBeGreaterThanOrEqual(4.5);
  });

  it('短 hex 归一化 + 非法输入回落默认', () => {
    // 3 位缩写 #3b8 → #33bb88
    expect(T.deriveCustomPalette('#3b8')['--md-sys-color-primary']).toBe('#33bb88');
    expect(T.deriveCustomPalette('')['--md-sys-color-primary']).toBe('#9c6a4a');
  });

  it('state 层与 accent 都来自同一色', () => {
    const p = T.deriveCustomPalette('#3b6b8a');
    expect(p['--rd-accent']).toBe('#3b6b8a');
    expect(p['--md-sys-state-hover']).toContain('59, 107, 138');
  });
});

describe('AiduTheme.resolveTheme (L9 跟随系统)', () => {
  it('light → light, dark → dark', () => {
    expect(T.resolveTheme('light')).toBe('light');
    expect(T.resolveTheme('dark')).toBe('dark');
  });
  it('system → 注入的系统深色判定', () => {
    expect(T.resolveTheme('system', true)).toBe('dark');
    expect(T.resolveTheme('system', false)).toBe('light');
  });
  it('未设置/未知 → light', () => {
    expect(T.resolveTheme(undefined)).toBe('light');
    expect(T.resolveTheme('')).toBe('light');
    expect(T.resolveTheme('neon')).toBe('light');
  });
  it('system 无注入且无 matchMedia → light', () => {
    // 测试环境 window 存在但 matchMedia 不可用 → 回落 light
    expect(T.resolveTheme('system')).toBe('light');
  });
});
