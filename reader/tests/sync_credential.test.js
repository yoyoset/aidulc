import { describe, it, expect, beforeAll } from 'vitest';

let C;

beforeAll(async () => {
  await import('../core/sync_credential.js');
  C = globalThis.AiduSyncCredential;
});

describe('AiduSyncCredential', () => {
  it('6 位纯数字是邀请码, 其它非空是 ROOT_SECRET, 空就是空', () => {
    expect(C.credentialKind('123456')).toBe('code');
    expect(C.credentialKind(' 123456 ')).toBe('code');
    expect(C.credentialKind('12345')).toBe('secret'); // 5 位不是邀请码
    expect(C.credentialKind('1234567')).toBe('secret');
    expect(C.credentialKind('abc123')).toBe('secret');
    expect(C.credentialKind('')).toBe('empty');
    expect(C.credentialKind(null)).toBe('empty');
  });

  it('地址: 空/缺协议/缺域名各给不同提示, 合法返回空串', () => {
    expect(C.urlProblem('')).toContain('先填');
    expect(C.urlProblem('sync.viiyd.com')).toContain('https://');
    expect(C.urlProblem('https://')).toContain('不完整');
    expect(C.urlProblem('https://sync.viiyd.com')).toBe('');
    expect(C.urlProblem('https://aidulc-sync.x.workers.dev/')).toBe('');
    expect(C.urlProblem('http://localhost:8787')).toBe('');
  });

  it('提示: 先指出地址问题, 地址对了再说凭据', () => {
    expect(C.connectHint('', '123456')).toContain('先填同步地址');
    const empty = C.connectHint('https://sync.viiyd.com', '');
    expect(empty).toContain('ROOT_SECRET');
    expect(empty).toContain('6 位码');
    expect(C.connectHint('https://sync.viiyd.com', '123456')).toContain('邀请码');
    expect(C.connectHint('https://sync.viiyd.com', 'my-secret')).toContain('ROOT_SECRET');
  });

  it('canConnect: 地址和凭据都有效才能点', () => {
    expect(C.canConnect('https://a.b.com', 'x')).toBe(true);
    expect(C.canConnect('https://a.b.com', '')).toBe(false);
    expect(C.canConnect('', 'x')).toBe(false);
  });

  it('authArgs: 邀请码和密钥互斥, 地址去空白', () => {
    expect(C.authArgs(' https://a.b.com ', '123456')).toEqual({ workerUrl: 'https://a.b.com', rootSecret: null, code: '123456' });
    expect(C.authArgs('https://a.b.com', 'sec')).toEqual({ workerUrl: 'https://a.b.com', rootSecret: 'sec', code: null });
  });

  it('配对链接: 拆出令牌和地址 (地址是百分号编码的), 不是链接/缺字段一律 null', () => {
    const link = 'https://aidulc-mobile.pages.dev/#t=abc123def456&u=https%3A%2F%2Fsync.example.com';
    expect(C.parsePairLink(link)).toEqual({ token: 'abc123def456', url: 'https://sync.example.com' });
    expect(C.parsePairLink(' ' + link + ' ')).not.toBeNull();
    expect(C.parsePairLink('https://x.com/#t=only-token')).toBeNull(); // 缺 u
    expect(C.parsePairLink('https://x.com/#u=https%3A%2F%2Fa.b.com')).toBeNull(); // 缺 t
    expect(C.parsePairLink('https://x.com/no-fragment')).toBeNull();
    expect(C.parsePairLink('abc123def456')).toBeNull(); // 裸令牌不猜 (和 ROOT_SECRET 分不开)
    expect(C.parsePairLink('https://x.com/#t=a&u=%E0%A4%A')).toBeNull(); // 坏编码
  });

  it('粘贴链接: 识别为 link, 不要求先填地址, 提示说明和手机共用令牌, 参数带 token', () => {
    const link = 'https://m.pages.dev/#t=tok999&u=https%3A%2F%2Fsync.example.com%2F';
    expect(C.credentialKind(link)).toBe('link');
    expect(C.canConnect('', link)).toBe(true);
    expect(C.connectHint('', link)).toContain('共用同一个令牌');
    expect(C.authArgs('', link)).toEqual({ workerUrl: 'https://sync.example.com', rootSecret: null, code: null, token: 'tok999' });
  });
});
