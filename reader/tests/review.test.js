import { describe, it, expect, beforeAll } from 'vitest';

let S;

beforeAll(async () => {
  await import('../core/review.js');
  S = globalThis.AiduReviewCore;
});

const NOW = 1_000_000_000_000;
const MIN = 60000;
const DAY = 86400000; // 字面量 (S 在 beforeAll 后才可用)

function card(stage, extra) {
  return Object.assign({ stage, next_review: null, interval_ms: 0, lemma: 'x' }, extra || {});
}

describe('AiduReviewCore.newWordQuota (三项已定 ②)', () => {
  it('负债轻 → 满额', () => {
    expect(S.newWordQuota(0)).toBe(6);
    expect(S.newWordQuota(10)).toBe(6);
    expect(S.newWordQuota(20)).toBe(6); // 舒适线内
  });

  it('负债超舒适线 → 收缩', () => {
    // 30 到期: 6 - (30-20)/2 = 1
    expect(S.newWordQuota(30)).toBe(1);
    // 40 到期: 6 - 10 = -4 → clamp 0
    expect(S.newWordQuota(40)).toBe(0);
  });

  it('可选 base/comfort 可调 (kid 默认 3)', () => {
    expect(S.newWordQuota(0, { base: 3 })).toBe(3);
    expect(S.newWordQuota(40, { base: 3, comfort: 10 })).toBe(0);
  });
});

describe('AiduReviewCore.classify', () => {
  it('new 无 next_review → new; 未来 → new_future', () => {
    expect(S.classify(card('new'), NOW)).toBe('new');
    expect(S.classify(card('new', { next_review: NOW + DAY }), NOW)).toBe('new_future');
  });

  it('learning 分钟级(未毕业) → learning_due/future; 毕业(≥1天) → review', () => {
    expect(S.classify(card('learning', { interval_ms: 10 * MIN, next_review: NOW - 1 }), NOW)).toBe('learning_due');
    expect(S.classify(card('learning', { interval_ms: 10 * MIN, next_review: NOW + 1 }), NOW)).toBe('learning_future');
    expect(S.classify(card('learning', { interval_ms: DAY, next_review: NOW - 1 }), NOW)).toBe('review_due');
    expect(S.classify(card('learning', { interval_ms: DAY, next_review: NOW + 1 }), NOW)).toBe('review_future');
  });

  it('review/mastered', () => {
    expect(S.classify(card('review', { next_review: NOW - 1 }), NOW)).toBe('review_due');
    expect(S.classify(card('review', { next_review: NOW + 1 }), NOW)).toBe('review_future');
    expect(S.classify(card('mastered'), NOW)).toBe('mastered');
  });
});

describe('AiduReviewCore.buildQueue (顺序: 到期→学习→新词)', () => {
  const dueR = card('review', { next_review: NOW - 1, lemma: 'r1' });
  const futureR = card('review', { next_review: NOW + DAY, lemma: 'r2' });
  const learn = card('learning', { interval_ms: 10 * MIN, next_review: NOW - 1, lemma: 'l1' });
  const mastered = card('mastered', { lemma: 'm1' });
  const news = Array.from({ length: 8 }, (_, i) => card('new', { lemma: 'n' + i }));

  it('队列顺序与配额', () => {
    const q = S.buildQueue([news[0], futureR, dueR, learn, mastered, ...news.slice(1)], NOW);
    const keys = q.order.map((e) => e.lemma);
    expect(keys[0]).toBe('r1');           // 到期复习在最前
    expect(keys[1]).toBe('l1');           // 学习中插队第二
    expect(q.order.length).toBe(1 + 1 + 6); // 复习1 + 学习1 + 新词配额6
    expect(keys.includes('r2')).toBe(false); // 未到期复习不进队列
    expect(keys.includes('m1')).toBe(false); // 已掌握不进队列
  });

  it('到期多 → 新词配额收缩 (负债收缩)', () => {
    const dues = Array.from({ length: 30 }, (_, i) => card('review', { next_review: NOW - 1, lemma: 'd' + i }));
    const q = S.buildQueue([...dues, ...news], NOW);
    expect(q.newQuota).toBe(1); // 30 到期 → 6-5=1
    expect(q.order.length).toBe(30 + 1);
  });

  it('到期再多 → 新词归零, 复习仍全量', () => {
    const dues = Array.from({ length: 50 }, (_, i) => card('review', { next_review: NOW - 1, lemma: 'd' + i }));
    const q = S.buildQueue([...dues, ...news], NOW);
    expect(q.newQuota).toBe(0);
    expect(q.dueCount).toBe(50);
  });
});

describe('AiduReviewCore.estimateSeconds', () => {
  it('无实测 → 15 秒/张', () => {
    expect(S.estimateSeconds(10, null)).toBe(150);
    expect(S.estimateSeconds(10, 0)).toBe(150);
  });
  it('有实测中位 → 用它', () => {
    expect(S.estimateSeconds(10, 5000)).toBe(50);
  });
});

describe('AiduReviewCore.UndoStack (3 秒可撤销)', () => {
  it('窗口内可撤销, 超窗不可', () => {
    const st = new S.UndoStack();
    st.push({ lemma: 'bank' }, NOW);
    expect(st.canUndo(NOW + 1000)).toBe(true);
    expect(st.canUndo(NOW + 3000)).toBe(true); // 边界含
    expect(st.canUndo(NOW + 3001)).toBe(false); // 超窗
    expect(st.undo(NOW + 1000)).toEqual({ lemma: 'bank' });
  });

  it('空栈不可撤销', () => {
    const st = new S.UndoStack();
    expect(st.canUndo(NOW)).toBe(false);
    expect(st.undo(NOW)).toBe(null);
  });

  it('撤销后栈清空; clear 清栈', () => {
    const st = new S.UndoStack();
    st.push({ a: 1 }, NOW);
    st.clear();
    expect(st.length).toBe(0);
    expect(st.canUndo(NOW)).toBe(false);
  });
});

describe('AiduReviewCore.keyAction (SPACE/1-4/S/E)', () => {
  it('桌面键盘映射', () => {
    expect(S.keyAction({ key: ' ' })).toBe('flip');
    expect(S.keyAction({ key: '1' })).toBe('grade1');
    expect(S.keyAction({ key: '4' })).toBe('grade4');
    expect(S.keyAction({ key: 's' })).toBe('skip');
    expect(S.keyAction({ key: 'E' })).toBe('edit');
    expect(S.keyAction({ key: 'q' })).toBe(null);
    expect(S.keyAction(null)).toBe(null);
  });
});

describe('AiduReviewCore.FlipLock (翻面单向 + 250ms 锁)', () => {
  it('翻面后未过锁不可评分', () => {
    const fl = new S.FlipLock();
    expect(fl.isFlipped()).toBe(false);
    expect(fl.canGrade(NOW)).toBe(false);
    fl.flip(NOW);
    expect(fl.isFlipped()).toBe(true);
    expect(fl.canGrade(NOW + 100)).toBe(false); // 250ms 内
    expect(fl.canGrade(NOW + 250)).toBe(true);  // 边界可
    expect(fl.canGrade(NOW + 500)).toBe(true);
  });

  it('进入下一张重置翻面态', () => {
    const fl = new S.FlipLock();
    fl.flip(NOW);
    fl.next();
    expect(fl.isFlipped()).toBe(false);
    expect(fl.canGrade(NOW)).toBe(false);
  });
});
