"""P0 回归测试: 词级时间轴对齐 (审查确认的 daisy-chain / it 错位问题)"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.models import Segment
from aidulc_prep.core.word_alignment import align_tts_words_to_segments, normalize_word


def segs(*words):
    return [Segment(word=w, pos="NOUN", lemma=w.lower()) for w in words]


def tm(word, s, e):
    return {"word": word, "start_ms": s, "end_ms": e}


class TestNormalize:
    def test_lowercase_and_strip(self):
        assert normalize_word("  Hello ") == "hello"

    def test_unicode_apostrophe(self):
        assert normalize_word("I’ve") == "i've"
        assert normalize_word("Earth’s") == "earth's"

    def test_unicode_dash(self):
        assert normalize_word("daisy–chain") == "daisy-chain"
        assert normalize_word("long—tail") == "long-tail"


class TestAlignBasic:
    def test_simple_sequence(self):
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("The", 0, 200), tm("quick", 200, 400), tm("fox", 400, 700)],
            segs("The", "quick", "fox"),
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2]
        assert uncovered == []

    def test_case_insensitive(self):
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("THE", 0, 200), tm("Quick", 200, 400)],
            segs("The", "quick"),
        )
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_punct_segment_between_words(self):
        """Kokoro 不给逗号时间 → 逗号段不算 uncovered, 且后续词仍能对齐"""
        segments = [Segment("Hello", "NOUN", "hello"), Segment(",", "PUNCT", ","),
                    Segment("world", "NOUN", "world")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("Hello", 0, 300), tm("world", 350, 700)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 2]
        assert uncovered == []

    def test_trailing_punct(self):
        segments = [Segment("Stop", "VERB", "stop"), Segment(".", "PUNCT", ".")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("Stop", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == []


class TestAlignHyphen:
    def test_daisy_chain_three_segments(self):
        """审查确认的根因: Kokoro 'daisy-chain' ↔ spaCy daisy / - / chain"""
        segments = [Segment("daisy", "NOUN", "daisy"), Segment("-", "PUNCT", "-"),
                    Segment("chain", "NOUN", "chain")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("daisy-chain", 300, 700)], segments)
        assert [t["seg_idx"] for t in out] == [0, 1, 2]
        assert uncovered == []
        # 时间按字符数 5:1:5 切分, 且单调递增
        assert out[0]["start_ms"] == 300
        assert out[0]["end_ms"] <= out[1]["start_ms"] + 1
        assert out[1]["end_ms"] <= out[2]["start_ms"] + 1
        assert out[2]["end_ms"] == 700

    def test_hyphen_then_more_words(self):
        """daisy-chain 之后还有词, 不能 break (旧实现 bug)"""
        segments = [Segment("a", "DET", "a"), Segment("daisy", "NOUN", "daisy"),
                    Segment("-", "PUNCT", "-"), Segment("chain", "NOUN", "chain"),
                    Segment("swings", "VERB", "swing")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("a", 0, 100), tm("daisy-chain", 100, 500), tm("swings", 500, 800)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2, 3, 4]
        assert uncovered == []

    def test_contraction_ive(self):
        segments = [Segment("I", "PRON", "i"), Segment("'ve", "PART", "'ve")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("I've", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_possessive_earths(self):
        segments = [Segment("Earth", "NOUN", "earth"), Segment("'s", "PART", "'s")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("Earth's", 0, 400)], segments)
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_unified_token_earths(self):
        """spaCy 也可能给合体 Earth's; Kokoro 也吐 Earth's → 单段直接匹配"""
        segments = [Segment("Earth's", "NOUN", "earth")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("Earth’s", 0, 400)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == []


class TestAlignRepeated:
    def test_repeated_word_in_order(self):
        """审查确认: 第二句两个 it 必须按顺序各归各 (不能都跳到后一个)"""
        segments = [Segment("but", "CONJ", "but"), Segment("it", "PRON", "it"),
                    Segment("in", "PREP", "in"), Segment("it", "PRON", "it")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("but", 0, 200), tm("it", 200, 350), tm("in", 350, 500), tm("it", 500, 650)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2, 3]
        assert uncovered == []

    def test_repeated_word_when_tts_merges(self):
        """'it was it' 类: 中间词合并时按顺序贪心不跳"""
        segments = [Segment("it", "PRON", "it"), Segment("was", "VERB", "be"),
                    Segment("it", "PRON", "it")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("it", 0, 200), tm("was", 200, 400), tm("it", 400, 600)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2]


class TestAlignUncovered:
    def test_unmatched_word_reports_uncovered(self):
        segments = [Segment("Hello", "NOUN", "hello"), Segment("world", "NOUN", "world")]
        out, uncovered, _interp = align_tts_words_to_segments([tm("Hello", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == [1], "world 没有时间轴必须上报"

    def test_token_skipped_does_not_kill_rest(self):
        """一个 token 完全匹配不上 → 跳过该 token, 后续仍继续 (旧实现 break 的修复)"""
        segments = [Segment("alpha", "NOUN", "alpha"), Segment("beta", "NOUN", "beta")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("???", 0, 100), tm("alpha", 100, 300), tm("beta", 300, 500)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1]

    def test_empty_timings(self):
        out, uncovered, _interp = align_tts_words_to_segments([], segs("a", "b"))
        assert out == []
        assert uncovered == [0, 1]

    def test_overlap_keeps_first(self):
        """两个 token 命中同一 segment → 保留第一个 (按 seg_idx 排序去重)"""
        segments = [Segment("a", "NOUN", "a"), Segment("b", "NOUN", "b")]
        out, uncovered, _interp = align_tts_words_to_segments(
            [tm("a", 0, 100), tm("b", 50, 200)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1]


class TestResyncAgainstRealFailures:
    """2026-08-31: 用户报"跟读错位", 实测抓到的真实失配串。

    共同症状是**级联**: 一个 token 对不上 → 指针原地卡死 → 之后每个正常 token 都拿去
    和卡住的位置比、必然全败 → 整句从失配处起全丢时间轴。
    Winn-Dixie 14 例, The Giver 17 例。

    注意: 拟声词(狗叫台词)实测是**好的** —— 9/9 全覆盖、能量包络逐格吻合, 不是本类问题。
    """

    def test_long_hyphenated_compound_spans_nine_segments(self):
        """ch7 #42 `little-miss-know-it-all`: spaCy 切成 9 个 segment, 而旧 MAX_SPAN=6,
        拼接最多试到 6 个 —— **永远拼不出这个词**, 必然失配。这是代码上可直接验证的机制,
        不是猜测。MAX_SPAN 提到 12 后应当精确命中, 不需要退化到插值。"""
        parts = ["little", "-", "miss", "-", "know", "-", "it", "-", "all"]
        segments = [Segment(w, "PUNCT" if w == "-" else "NOUN", w) for w in parts]
        assert len(segments) == 9, "前提: 这个复合词就是 9 个 segment"
        out, uncovered, interp = align_tts_words_to_segments(
            [tm("little-miss-know-it-all", 0, 900)], segments)
        assert [t["seg_idx"] for t in out] == list(range(9))
        assert uncovered == []
        assert interp == [], "应当精确命中, 不该退化成插值"

    def test_compound_failure_does_not_kill_the_rest_of_the_sentence(self):
        """核心回归: 复合词后面还有 10 个词, 一个都不能丢 (旧实现从这里起全丢)。"""
        parts = ["little", "-", "miss", "-", "know", "-", "it", "-", "all"]
        tail = ["librarian", "was", "what", "he", "was", "and", "she", "knew", "it", "well"]
        segments = ([Segment(w, "PUNCT" if w == "-" else "NOUN", w) for w in parts]
                    + [Segment(w, "NOUN", w) for w in tail])
        timings = [tm("little-miss-know-it-all", 0, 900)]
        t0 = 900
        for w in tail:
            timings.append(tm(w, t0, t0 + 150))
            t0 += 150
        out, uncovered, _i = align_tts_words_to_segments(timings, segments)
        assert uncovered == [], f"复合词之后不得再有丢失, 实得 {uncovered}"
        assert len(out) == len(segments)

    def test_unmatchable_token_at_head_does_not_kill_the_rest(self):
        """ch18 #0 `'s` 型: 句首附近一个 segment 没有对应 token, 后面 10 个词必须照常对齐。
        (真实数据里那一句从 `'s` 起丢了 24 个词。)"""
        tail = ["I", "told", "her", "I", "had", "two", "surprises", "for", "her", "today"]
        segments = [Segment("'s", "PART", "'s")] + [Segment(w, "NOUN", w) for w in tail]
        timings = []
        t0 = 100
        for w in tail:
            timings.append(tm(w, t0, t0 + 120))
            t0 += 120
        out, uncovered, _i = align_tts_words_to_segments(timings, segments)
        covered = [t["seg_idx"] for t in out]
        for k in range(1, len(segments)):
            assert k in covered, f"segment {k} ({segments[k].word}) 不该丢"

    def test_interior_gap_is_interpolated_and_reported(self):
        """对不上的词夹在两个锚点之间 → 插值补上, 且**必须**出现在 interpolated 里。
        插值让覆盖率恒为 100%, 不单独上报等于把对齐质量下降藏起来。"""
        segments = segs("alpha", "weird", "beta")
        out, uncovered, interp = align_tts_words_to_segments(
            [tm("alpha", 0, 200), tm("beta", 600, 800)], segments)
        assert uncovered == [], "内部空洞应被插值填上"
        assert interp == [1], "插值的词必须单独上报"
        mid = [t for t in out if t["seg_idx"] == 1][0]
        assert 200 <= mid["start_ms"] and mid["end_ms"] <= 600

    def test_timeline_stays_monotonic_after_interpolation(self):
        # 名字要够长: 短词按设计不允许重同步 (见 test_short_token_does_not_resync)
        segments = segs("alpha", "gapword", "gaptwo", "bravo")
        out, _u, interp = align_tts_words_to_segments(
            [tm("alpha", 0, 100), tm("bravo", 700, 900)], segments)
        assert interp == [1, 2]
        starts = [t["start_ms"] for t in out]
        ends = [t["end_ms"] for t in out]
        assert starts == sorted(starts), f"起点必须单调: {starts}"
        for s, e in zip(starts, ends):
            assert e >= s

    def test_tail_gap_is_not_fabricated(self):
        """诚实边界: 尾部没有后续锚点, 通常意味着 Kokoro 真的没念那个词 ——
        照旧上报 uncovered, 不硬填。"""
        out, uncovered, interp = align_tts_words_to_segments(
            [tm("hello", 0, 300)], segs("hello", "world"))
        assert uncovered == [1]
        assert interp == []

    def test_short_token_does_not_resync_and_misanchor(self):
        """反误锚: 短词满仓都是, 允许它跳着找落脚点几乎必然锚错, 而锚错比不匹配更糟
        (后面全跟着错位)。这里 'a' 不该跳过 'xylophone' 去认后面那个 'a'。"""
        out, _u, _i = align_tts_words_to_segments(
            [tm("a", 0, 100), tm("xylophone", 100, 500), tm("a", 500, 600),
             tm("trumpet", 600, 900)],
            segs("xylophone", "a", "trumpet"))
        assert [t["seg_idx"] for t in out] == [0, 1, 2]
        first = [t for t in out if t["seg_idx"] == 0][0]
        assert first["start_ms"] == 100, "xylophone 必须拿到自己那段时间, 不能被 'a' 抢锚"

    def test_long_token_may_resync_over_an_unspoken_word(self):
        """反过来: 足够长的 token 允许跳过中间没念的词重新落脚, 否则就又卡死了。"""
        out, uncovered, _i = align_tts_words_to_segments(
            [tm("alpha", 0, 200), tm("bravocharlie", 600, 900)],
            segs("alpha", "unspoken", "bravocharlie"))
        covered = [t["seg_idx"] for t in out]
        assert 0 in covered and 2 in covered, "重同步必须能跨过没念的词"
