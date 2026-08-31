"""
core/word_alignment.py —— TTS 词时间轴 → segments 下标对齐 (纯函数, 无 I/O)

背景 (审查确认, 2026-08-04): Kokoro 分词与 spaCy segments 不一致:
- Kokoro 一个 token "daisy-chain" ↔ spaCy 三个 segment ["daisy", "-", "chain"]
- Kokoro "I've" ↔ spaCy ["I", "'ve"] (或合体)
- 旧实现精确逐词匹配, 一旦失败就 break, 后续全部丢失 (倒数第二句半句无高亮)

2026-08-31 重写 (用户报"跟读错位", 实测追因): 上面那次修复把 break 改成 continue,
但**指针 si 原地不动** —— 之后每个正常 token 都拿去和卡住的那个位置比, 必然全败,
结果是"该句从失配处起所有词丢失时间轴"。恢复路径只有一条"跳过标点", 其余情况无解。

实测触发的是缩写和连字符复合词, **不是拟声词**(狗叫台词实测 9/9 全覆盖、能量包络逐格吻合):
  ch18 #0  `'s`                     → 后续 24 个词全丢
  ch7  #42 `little-miss-know-it-all` → 19 个词全丢
  ch5  #30 `n't`                    → 1 个词
Winn-Dixie 14 例, The Giver 17 例。

其中 ch7 那例的机制在代码上可直接验证: spaCy 把 little-miss-know-it-all 切成 **9 个**
segment (little/-/miss/-/know/-/it/-/all), 而旧 MAX_SPAN=6 —— 拼接最多试到 6 个,
**永远拼不出这个词**, 必然失配、必然卡死。

三条修复:
1. MAX_SPAN 6 → 12: 直接覆盖多段连字符复合词 (代价只是每 token 多几次字符串拼接)。
2. **前视窗口重同步**: 失配时在有限窗口内往后找能落脚的位置, 而不是原地卡死。
   原来那条"跳过标点"是它的特例, 已并入。
3. **锚点间空洞插值**: 两个成功锚点之间没能对上的 segment, 按字符数比例分摊中间的时间。

保证: 单调、不冻结、失配影响被限制在局部。**不保证**拟声词内部的精确位置 —— 那种
东西本来就对不准, 假装能对准才是问题。

诚实边界: **只插值"两个锚点之间"的内部空洞**, 头尾空洞仍照旧上报 uncovered。
尾部缺失通常意味着 Kokoro 真的没念那个词, 硬填等于伪造时间轴。

反误锚: 短 token ("a"/"it"/"to") 在窗口里很容易假匹配到后面某个同形词, 一旦锚错,
后面全跟着错位, 比不匹配更糟。所以短 token 只允许原地匹配(跳过标点除外)。
"""
from __future__ import annotations

import unicodedata
from typing import Protocol


class SegmentLike(Protocol):
    word: str
    pos: str


class WordTimingLike(Protocol):
    seg_idx: int
    start_ms: int
    end_ms: int


# 非"词"的标点: 这些 segment 缺失时间轴不视为对齐失败
NON_WORD_PUNCT = set(".,!?;:…()[]{}“”‘’\"'")

# 一个 TTS token 最多能对应几个连续 segment。
# 6 → 12 (2026-08-31): little-miss-know-it-all 就是 9 个 segment, 旧上限永远拼不出来。
MAX_SPAN = 12

# 失配时往后找落脚点的窗口 (segment 个数)。够跨过一两个对不上的词, 又不至于跳太远。
RESYNC_WINDOW = 4

# 允许"跳着找落脚点"的最短 token 长度。短词满仓都是, 跳着找几乎必然锚错。
MIN_RESYNC_TOKEN_LEN = 3


def normalize_word(s: str) -> str:
    """归一化用于匹配: 小写、Unicode 撇号/连字符 → ASCII、去空白。"""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("`", "'").replace("‘", "'")
    s = s.replace("–", "-").replace("—", "-").replace("‐", "-").replace("‑", "-")
    return s.strip().lower()


def _is_punct_like(word: str) -> bool:
    w = word.strip()
    return all(c in NON_WORD_PUNCT for c in w) if w else True


# spaCy 把缩写切成"词根 + 附着成分": wasn't → [was, n't], Earth's → [Earth, 's]。
# 这些附着成分**从不单独发音** —— Kokoro 要么把整个词吐成一个 token, 要么根本不吐它们。
# 所以它们和标点一样可以安全跳过, 不算"锚错风险"。
# 实测正是这类东西挡住了指针: ch18 #0 的 `'s` 后面丢了 24 个词, ch5 #30 的 `n't`。
CLITIC_PREFIXES = ("'", "n'")


def _is_skippable(word: str) -> bool:
    """跳过它不会造成误锚的 segment: 纯标点, 或缩写的附着成分。"""
    if _is_punct_like(word):
        return True
    return normalize_word(word).startswith(CLITIC_PREFIXES)


def _split_range(start_ms: int, end_ms: int, weights: list[int]) -> list[tuple[int, int]]:
    """按字符数比例把 [start_ms, end_ms) 切分给 weights 对应的多个 segment。"""
    total = sum(weights)
    if total <= 0:
        step = (end_ms - start_ms) / max(len(weights), 1)
        out = []
        acc = start_ms
        for _ in weights:
            out.append((int(acc), int(acc + step)))
            acc += step
        return out
    dur = end_ms - start_ms
    out = []
    acc = 0.0
    for i, w in enumerate(weights):
        new_acc = acc + w
        s = start_ms + int(dur * acc / total)
        e = start_ms + int(dur * new_acc / total)
        if i == len(weights) - 1:
            e = end_ms
        out.append((s, e))
        acc = new_acc
    return out


