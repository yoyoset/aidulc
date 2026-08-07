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
        out, uncovered = align_tts_words_to_segments(
            [tm("The", 0, 200), tm("quick", 200, 400), tm("fox", 400, 700)],
            segs("The", "quick", "fox"),
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2]
        assert uncovered == []

    def test_case_insensitive(self):
        out, uncovered = align_tts_words_to_segments(
            [tm("THE", 0, 200), tm("Quick", 200, 400)],
            segs("The", "quick"),
        )
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_punct_segment_between_words(self):
        """Kokoro 不给逗号时间 → 逗号段不算 uncovered, 且后续词仍能对齐"""
        segments = [Segment("Hello", "NOUN", "hello"), Segment(",", "PUNCT", ","),
                    Segment("world", "NOUN", "world")]
        out, uncovered = align_tts_words_to_segments(
            [tm("Hello", 0, 300), tm("world", 350, 700)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 2]
        assert uncovered == []

    def test_trailing_punct(self):
        segments = [Segment("Stop", "VERB", "stop"), Segment(".", "PUNCT", ".")]
        out, uncovered = align_tts_words_to_segments([tm("Stop", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == []


class TestAlignHyphen:
    def test_daisy_chain_three_segments(self):
        """审查确认的根因: Kokoro 'daisy-chain' ↔ spaCy daisy / - / chain"""
        segments = [Segment("daisy", "NOUN", "daisy"), Segment("-", "PUNCT", "-"),
                    Segment("chain", "NOUN", "chain")]
        out, uncovered = align_tts_words_to_segments([tm("daisy-chain", 300, 700)], segments)
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
        out, uncovered = align_tts_words_to_segments(
            [tm("a", 0, 100), tm("daisy-chain", 100, 500), tm("swings", 500, 800)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2, 3, 4]
        assert uncovered == []

    def test_contraction_ive(self):
        segments = [Segment("I", "PRON", "i"), Segment("'ve", "PART", "'ve")]
        out, uncovered = align_tts_words_to_segments([tm("I've", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_possessive_earths(self):
        segments = [Segment("Earth", "NOUN", "earth"), Segment("'s", "PART", "'s")]
        out, uncovered = align_tts_words_to_segments([tm("Earth's", 0, 400)], segments)
        assert [t["seg_idx"] for t in out] == [0, 1]
        assert uncovered == []

    def test_unified_token_earths(self):
        """spaCy 也可能给合体 Earth's; Kokoro 也吐 Earth's → 单段直接匹配"""
        segments = [Segment("Earth's", "NOUN", "earth")]
        out, uncovered = align_tts_words_to_segments([tm("Earth’s", 0, 400)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == []


class TestAlignRepeated:
    def test_repeated_word_in_order(self):
        """审查确认: 第二句两个 it 必须按顺序各归各 (不能都跳到后一个)"""
        segments = [Segment("but", "CONJ", "but"), Segment("it", "PRON", "it"),
                    Segment("in", "PREP", "in"), Segment("it", "PRON", "it")]
        out, uncovered = align_tts_words_to_segments(
            [tm("but", 0, 200), tm("it", 200, 350), tm("in", 350, 500), tm("it", 500, 650)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2, 3]
        assert uncovered == []

    def test_repeated_word_when_tts_merges(self):
        """'it was it' 类: 中间词合并时按顺序贪心不跳"""
        segments = [Segment("it", "PRON", "it"), Segment("was", "VERB", "be"),
                    Segment("it", "PRON", "it")]
        out, uncovered = align_tts_words_to_segments(
            [tm("it", 0, 200), tm("was", 200, 400), tm("it", 400, 600)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1, 2]


class TestAlignUncovered:
    def test_unmatched_word_reports_uncovered(self):
        segments = [Segment("Hello", "NOUN", "hello"), Segment("world", "NOUN", "world")]
        out, uncovered = align_tts_words_to_segments([tm("Hello", 0, 300)], segments)
        assert [t["seg_idx"] for t in out] == [0]
        assert uncovered == [1], "world 没有时间轴必须上报"

    def test_token_skipped_does_not_kill_rest(self):
        """一个 token 完全匹配不上 → 跳过该 token, 后续仍继续 (旧实现 break 的修复)"""
        segments = [Segment("alpha", "NOUN", "alpha"), Segment("beta", "NOUN", "beta")]
        out, uncovered = align_tts_words_to_segments(
            [tm("???", 0, 100), tm("alpha", 100, 300), tm("beta", 300, 500)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1]

    def test_empty_timings(self):
        out, uncovered = align_tts_words_to_segments([], segs("a", "b"))
        assert out == []
        assert uncovered == [0, 1]

    def test_overlap_keeps_first(self):
        """两个 token 命中同一 segment → 保留第一个 (按 seg_idx 排序去重)"""
        segments = [Segment("a", "NOUN", "a"), Segment("b", "NOUN", "b")]
        out, uncovered = align_tts_words_to_segments(
            [tm("a", 0, 100), tm("b", 50, 200)],
            segments,
        )
        assert [t["seg_idx"] for t in out] == [0, 1]
