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
    expect(r.messages).toEqual([]);
  });

  it('不达标的书不放行, 并报出原因', () => {
    const r = evaluate(['C:/good.epub', 'C:/bad.epub'], [A('ok'), A('block', '解析结果过少: 0 章')]);
    expect(r.accepted).toEqual(['C:/good.epub']);
    expect(r.blocked.map((b) => b.name)).toEqual(['bad']);
    expect(r.messages[0].level).toBe('error');
    expect(r.messages[0].text).toContain('解析结果过少');
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
    expect(r.messages).toEqual([]);
  });

  it('体检结果缺失(数组短/为空)按放行处理, 不因为体检本身出错就拦人', () => {
    expect(evaluate(['C:/a.epub'], []).accepted).toEqual(['C:/a.epub']);
    expect(evaluate(['C:/a.epub'], null).accepted).toEqual(['C:/a.epub']);
  });

  it('阻断和警告同时存在 → 两条消息, 阻断在前', () => {
    const r = evaluate(
      ['C:/bad.epub', 'C:/w.epub'],
      [A('block', '打不开'), A('warn', '标题缺失')],
    );
    expect(r.messages.map((m) => m.level)).toEqual(['error', 'warning']);
    expect(r.accepted).toEqual(['C:/w.epub']);
  });

  it('书名取文件名去扩展名和站点后缀', () => {
    const r = evaluate(['C:/Books/Holes (Louis Sachar) (z-library.sk).epub'], [A('block', 'x')]);
    expect(r.blocked[0].name).toBe('Holes');
  });

  it('全部不达标 → 放行名单为空(调用方据此不发起导入)', () => {
    const r = evaluate(['C:/a.epub'], [A('block', 'x')]);
    expect(r.accepted).toEqual([]);
  });
});
