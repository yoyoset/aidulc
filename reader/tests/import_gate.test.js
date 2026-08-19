import { describe, it, expect, beforeAll } from 'vitest';

let evaluate;

beforeAll(async () => {
  await import('../core/import_gate.js');
  evaluate = globalThis.AiduImportGate.evaluate;
});

const A = (verdict, msg) => ({
  verdict,
  issues: msg ? [{ code: 'S3', level: verdict, message: msg }] : [],
});

describe('AiduImportGate.evaluate', () => {
  it('全部达标 → 全放行, 不打扰用户', () => {
    const r = evaluate(['C:/a.epub', 'C:/b.epub'], [A('ok'), A('ok')]);
    expect(r.accepted).toEqual(['C:/a.epub', 'C:/b.epub']);
    expect(r.pendingStandardize).toEqual([]);
    expect(r.messages).toEqual([]);
  });

  // AUTOSTANDARDIZE (2026-08-19): 不再拒绝导入 —— block 也进 accepted,
  // 额外进 pendingStandardize 让后台尝试自动转换; 提示降为 info 级。
  it('格式不标准的书照常导入并进 pendingStandardize, 提示后台自动转换', () => {
    const r = evaluate(['C:/good.epub', 'C:/bad.epub'], [A('ok'), A('block', '解析结果过少: 0 章')]);
    expect(r.accepted).toEqual(['C:/good.epub', 'C:/bad.epub']);
    expect(r.pendingStandardize).toEqual(['C:/bad.epub']);
    expect(r.messages[0].level).toBe('info');
    expect(r.messages[0].text).toContain('已导入并在后台尝试自动转换');
    expect(r.messages[0].text).toContain('解析结果过少');
  });

  it('不再有 blocked 键(无法彻底拒绝一本书)', () => {
    const r = evaluate(['C:/bad.epub'], [A('block', 'x')]);
    expect(r.blocked).toBeUndefined();
  });

  it('有警告的书照常导入, 只提示一句', () => {
    const r = evaluate(['C:/w.epub'], [A('warn', '54/55 章标题缺失')]);
    expect(r.accepted).toEqual(['C:/w.epub']);
    expect(r.warned).toHaveLength(1);
    expect(r.messages[0].level).toBe('warning');
    expect(r.messages[0].text).toContain('仍已导入');
  });

  it('判不了(unknown, 侧车不可用/非 EPUB)按放行处理, 不挡住用户', () => {
    const r = evaluate(['C:/x.txt'], [{ verdict: 'unknown', issues: [], error: '非 EPUB' }]);
    expect(r.accepted).toEqual(['C:/x.txt']);
    expect(r.pendingStandardize).toEqual([]);
    expect(r.messages).toEqual([]);
  });

  it('体检结果缺失(数组短/为空)按放行处理, 不因为体检本身出错就拦人', () => {
    expect(evaluate(['C:/a.epub'], []).accepted).toEqual(['C:/a.epub']);
    expect(evaluate(['C:/a.epub'], null).accepted).toEqual(['C:/a.epub']);
  });

  it('不标准和警告同时存在 → 两条消息, 不标准的提示在前', () => {
    const r = evaluate(
      ['C:/bad.epub', 'C:/w.epub'],
      [A('block', '打不开'), A('warn', '标题缺失')],
    );
    expect(r.messages.map((m) => m.level)).toEqual(['info', 'warning']);
    expect(r.accepted).toEqual(['C:/bad.epub', 'C:/w.epub']);
    expect(r.pendingStandardize).toEqual(['C:/bad.epub']);
  });

  it('书名取文件名去扩展名和站点后缀', () => {
    const r = evaluate(['C:/Books/Holes (Louis Sachar) (z-library.sk).epub'], [A('block', 'x')]);
    expect(r.messages[0].text).toContain('Holes(x)');
  });

  it('全部不达标 → 也全部照常导入, 全进 pendingStandardize', () => {
    const r = evaluate(['C:/a.epub'], [A('block', 'x')]);
    expect(r.accepted).toEqual(['C:/a.epub']);
    expect(r.pendingStandardize).toEqual(['C:/a.epub']);
  });

  it('达标/警告/判不了的书不进 pendingStandardize(只 block 进)', () => {
    const r = evaluate(
      ['C:/a.epub', 'C:/b.epub', 'C:/c.epub'],
      [A('ok'), A('warn', '标题缺失'), { verdict: 'unknown', issues: [], error: '非 EPUB' }],
    );
    expect(r.accepted).toEqual(['C:/a.epub', 'C:/b.epub', 'C:/c.epub']);
    expect(r.pendingStandardize).toEqual([]);
    expect(r.messages.map((m) => m.level)).toEqual(['warning']);
  });
});
