"""P0 回归测试: nlp 多句不丢句 / align 覆盖率 / 静音占位时间轴连续 / checkpoint hydrate"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.models import Chapter, Sentence, Segment, SentenceAudio, WordTiming
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.pipeline.align import check_segment_coverage, validate_timeline
from aidulc_prep.pipeline.tts.stage import _map_timings_to_segments

nlp = None


def _get_nlp():
    global nlp
    if nlp is None:
        import spacy
        nlp = spacy.load("en_core_web_sm")
    return nlp


class TestNlpMultiSentence:
    def test_paragraph_with_multiple_sentences_not_dropped(self):
        """审查确认: 旧实现只取 doc.sents 第一句, 同段后续句子全丢"""
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[
            Sentence(original_text="Alice was tired. She fell asleep. Then she woke up!"),
        ])
        process_chapter_nlp(ch, _get_nlp())
        assert len(ch.sentences) == 3, f"段落 3 句应产生 3 个 Sentence, 实得 {len(ch.sentences)}"
        assert ch.sentences[0].original_text.startswith("Alice was tired")
        assert ch.sentences[1].original_text.startswith("She fell asleep")
        assert ch.sentences[2].original_text.startswith("Then she woke up")
        # 每句都有 segments
        for s in ch.sentences:
            assert len(s.segments) > 0

    def test_single_sentence_paragraph(self):
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[
            Sentence(original_text="The rabbit ran away."),
        ])
        process_chapter_nlp(ch, _get_nlp())
        assert len(ch.sentences) == 1

    def test_whitespace_sentence_failed(self):
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[Sentence(original_text="   ")])
        process_chapter_nlp(ch, _get_nlp())
        assert ch.sentences[0].status == "failed"
        assert "nlp" in ch.sentences[0].failed_stages


class TestCoverage:
    def test_full_coverage_empty_missing(self):
        segments = [Segment("a", "NOUN", "a"), Segment("b", "NOUN", "b"), Segment(".", "PUNCT", ".")]
        words = [WordTiming(seg_idx=0, start_ms=0, end_ms=100),
                 WordTiming(seg_idx=1, start_ms=100, end_ms=200)]
        assert check_segment_coverage(segments, words) == []

    def test_missing_word_reported(self):
        segments = [Segment("a", "NOUN", "a"), Segment("b", "NOUN", "b")]
        words = [WordTiming(seg_idx=0, start_ms=0, end_ms=100)]
        assert check_segment_coverage(segments, words) == [1]

    def test_punct_never_counts_as_missing(self):
        segments = [Segment("a", "NOUN", "a"), Segment(",", "PUNCT", ","), Segment("b", "NOUN", "b")]
        words = [WordTiming(seg_idx=0, start_ms=0, end_ms=100)]
        assert check_segment_coverage(segments, words) == [2]

    def test_silent_placeholder_sentence_without_words_is_partial_not_fake_ok(self):
        """失败句静音占位: 无 words 但整句已标记 failed, 覆盖率检查不该把失败句当 ok"""
        segments = [Segment("a", "NOUN", "a")]
        s = Sentence(original_text="a", segments=segments)
        s.mark_failed("tts")
        words = []
        assert check_segment_coverage(segments, words) == [0]  # 数据上确实没覆盖
        assert s.status == "partial"  # 但句子状态不是 ok


class TestTimelineValidation:
    def test_relative_timeline_ok(self):
        """词时间轴是句内相对, 校验基准是句长"""
        words = [WordTiming(seg_idx=0, start_ms=0, end_ms=300),
                 WordTiming(seg_idx=1, start_ms=300, end_ms=700)]
        assert validate_timeline(words, 5000, 5700) == []

    def test_relative_timeline_overrun(self):
        words = [WordTiming(seg_idx=0, start_ms=0, end_ms=300),
                 WordTiming(seg_idx=1, start_ms=300, end_ms=1000)]
        problems = validate_timeline(words, 5000, 5700)  # 句长 700
        assert any("超出句长" in p for p in problems)


class TestMapTimings:
    def test_daisy_chain_no_tail_loss(self):
        """P0 核心: daisy-chain 之后不能丢词"""
        segments = [Segment("a", "DET", "a"), Segment("daisy", "NOUN", "daisy"),
                    Segment("-", "PUNCT", "-"), Segment("chain", "NOUN", "chain"),
                    Segment("swings", "VERB", "swing")]
        timings = [{"word": "a", "start_ms": 0, "end_ms": 100},
                   {"word": "daisy-chain", "start_ms": 100, "end_ms": 500},
                   {"word": "swings", "start_ms": 500, "end_ms": 800}]
        words, uncovered = _map_timings_to_segments(timings, segments)
        assert [w.seg_idx for w in words] == [0, 1, 2, 3, 4]
        assert uncovered == []

    def test_repeated_it_both_mapped(self):
        """P0 核心: 第二句两个 it 都应有时间轴"""
        segments = [Segment("but", "CONJ", "but"), Segment("it", "PRON", "it"),
                    Segment("in", "PREP", "in"), Segment("it", "PRON", "it")]
        timings = [{"word": "but", "start_ms": 0, "end_ms": 200},
                   {"word": "it", "start_ms": 200, "end_ms": 350},
                   {"word": "in", "start_ms": 350, "end_ms": 500},
                   {"word": "it", "start_ms": 500, "end_ms": 650}]
        words, uncovered = _map_timings_to_segments(timings, segments)
        its = [w for w in words if w.seg_idx in (1, 3)]
        assert len(its) == 2
        assert uncovered == []


class TestCheckpointHydrate:
    def test_runner_hydrates_all_fields(self, tmp_path, monkeypatch):
        """checkpoint 恢复必须 hydrate translation/explanation/audio/words (审查确认)"""
        import json
        from aidulc_prep.infra.checkpoint import save_sentence
        from aidulc_prep.pipeline.runner import Runner

        out = str(tmp_path)
        ckpt = {
            "original_text": "Hello world.",
            "segments": [["Hello", "NOUN", "hello"], ["world", "NOUN", "world"], [".", "PUNCT", "."]],
            "translation": "你好世界。",
            "explanation": "hello 是问候语。",
            "audio": {"chapter": 0, "start_ms": 0, "end_ms": 1500},
            "words": [{"seg_idx": 0, "start_ms": 0, "end_ms": 400}, {"seg_idx": 1, "start_ms": 400, "end_ms": 1500}],
            "status": "ok",
            "failedStages": [],
        }
        save_sentence(out, 0, 0, ckpt)

        # 构造一个 Runner, 手动触发 hydrate (不跑真实 LLM)
        runner = Runner({"book_path": "x", "models": {}, "profile": {"id": "self"}}, out)
        book = __import__("aidulc_prep.core.models", fromlist=["Book", "Chapter"]).Book(
            title="T",
            chapters=[__import__("aidulc_prep.core.models", fromlist=["Chapter"]).Chapter(
                index=0, title="C1",
                sentences=[Sentence(original_text="Hello world.")],
            )],
        )
        runner._hydrate_book(book)
        s = book.chapters[0].sentences[0]
        assert s.translation == "你好世界。"
        assert s.explanation == "hello 是问候语。"
        assert s.audio is not None and s.audio.end_ms == 1500
        assert len(s.words) == 2
        assert s.words[0].seg_idx == 0
