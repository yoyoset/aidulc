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
});
