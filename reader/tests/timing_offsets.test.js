// timing_offsets.js —— 跟读时间轴人工校准纯逻辑
// 用例里的数字来自 2026-08-31 对 Because of Winn-Dixie 的真实测量(见 memory/pipeline.md):
// ch007 在句 50 处一次性跳变 -9500ms; ch005 不是阶跃而是从句 34 起持续累积到 -3.9s
// (2026-09-01 用 silencedetect 逐句复测更正, 见 core/timing_offsets.js 文件头)。
import { describe, it, expect, beforeAll } from 'vitest';

let T;

beforeAll(async () => {
  await import('../core/timing_offsets.js');
  T = globalThis.AiduTimingOffsets;
});

// 造 n 句、每句 dur ms、首尾相接的时间轴
function mkSentences(n, dur = 2000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ audio: { start_ms: i * dur, end_ms: (i + 1) * dur }, words: [] });
  }
  return out;
}

describe('offsetAt', () => {
  it('无锚点恒为 0', () => {
    expect(T.offsetAt([], 0)).toBe(0);
    expect(T.offsetAt(null, 99)).toBe(0);
  });

  it('取最后一条 from <= i 的锚点(绝对值语义, 不累加)', () => {
    const a = [{ from: 10, offset: -300 }, { from: 44, offset: -4150 }];
    expect(T.offsetAt(a, 0)).toBe(0);
    expect(T.offsetAt(a, 9)).toBe(0);
    expect(T.offsetAt(a, 10)).toBe(-300);
    expect(T.offsetAt(a, 43)).toBe(-300);
    expect(T.offsetAt(a, 44)).toBe(-4150);
    expect(T.offsetAt(a, 900)).toBe(-4150); // 不是 -4450, 绝对值不叠加
  });
});

describe('normalize', () => {
  it('排序 + 丢掉与继承值相同的冗余锚点', () => {
    const got = T.normalize([
      { from: 44, offset: -4150 },
      { from: 10, offset: -300 },
      { from: 60, offset: -4150 }, // 与前一条等值 = 冗余
    ]);
    expect(got).toEqual([{ from: 10, offset: -300 }, { from: 44, offset: -4150 }]);
  });

  it('丢掉非法项', () => {
    expect(T.normalize([{ from: -1, offset: 5 }, { from: 3 }, null, { from: 2, offset: -100 }]))
      .toEqual([{ from: 2, offset: -100 }]);
  });
});

describe('nudge —— 防"点一次长一条"的无限成长', () => {
  it('同一句反复微调只留一条锚点', () => {
    let a = [];
    for (let k = 0; k < 20; k++) a = T.nudge(a, 44, -100);
    expect(a).toEqual([{ from: 44, offset: -2000 }]);
  });

  it('调回 0 时锚点被删除, 不留一条 offset=0 的空行', () => {
    let a = T.nudge([], 44, -500);
    expect(a).toHaveLength(1);
    a = T.nudge(a, 44, 500);
    expect(a).toEqual([]);
  });

  it('调成与继承值相同时锚点被剪掉', () => {
    let a = [{ from: 10, offset: -300 }];
    a = T.nudge(a, 44, -300); // 44 继承 -300, 再 -300 → -600, 应保留
    expect(a).toHaveLength(2);
    a = T.nudge(a, 44, 300); // 回到 -300 = 继承值 → 冗余, 剪掉
    expect(a).toEqual([{ from: 10, offset: -300 }]);
  });

  it('不修改入参', () => {
    const orig = [{ from: 10, offset: -300 }];
    const copy = JSON.parse(JSON.stringify(orig));
    T.nudge(orig, 44, -1000);
    expect(orig).toEqual(copy);
  });
});

