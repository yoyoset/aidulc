/**
 * core.js —— 手机 Web 端纯逻辑 (V7, 2026-08-09)
 * 零 DOM / 零 IndexedDB / 零 fetch, node 可直跑测试。
 * 与桌面端同一套算法:
 *   - SRS 调度器 = domain/srs.rs 的 JS 移植 (按钮预览 == 评分后实际到期)
 *   - 每日配比 = 三项已定 ② (到期复习不封顶 / 新词负债收缩 / 学习中插队)
 *   - 撤销栈 3 秒 / 翻面单向 / 评分锁
 */
'use strict';

const MINUTE_1 = 60_000;
const MINUTE_10 = 600_000;
const DAY_1 = 86_400_000;
const DAY_3 = 3 * DAY_1;
const DAY_8 = 8 * DAY_1;
const EASE_MIN = 1.3;
const EASE_MAX = 5.0;
const DEFAULT_BASE = 6;
const DEFAULT_COMFORT = 20;
const DEFAULT_PER_CARD_MS = 15000;
const GRADE_LOCK_MS = 250;
const UNDO_WINDOW_MS = 3000;

function clampEase(e) {
  return Math.max(EASE_MIN, Math.min(EASE_MAX, e));
}

/** 新词额度 = clamp(基础值 - max(0, 到期数-舒适线)/2, 0, 基础值) */
function newWordQuota(dueCount, opts) {
  const base = (opts && opts.base != null) ? opts.base : DEFAULT_BASE;
  const comfort = (opts && opts.comfort != null) ? opts.comfort : DEFAULT_COMFORT;
  const raw = base - Math.max(0, dueCount - comfort) / 2;
  return Math.max(0, Math.min(base, Math.round(raw)));
}

function classify(e, now) {
  const stage = e.stage || 'new';
  if (stage === 'mastered') return 'mastered';
  if (stage === 'new') {
    return (e.next_review == null || e.next_review <= now) ? 'new' : 'new_future';
  }
  if (stage === 'learning') {
    const graduated = (e.interval_ms || 0) >= DAY_1;
    if (graduated) return (e.next_review == null || e.next_review <= now) ? 'review_due' : 'review_future';
    return (e.next_review == null || e.next_review <= now) ? 'learning_due' : 'learning_future';
  }
  return (e.next_review == null || e.next_review <= now) ? 'review_due' : 'review_future';
}

/** 建今日队列 (与桌面 core/review.js 同规则) */
function buildQueue(entries, now, opts) {
  const groups = { new: [], learning_due: [], review_due: [], mastered: [], future: [] };
  (entries || []).forEach((e) => {
    const c = classify(e, now);
    if (groups[c] != null) groups[c].push(e);
    else groups.future.push(e);
  });
  const quota = newWordQuota(groups.review_due.length, opts);
  const newWords = groups.new.slice(0, quota);
  const order = [...groups.review_due, ...groups.learning_due, ...newWords];
  return {
    order,
    newQuota: quota,
    newTotal: groups.new.length,
    dueCount: groups.review_due.length,
    learningCount: groups.learning_due.length,
    counts: {
      new: newWords.length,
      newTotal: groups.new.length,
      learning: groups.learning_due.length,
      review: groups.review_due.length,
      mastered: groups.mastered.length,
    },
  };
}

