/**
 * cover_cache.test.js —— 封面加载策略的纯逻辑部分
 *
 * 背景实测数字见 core/cover_cache.js 头注释: 11 张封面 10.95 MB, 最大一张
 * 1742x2284 / 8.95 MB, 每次进"我的书"整份 base64 过 IPC 且无缓存。
 */
import { describe, it, expect, beforeAll } from 'vitest';

let C;
beforeAll(async () => {
  globalThis.window = globalThis;
  await import('../core/cover_cache.js');
  C = globalThis.AiduCoverCache;
});

describe('thumbSize —— 只缩真的偏大的图', () => {
  it('宽超过上限时等比缩', () => {
    // 库里最大的那张 (Because of Winn-Dixie)
    expect(C.thumbSize(1742, 2284)).toEqual({ w: 480, h: 629 });
  });

  it('宽不超过上限就不缩 (省一次 canvas 编码)', () => {
    expect(C.thumbSize(327, 494)).toBeNull();   // Frindle, 32KB
    expect(C.thumbSize(480, 720)).toBeNull();   // 正好等于上限
  });

  it('尺寸拿不到时不缩, 不能瞎猜', () => {
    expect(C.thumbSize(0, 0)).toBeNull();
    expect(C.thumbSize(undefined, undefined)).toBeNull();
  });

  it('极端长条图也保持等比且高度至少 1px', () => {
    const s = C.thumbSize(4800, 3);
    expect(s.w).toBe(480);
    expect(s.h).toBeGreaterThanOrEqual(1);
  });
});

describe('decodedBytes —— 不解码就估出原图大小', () => {
  it('按 base64 的 3/4 规则算, 处理补位', () => {
    // "AAAA" -> 3 字节; "AAA=" -> 2; "AA==" -> 1
    expect(C.decodedBytes('AAAA')).toBe(3);
    expect(C.decodedBytes('AAA=')).toBe(2);
    expect(C.decodedBytes('AA==')).toBe(1);
    expect(C.decodedBytes('')).toBe(0);
    expect(C.decodedBytes(null)).toBe(0);
  });

  it('小图不触发缩略图, 大图触发', () => {
    const small = 'A'.repeat(Math.ceil((40 * 1024) * 4 / 3));   // ~40KB
    const big = 'A'.repeat(Math.ceil((900 * 1024) * 4 / 3));    // ~900KB
    expect(C.decodedBytes(small) >= C.THUMB_SKIP_BELOW_BYTES).toBe(false);
    expect(C.decodedBytes(big) >= C.THUMB_SKIP_BELOW_BYTES).toBe(true);
  });
});

describe('mimeOf', () => {
  it('按扩展名给 mime, 未知回落 jpeg', () => {
    expect(C.mimeOf('cover.png')).toBe('image/png');
    expect(C.mimeOf('cover.JPEG')).toBe('image/jpeg');
    expect(C.mimeOf('cover.webp')).toBe('image/webp');
    expect(C.mimeOf('cover.bin')).toBe('image/jpeg');
  });
});

describe('缓存键', () => {
  it('按 packDir + 文件名区分, 不同书不串图', () => {
    expect(C.key('E:/a', 'cover.jpg')).not.toBe(C.key('E:/b', 'cover.jpg'));
    expect(C.key('E:/a', 'cover.jpg')).toBe(C.key('E:/a', 'cover.jpg'));
  });

  it('get/put/has 一致', () => {
    expect(C.has('E:/x', 'c.jpg')).toBe(false);
    C.put('E:/x', 'c.jpg', 'blob:fake');
    expect(C.has('E:/x', 'c.jpg')).toBe(true);
    expect(C.get('E:/x', 'c.jpg')).toBe('blob:fake');
  });

  it('同一张图并发请求只发一次 (inflight 去重)', () => {
    const p = Promise.resolve('x');
    expect(C.pending('E:/y', 'c.jpg')).toBeNull();
    C.setPending('E:/y', 'c.jpg', p);
    expect(C.pending('E:/y', 'c.jpg')).toBe(p);
    C.clearPending('E:/y', 'c.jpg');
    expect(C.pending('E:/y', 'c.jpg')).toBeNull();
  });
});