def _make_timing(seg_idx: int, s: int, e: int):
    # 避免依赖具体 dataclass, 返回 dict 由调用方转 WordTiming
    return {"seg_idx": seg_idx, "start_ms": s, "end_ms": e}


def _find_match(norm_segs, segments, si: int, tok: str) -> tuple[int, int] | None:
    """从 si 起找 tok 的落脚点。返回 (起始 segment 下标, 跨几个 segment), 找不到返回 None。

    扫描起点 si, si+1, … si+RESYNC_WINDOW; 每个起点再试拼接 1..MAX_SPAN 个 segment。
    起点 > si (即跳过了一些 segment) 只在两种情况下允许:
      - 跳过的全是"可安全跳过"的 (标点 / 缩写附着成分, 见 _is_skippable)
      - 或 tok 足够长 (短词跳着找几乎必然锚错, 见模块头注释)
    """
    n = len(segments)
    long_enough = len(tok) >= MIN_RESYNC_TOKEN_LEN
    for start in range(si, min(si + RESYNC_WINDOW, n - 1) + 1):
        if start > si:
            all_skippable = all(_is_skippable(segments[k].word) for k in range(si, start))
            if not (all_skippable or long_enough):
                break
        for k in range(1, min(MAX_SPAN, n - start) + 1):
            if "".join(norm_segs[start:start + k]) == tok:
                return start, k
    return None


def _assign(result: list, norm_segs, start: int, k: int, s0: int, e0: int) -> None:
    """把 [s0, e0) 按字符数比例分给 start..start+k-1 这几个 segment"""
    weights = [max(len(norm_segs[start + j]), 1) for j in range(k)]
    for j, (s, e) in enumerate(_split_range(s0, e0, weights)):
        result.append(_make_timing(start + j, s, e))


def _interpolate_gaps(ordered: list, norm_segs, segments) -> list[int]:
    """给两个锚点之间没对上的 segment 补时间轴 (按字符数比例分摊)。

    只补**内部**空洞: 头尾空洞没有可依赖的另一端锚点, 而且尾部缺失往往是 Kokoro 真的
    没念那个词, 硬填等于伪造时间轴。
    返回被插值的 segment 下标 (供质量指标统计, 不能让 100% 覆盖率把问题藏起来)。
    """
    filled: list[int] = []
    for a, b in zip(list(ordered), list(ordered)[1:]):
        lo, hi = a["seg_idx"], b["seg_idx"]
        if hi - lo <= 1:
            continue
        span_ms = b["start_ms"] - a["end_ms"]
        if span_ms <= 0:
            continue  # 两个锚点首尾相接, 中间没有可分的时间 —— 不编造
        # 只补**非标点**: 标点本来就常常没有时间轴 (Kokoro 不吐标点), 给它补一个
        # 既无意义又会改变既有行为 —— check_segment_coverage 从来不把标点算作缺失。
        idxs = [i for i in range(lo + 1, hi) if not _is_punct_like(segments[i].word)]
        if not idxs:
            continue
        weights = [max(len(norm_segs[i]), 1) for i in idxs]
        for i, (s, e) in zip(idxs, _split_range(a["end_ms"], b["start_ms"], weights)):
            ordered.append(_make_timing(i, s, e))
            filled.append(i)
    if filled:
        ordered.sort(key=lambda x: x["seg_idx"])
    return filled


def align_tts_words_to_segments(
    timings: list[dict],
    segments: list[SegmentLike],
) -> tuple[list[dict], list[int], list[int]]:
    """把 TTS 词时间轴映射到 segments 下标。

    timings: [{"word": str, "start_ms": int, "end_ms": int}, ...] (句内相对 ms)
    segments: spaCy 生成的 [Segment(word, pos, lemma), ...]

    返回:
      word_timings:  [{seg_idx, start_ms, end_ms}] 按 seg_idx 升序
      uncovered:     仍然没有时间轴的**非标点** segment 下标 (对齐失败证据)
      interpolated:  靠插值补出来的**非标点** segment 下标 (近似值, 要单独计入质量指标)

    算法见模块头注释。核心是: 失配不再让指针卡死, 而是在有限窗口里重新落脚;
    剩下的内部空洞按字符比例插值。
    """
    norm_segs = [normalize_word(seg.word) for seg in segments]
    result: list[dict] = []
    si = 0

    for tm in timings:
        tok = normalize_word(tm.get("word", ""))
        if not tok:
            continue
        s0, e0 = tm.get("start_ms", 0), tm.get("end_ms", 0)
        if e0 <= s0:
            e0 = s0 + 1
        hit = _find_match(norm_segs, segments, si, tok)
        if hit is None:
            continue  # 这个 token 真对不上 —— 跳过它, 但**指针不动**, 后面的 token 照常尝试
        start, k = hit
        _assign(result, norm_segs, start, k, s0, e0)
        si = start + k

    # 按 seg_idx 排序去重 (同一 segment 被两个 token 命中时保留第一个)
    seen: set[int] = set()
    ordered: list[dict] = []
    for t in sorted(result, key=lambda x: x["seg_idx"]):
        if t["seg_idx"] not in seen:
            seen.add(t["seg_idx"])
            ordered.append(t)

    interpolated = _interpolate_gaps(ordered, norm_segs, segments)

    covered = set(t["seg_idx"] for t in ordered)
    uncovered = [
        i for i, seg in enumerate(segments)
        if i not in covered and not _is_punct_like(seg.word)
    ]
    return ordered, uncovered, interpolated
