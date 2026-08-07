"""
core/word_alignment.py —— TTS 词时间轴 → segments 下标对齐 (纯函数, 无 I/O)

背景 (审查确认, 2026-08-04): Kokoro 分词与 spaCy segments 不一致:
- Kokoro 一个 token "daisy-chain" ↔ spaCy 三个 segment ["daisy", "-", "chain"]
- Kokoro "I've" ↔ spaCy ["I", "'ve"] (或合体)
- 旧实现精确逐词匹配, 一旦失败就 break, 后续全部丢失 (倒数第二句半句无高亮)

本模块解决: 双指针顺序贪心, token 可与 1..N 个连续 segment 拼接匹配,
命中后按字符数比例切分时间区间。返回 (word_timings, uncovered_seg_indices)。
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


def normalize_word(s: str) -> str:
    """归一化用于匹配: 小写、Unicode 撇号/连字符 → ASCII、去空白。"""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("`", "'").replace("‘", "'")
    s = s.replace("–", "-").replace("—", "-").replace("‐", "-").replace("‑", "-")
    return s.strip().lower()


def _is_punct_like(word: str) -> bool:
    w = word.strip()
    return all(c in NON_WORD_PUNCT for c in w) if w else True


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


def align_tts_words_to_segments(
    timings: list[dict],
    segments: list[SegmentLike],
) -> tuple[list[dict], list[int]]:
    """把 TTS 词时间轴映射到 segments 下标。

    timings: [{"word": str, "start_ms": int, "end_ms": int}, ...] (句内相对 ms)
    segments: spaCy 生成的 [Segment(word, pos, lemma), ...]

    返回:
      word_timings: [{seg_idx, start_ms, end_ms}] 按 seg_idx 升序
      uncovered_seg_indices: 没有时间轴的**非标点** segment 下标 (对齐失败证据)

    规则:
    - 顺序贪心, token 与 1..MAX_SPAN 个连续 segment 拼接匹配
    - 命中后按字符数比例切分时间
    - token 匹配失败: 跳过该 token (继续后续), 不终止
    - 纯标点 segment 缺失时间轴不算失败
    """
    MAX_SPAN = 6

    norm_segs = [normalize_word(seg.word) for seg in segments]
    result: list[dict] = []
    si = 0  # segment 指针
    n = len(segments)

    for tm in timings:
        tok = normalize_word(tm.get("word", ""))
        if not tok:
            continue
        s0, e0 = tm.get("start_ms", 0), tm.get("end_ms", 0)
        if e0 <= s0:
            e0 = s0 + 1

        matched = False
        # 尝试 1..MAX_SPAN 个连续 segment 拼接
        for k in range(1, min(MAX_SPAN, n - si) + 1):
            joined = "".join(norm_segs[si:si + k])
            if joined == tok:
                weights = [max(len(norm_segs[si + j]), 1) for j in range(k)]
                ranges = _split_range(s0, e0, weights)
                for j in range(k):
                    seg_idx = si + j
                    s, e = ranges[j]
                    result.append(_make_timing(seg_idx, s, e))
                si += k
                matched = True
                break

        if matched:
            continue

        # 未匹配: 若当前 segment 是纯标点, 先跳过再试一次 (Kokoro 可能不吐标点)
        if si < n and _is_punct_like(segments[si].word):
            while si < n and _is_punct_like(segments[si].word):
                si += 1
            for k in range(1, min(MAX_SPAN, n - si) + 1):
                joined = "".join(norm_segs[si:si + k])
                if joined == tok:
                    weights = [max(len(norm_segs[si + j]), 1) for j in range(k)]
                    ranges = _split_range(s0, e0, weights)
                    for j in range(k):
                        seg_idx = si + j
                        s, e = ranges[j]
                        result.append(_make_timing(seg_idx, s, e))
                    si += k
                    matched = True
                    break
        # 仍未匹配: 跳过该 token, 不终止

    # 按 seg_idx 排序去重 (同一 segment 被两个 token 命中时保留第一个)
    seen: set[int] = set()
    ordered: list[dict] = []
    for t in sorted(result, key=lambda x: x["seg_idx"]):
        if t["seg_idx"] not in seen:
            seen.add(t["seg_idx"])
            ordered.append(t)

    # 未覆盖的非标点 segment
    covered = set(t["seg_idx"] for t in ordered)
    uncovered = [
        i for i, seg in enumerate(segments)
        if i not in covered and not _is_punct_like(seg.word)
    ]
    return ordered, uncovered
