import { describe, it, expect, beforeAll } from 'vitest';

let N;

beforeAll(async () => {
  await import('../core/notify.js');
  N = globalThis.AiduNotify;
});

const fakeStorage = (v) => ({ getItem: () => v, setItem(_k, x) { this.v = x; } });

describe('AiduNotify', () => {
  it('偏好缺省为开, 只有显式存 0 才关', () => {
    expect(N.isEnabled(fakeStorage(null))).toBe(true);
    expect(N.isEnabled(fakeStorage('1'))).toBe(true);
    expect(N.isEnabled(fakeStorage('0'))).toBe(false);
  });

  it('读 localStorage 抛错时当作开 (不因存储坏了丢通知)', () => {
    expect(N.isEnabled({ getItem() { throw new Error('blocked'); } })).toBe(true);
  });

  it('setEnabled 写 0/1', () => {
    const s = fakeStorage(null);
    N.setEnabled(false, s);
    expect(s.v).toBe('0');
    N.setEnabled(true, s);
    expect(s.v).toBe('1');
  });

  it('窗口在前台不发 (页内 toast 已够); 关了/没授权也不发', () => {
    const base = { enabled: true, focused: false, permission: 'granted' };
    expect(N.shouldNotify(base)).toBe(true);
    expect(N.shouldNotify({ ...base, focused: true })).toBe(false);
    expect(N.shouldNotify({ ...base, enabled: false })).toBe(false);
    expect(N.shouldNotify({ ...base, permission: 'denied' })).toBe(false);
    expect(N.shouldNotify({ ...base, permission: 'default' })).toBe(false);
  });

  it('文案区分 成功/部分失败/失败, 书名取文件名', () => {
    const done = N.buildMessage({ id: 'j1', book_path: 'D:\\books\\Emma.epub', status: 'done' });
    expect(done.body).toContain('《Emma.epub》');
    expect(done.title).toBe('处理完成');
    expect(N.buildMessage({ book_path: '/a/b.epub', status: 'failed' }).title).toBe('处理失败');
    expect(N.buildMessage({ book_path: '/a/b.epub', status: 'partial' }).title).toContain('部分');
  });

  it('没有书路径时退回任务 id, 坏输入不抛', () => {
    expect(N.buildMessage({ id: 'job-9', book_path: '', status: 'done' }).body).toContain('job-9');
    expect(() => N.buildMessage(null)).not.toThrow();
  });

  it('没有 Notification API 时 notifyJob 返回 false 不抛', () => {
    const saved = globalThis.Notification;
    delete globalThis.Notification;
    expect(N.notifyJob({ status: 'done' })).toBe(false);
    if (saved) globalThis.Notification = saved;
  });
});