/** 评分 1-4 → 新状态 (JS 移植 domain/srs.rs::apply_grade, 保证两端一致) */
function applyGrade(s, grade, now) {
  let ease = s.ease_factor;
  let intervalMs;
  let stage;
  const g = Number(grade);
  const key = s.stage || 'new';
  if (key === 'new' || key === 'learning' || key === 'mastered') {
    const t = { 1: [MINUTE_1, 'learning'], 2: [MINUTE_10, 'learning'], 3: [DAY_3, 'review'], 4: [DAY_8, 'review'] }[g];
    intervalMs = t[0]; stage = t[1];
  } else if (key === 'review') {
    if (g === 1) { ease -= 0.20; intervalMs = MINUTE_1; stage = 'learning'; }
    else if (g === 2) { ease -= 0.15; intervalMs = Math.max(s.interval_ms || 0, MINUTE_10) * 1.2; stage = 'review'; }
    else if (g === 3) { intervalMs = Math.max((s.interval_ms || 0) * ease, DAY_1); stage = 'review'; }
    else { ease += 0.15; intervalMs = Math.max(s.interval_ms || 0, MINUTE_10) * ease * 1.3; stage = 'review'; }
  } else {
    const t = { 1: [MINUTE_1, 'learning'], 2: [MINUTE_10, 'learning'], 3: [DAY_3, 'review'], 4: [DAY_8, 'review'] }[g];
    intervalMs = t[0]; stage = t[1];
  }
  return {
    stage,
    interval_ms: Math.round(intervalMs),
    ease_factor: clampEase(ease),
    reviews: (s.reviews || 0) + 1,
    next_review: now + Math.round(intervalMs),
    last_review: now,
    last_grade: g,
  };
}

/** 四档按钮预览 (== 对应评分后的实际到期) */
function intervalOptions(s, now) {
  const labels = ['忘了', '模糊', '记得', '太简单'];
  return [1, 2, 3, 4].map((g) => {
    const o = applyGrade(s, g, now);
    return { grade: g, label: labels[g - 1], human: humanDuration(o.interval_ms), delta_ms: o.interval_ms, next_review: o.next_review };
  });
}

function humanDuration(ms) {
  if (ms < 60_000) return Math.floor(ms / 1000) + ' 秒';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分钟';
  if (ms < DAY_1) return Math.floor(ms / 3_600_000) + ' 小时';
  return Math.floor(ms / DAY_1) + ' 天';
}

function estimateSeconds(cardCount, medianMs) {
  const per = (medianMs != null && medianMs > 0) ? medianMs : DEFAULT_PER_CARD_MS;
  return Math.round(((cardCount || 0) * per) / 1000);
}

/** 撤销栈 (3 秒窗口) */
class UndoStack {
  constructor(windowMs) {
    this.windowMs = windowMs != null ? windowMs : UNDO_WINDOW_MS;
    this.items = [];
  }
  push(item, now) { this.items.push({ item, at: now }); }
  canUndo(now) { const top = this.items[this.items.length - 1]; return !!top && (now - top.at) <= this.windowMs; }
  undo(now) { if (!this.canUndo(now)) return null; return this.items.pop().item; }
  clear() { this.items = []; }
  get length() { return this.items.length; }
}

/** 翻面锁 (单向 + 250ms 评分锁) */
class FlipLock {
  constructor(lockMs) {
    this.lockMs = lockMs != null ? lockMs : GRADE_LOCK_MS;
    this.flipped = false;
    this.flipAt = 0;
  }
  flip(now) { this.flipped = true; this.flipAt = now; }
  isFlipped() { return this.flipped; }
  canGrade(now) { return this.flipped && (now - this.flipAt) >= this.lockMs; }
  next() { this.flipped = false; this.flipAt = 0; }
}

/** 评分结果 → 完整词条 (写回 IndexedDB / 待推队列用) */
function applyOutcome(entry, o) {
  return Object.assign({}, entry, {
    stage: o.stage,
    interval_ms: o.interval_ms,
    ease_factor: o.ease_factor,
    reviews: o.reviews,
    next_review: o.next_review,
    last_review: o.last_review,
    last_grade: o.last_grade,
    updated_at: o.last_review,
  });
}

const MobileCore = {
  MINUTE_1, MINUTE_10, DAY_1, DAY_3, DAY_8,
  newWordQuota, classify, buildQueue, applyGrade, intervalOptions,
  humanDuration, estimateSeconds, UndoStack, FlipLock, applyOutcome,
  GRADE_LOCK_MS, UNDO_WINDOW_MS, DEFAULT_PER_CARD_MS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = MobileCore;
if (typeof window !== 'undefined') window.MobileCore = MobileCore;
