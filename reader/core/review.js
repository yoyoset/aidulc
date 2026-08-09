/**
 * core/review.js —— 背单词桌面三栏 (V3) 纯逻辑: 队列/每日配比/撤销栈/键盘映射/翻面锁
 * 零 DOM, 可配 window=globalThis shim 单测 (reader/tests/review.test.js)。
 *
 * 三项已定 ② 的配比规则 (给规则不给数字):
 * - 到期复习不封顶 (债不能拖)
 * - 新词有上限且随负债收缩: 额度 = clamp(基础值 - max(0, 到期数-舒适线)/2, 0, 基础值)
 * - 学习中(分钟级步长未毕业的卡)不占配额, 到点即插队
 * - 顺序: 到期复习 → 学习中插队 → 新词
 * - 预计用时: 有实测中位耗时用它, 无则 15 秒/张 (不写死)
 *
 * 设计稿 01b (桌面 §02):
 * - SPACE 翻面 / 1-4 评分 / S 跳过 / E 编辑
 * - 翻面单向不可逆; 评分区翻面后 250ms 才可点 (防连击)
 * - 评分后 3 秒可撤销 (撤销栈)
 */
(function (global) {
  'use strict';

  const DAY_MS = 86400000;
  const DEFAULT_BASE = 6;      // 新词基础值
  const DEFAULT_COMFORT = 20;  // 舒适线
  const DEFAULT_PER_CARD_MS = 15000; // 无实测时预计每卡耗时
  const GRADE_LOCK_MS = 250;   // 翻面后评分区解锁延迟
  const UNDO_WINDOW_MS = 3000; // 评分后可撤销窗口

  /** 新词额度 = clamp(基础值 - max(0, 到期数-舒适线)/2, 0, 基础值) */
  function newWordQuota(dueCount, opts) {
    const base = (opts && opts.base != null) ? opts.base : DEFAULT_BASE;
    const comfort = (opts && opts.comfort != null) ? opts.comfort : DEFAULT_COMFORT;
    const raw = base - Math.max(0, dueCount - comfort) / 2;
    return Math.max(0, Math.min(base, Math.round(raw)));
  }

  /**
   * 词条归类 (纯函数)。
   * 返回: new | new_future | learning_due | learning_future | review_due | review_future | mastered
   * - 学习中"分钟级步长未毕业" = interval_ms < DAY; 毕业的当复习算
   */
  function classify(e, now) {
    const stage = e.stage || 'new';
    if (stage === 'mastered') return 'mastered';
    if (stage === 'new') {
      return (e.next_review == null || e.next_review <= now) ? 'new' : 'new_future';
    }
    if (stage === 'learning') {
      const graduated = (e.interval_ms || 0) >= DAY_MS;
      if (graduated) return (e.next_review == null || e.next_review <= now) ? 'review_due' : 'review_future';
      return (e.next_review == null || e.next_review <= now) ? 'learning_due' : 'learning_future';
    }
    // review 及其余
    return (e.next_review == null || e.next_review <= now) ? 'review_due' : 'review_future';
  }

  /**
   * 建今日队列: 到期复习(不封顶) → 学习中插队 → 新词(配额)。
   * 返回 { order, newQuota, newTotal, dueCount, learningCount, counts }
   */
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

  /** 预计用时 (秒): 有实测中位耗时用它, 无则 15 秒/张 */
  function estimateSeconds(cardCount, medianMs) {
    const per = (medianMs != null && medianMs > 0) ? medianMs : DEFAULT_PER_CARD_MS;
    return Math.round(((cardCount || 0) * per) / 1000);
  }

  /** 撤销栈 (评分后可撤销, 3 秒窗口) */
  class UndoStack {
    constructor(windowMs) {
      this.windowMs = windowMs != null ? windowMs : UNDO_WINDOW_MS;
      this.items = [];
    }
    push(item, now) {
      this.items.push({ item, at: now });
    }
    /** 最近一次是否还在可撤销窗口内 */
    canUndo(now) {
      const top = this.items[this.items.length - 1];
      return !!top && (now - top.at) <= this.windowMs;
    }
    /** 撤销最近一次评分 (超窗返回 null) */
    undo(now) {
      if (!this.canUndo(now)) return null;
      return this.items.pop().item;
    }
    clear() { this.items = []; }
    get length() { return this.items.length; }
  }

  /** 键盘映射 (桌面 §02: SPACE/1-4/S/E) */
  const KEYMAP = {
    ' ': 'flip',
    '1': 'grade1',
    '2': 'grade2',
    '3': 'grade3',
    '4': 'grade4',
    's': 'skip',
    'S': 'skip',
    'e': 'edit',
    'E': 'edit',
  };

  /** 键盘事件 → 动作 (翻面/评分/跳过/编辑); 不可识别返回 null */
  function keyAction(event) {
    return KEYMAP[event && event.key] || null;
  }

  /**
   * 翻面锁: 翻面单向不可逆; 评分区翻面后 250ms 才可点。
   * 纯状态机: flip(now) 置为已翻面; canGrade(now) 检查锁定与已翻面。
   */
  class FlipLock {
    constructor(lockMs) {
      this.lockMs = lockMs != null ? lockMs : GRADE_LOCK_MS;
      this.flipped = false;
      this.flipAt = 0;
    }
    /** 翻面 (单向: 不可翻回) */
    flip(now) {
      this.flipped = true;
      this.flipAt = now;
    }
    /** 是否已翻面 (背面可见) */
    isFlipped() { return this.flipped; }
    /** 评分区是否可点: 已翻面且过了锁定延迟 */
    canGrade(now) {
      return this.flipped && (now - this.flipAt) >= this.lockMs;
    }
    /** 进入下一张: 重置翻面态 (翻面本身单向, 每张卡独立) */
    next() {
      this.flipped = false;
      this.flipAt = 0;
    }
  }

  global.AiduReviewCore = {
    newWordQuota,
    classify,
    buildQueue,
    estimateSeconds,
    UndoStack,
    keyAction,
    KEYMAP,
    FlipLock,
    DAY_MS,
    GRADE_LOCK_MS,
    UNDO_WINDOW_MS,
    DEFAULT_PER_CARD_MS,
  };
})(window);
