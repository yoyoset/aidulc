import { describe, it, expect, beforeAll } from 'vitest';

let S;
beforeAll(async () => {
  await import('../core/title_cleanup.js');
  S = globalThis.AiduTitleCleanup;
});

describe('AiduTitleCleanup.parseBookTitle (G5 书名/作者清洗)', () => {
  it('剥来源站后缀 + 提取作者 (H5 截图的真实例子)', () => {
    const r = S.parseBookTitle('Because of Winn-Dixie (Kate DiCamillo) (z-library.sk, 1lib.sk, z-lib.sk).epub');
    expect(r.title).toBe('Because of Winn-Dixie');
    expect(r.author).toBe('Kate DiCamillo');
  });

  it('剥扩展名', () => {
    expect(S.parseBookTitle('Alice in Wonderland.pdf').title).toBe('Alice in Wonderland');
    expect(S.parseBookTitle('Pride and Prejudice.txt').title).toBe('Pride and Prejudice');
    expect(S.parseBookTitle('book').title).toBe('book');
  });

  it('多个来源站后缀整块剥掉', () => {
    const r = S.parseBookTitle('Number the Stars (Lois Lowry) (z-library.sk, 1lib.sk, z-lib.sk)');
    expect(r.title).toBe('Number the Stars');
    expect(r.author).toBe('Lois Lowry');
  });

  it('无括号/无作者 → 保留原串, author null', () => {
    const r = S.parseBookTitle('The Old Man and the Sea');
    expect(r.title).toBe('The Old Man and the Sea');
    expect(r.author).toBeNull();
  });

  it('括号内容像站名 → 不当作作者 (保留但不算作者)', () => {
    // 只有站名括号: 全剥
    const r = S.parseBookTitle('Some Book (z-lib.org)');
    expect(r.author).toBeNull();
    expect(r.title).toBe('Some Book');
  });

  it('作者串含数字/逗号 → 不猜, 保留原样', () => {
    const r = S.parseBookTitle('Book Title (Volume 2)');
    expect(r.author).toBeNull();
    expect(r.title).toContain('Book Title');
  });

  it('空输入 → 空', () => {
    expect(S.parseBookTitle('').title).toBe('');
    expect(S.parseBookTitle(null).title).toBe('');
  });

  it('无扩展名已知后缀不误剥', () => {
    expect(S.parseBookTitle('moby').title).toBe('moby');
  });
});