describe('applyToSentences', () => {
  it('只平移锚点之后的句子, 之前的原样不动', () => {
    const s = mkSentences(6);
    T.applyToSentences(s, [{ from: 3, offset: 1000 }]);
    expect(s[0].audio.start_ms).toBe(0);
    expect(s[2].audio.start_ms).toBe(4000);
    expect(s[3].audio.start_ms).toBe(7000); // 6000 + 1000
    expect(s[5].audio.start_ms).toBe(11000);
  });

  it('大负偏移不得破坏二分查找要求的单调性(核心回归)', () => {
    // 实测场景: 句长 2s, 却要在句 3 处平移 -4150ms —— 朴素实现会让句 3 跑到句 2 前面
    const s = mkSentences(8, 2000);
    T.applyToSentences(s, [{ from: 3, offset: -4150 }]);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].audio.start_ms).toBeGreaterThanOrEqual(s[i - 1].audio.start_ms);
      expect(s[i].audio.end_ms).toBeGreaterThanOrEqual(s[i].audio.start_ms);
    }
  });

  it('平移后不出现负时间', () => {
    const s = mkSentences(4, 1000);
    T.applyToSentences(s, [{ from: 0, offset: -99999 }]);
    s.forEach((x) => expect(x.audio.start_ms).toBeGreaterThanOrEqual(0));
  });

  it('无锚点时不改动任何句子的时间(内部快照字段不算改动)', () => {
    const s = mkSentences(5);
    const before = s.map((x) => [x.audio.start_ms, x.audio.end_ms]);
    expect(T.applyToSentences(s, [])).toBe(0);
    expect(s.map((x) => [x.audio.start_ms, x.audio.end_ms])).toEqual(before);
  });

  it('幂等: 同样的锚点应用多次结果不变(不重复叠加)', () => {
    const s = mkSentences(6);
    T.applyToSentences(s, [{ from: 3, offset: 1000 }]);
    const once = s.map((x) => x.audio.start_ms);
    T.applyToSentences(s, [{ from: 3, offset: 1000 }]);
    T.applyToSentences(s, [{ from: 3, offset: 1000 }]);
    expect(s.map((x) => x.audio.start_ms)).toEqual(once);
  });

  it('实时微调: 改锚点后重算基于原始值, 不受上一次钳位污染', () => {
    const s = mkSentences(8, 2000);
    T.applyToSentences(s, [{ from: 3, offset: -4150 }]); // 触发钳位
    T.applyToSentences(s, [{ from: 3, offset: 0 }]);     // 调回去
    expect(s.map((x) => x.audio.start_ms)).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000, 14000]);
  });

  it('复位到空锚点应完全还原原始时间轴', () => {
    const s = mkSentences(6);
    const before = s.map((x) => x.audio.start_ms);
    T.applyToSentences(s, [{ from: 2, offset: 3000 }]);
    T.applyToSentences(s, []);
    expect(s.map((x) => x.audio.start_ms)).toEqual(before);
  });

  it('跳过没有 audio 的句子而不崩', () => {
    const s = mkSentences(3);
    s[1].audio = null;
    expect(() => T.applyToSentences(s, [{ from: 0, offset: 500 }])).not.toThrow();
    expect(s[0].audio.start_ms).toBe(500);
  });
});

describe('alignDelta —— 「我听到的其实是另一句」', () => {
  it('增量 = 两句起点之差 (把听到的那句搬到高亮现在所在的位置)', () => {
    const s = mkSentences(50, 2000);
    // 高亮停在句 40 (起点 80000), 用户指认此刻念的是句 42 (起点 84000)
    expect(T.alignDelta(s, 42, 40)).toBe(-4000);
    expect(T.alignDelta(s, 40, 42)).toBe(4000);
    expect(T.alignDelta(s, 40, 40)).toBe(0);
  });

  // 接缝处的诚实边界: 负增量大于句间隔时, 目标句自己会被单调性修复钳回去
  // (它不能跑到前一句前面)。往后几句钳制解除, 平移量就完整生效了 —— 这正是
  // 实际观感: 校准点那一两句略糙, 之后整段对上。
  it('负增量在接缝处被钳, 但往后几句拿到完整平移量', () => {
    const s = mkSentences(50, 2000);
    const baseLater = s[46].audio.start_ms;
    T.applyToSentences(s, T.nudge([], 42, T.alignDelta(s, 42, 40)));
    expect(s[42].audio.start_ms).toBe(s[41].audio.start_ms); // 被钳到前一句起点
    expect(s[46].audio.start_ms).toBe(baseLater - 4000);     // 已完整生效
  });

  it('句子不存在时返回 0 而不是抛错', () => {
    expect(T.alignDelta(mkSentences(2), 99, 0)).toBe(0);
    expect(T.alignDelta(mkSentences(2), 0, 99)).toBe(0);
    expect(T.alignDelta(null, 0, 1)).toBe(0);
  });
});

describe('formatOffset / describeOffset', () => {
  it('原始数值显示', () => {
    expect(T.formatOffset(0)).toBe('无偏移');
    expect(T.formatOffset(-4150)).toBe('-4.15s');
    expect(T.formatOffset(1000)).toBe('+1.00s');
  });

  it('观感显示: 负偏移 = 高亮提前 (面板里给人看的是这一个)', () => {
    expect(T.describeOffset(0)).toBe('未校准');
    expect(T.describeOffset(-4150)).toBe('高亮提前 4.15s');
    expect(T.describeOffset(1000)).toBe('高亮延后 1.00s');
  });
});

describe('repairMonotonic —— 区间不得重叠', () => {
  it('向下接缝处上一句的 end 被压回到下一句的 start', () => {
    // 实测复现 (ch005 库里残留的废锚点): 句 54 被顶到 +4146, 句 55 起被拉回 -4832,
    // 只修 start 的话句 54 的区间会盖住后面 9 秒, findSentenceIndex 二分前提失效。
    const s = mkSentences(60, 2000);
    T.applyToSentences(s, [{ from: 54, offset: 4146 }, { from: 55, offset: -4832 }]);
    for (let i = 1; i < s.length; i++) {
      expect(s[i - 1].audio.end_ms).toBeLessThanOrEqual(s[i].audio.start_ms);
      expect(s[i - 1].audio.start_ms).toBeLessThanOrEqual(s[i].audio.start_ms);
    }
  });

  it('干净时间轴上是空操作', () => {
    const s = mkSentences(10, 2000);
    T.applyToSentences(s, []);
    s.forEach((x, i) => {
      expect(x.audio.start_ms).toBe(i * 2000);
      expect(x.audio.end_ms).toBe((i + 1) * 2000);
    });
  });
});
