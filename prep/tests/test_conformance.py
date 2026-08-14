"""契约 conformance 测试: 对 contracts/fixtures 里的 golden 数据校验 (R3 结构性防漂移)"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.schema import (
    SUPPORTED_BOOKPACK_VERSION,
    validate_bookpack,
    validate_job_request,
    validate_progress,
)

FIXTURES = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "fixtures"))


def _load_fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f)


class TestBookpackConformance:
    def test_sample_bookpack_valid(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        errors = validate_bookpack(bp)
        assert errors == [], errors

    def test_roundtrip_via_models(self):
        """core/models 生成 → to_dict → schema 校验 (保证领域层与契约一致)"""
        from aidulc_prep.core.models import Book, Chapter, Sentence, Segment, WordTiming, SentenceAudio, PhrasalVerb

        s = Sentence(
            original_text="He broke up with her.",
            segments=[Segment("He", "PRON", "he"), Segment("broke", "VERB", "break"),
                      Segment("up", "PART", "up"), Segment("with", "PREP", "with"),
                      Segment("her", "PRON", "she"), Segment(".", "PUNCT", ".")],
            translation="他和她分手了。",
            explanation="break up 是短语动词。",
            phrasal_verbs=[PhrasalVerb(text="broke up", indices=[1, 2], lemma="break up", translation="分手")],
            audio=SentenceAudio(chapter=0, start_ms=0, end_ms=3000),
            words=[WordTiming(seg_idx=0, start_ms=0, end_ms=300),
                   WordTiming(seg_idx=1, start_ms=300, end_ms=900)],
            status="ok",
        )
        book = Book(title="T", chapters=[Chapter(index=0, title="C1", sentences=[s])])
        bp = {
            "schemaVersion": 1,
            "title": book.title,
            "profile": {"id": "self", "name": "成人自读", "explainStrategy": "brief", "voice": "af_heart", "speed": 1.0},
            "generatedAt": 1700000000000,
            "prepVersion": "0.1.0",
            "chapters": [
                {"index": ch.index, "title": ch.title, "audioFile": "audio/ch_000.opus",
                 "sentences": [
                     {"original_text": s.original_text,
                      "translation": s.translation,
                      "explanation": s.explanation,
                      "segments": [seg.to_list() for seg in s.segments],
                      "phrasal_verbs": [{"text": pv.text, "indices": pv.indices, "lemma": pv.lemma, "translation": pv.translation} for pv in s.phrasal_verbs],
                      "audio": {"chapter": s.audio.chapter, "start_ms": s.audio.start_ms, "end_ms": s.audio.end_ms},
                      "words": [{"seg_idx": w.seg_idx, "start_ms": w.start_ms, "end_ms": w.end_ms} for w in s.words],
                      "status": s.status, "failedStages": s.failed_stages}
                     for s in ch.sentences
                 ]}
                for ch in book.chapters
            ],
            "quality": {"stages": {"nlp": {"done": 1, "failed": 0, "successRate": 1.0}},
                        "summary": "ok", "failedSentences": []},
            "models": {"llm": "x"},
        }
        errors = validate_bookpack(bp)
        assert errors == [], errors

    def test_high_version_rejected(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["schemaVersion"] = SUPPORTED_BOOKPACK_VERSION + 1
        errors = validate_bookpack(bp)
        assert any("高于支持版本" in e for e in errors)

    def test_unknown_field_rejected(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["sentences"][0]["hacked_field"] = 1
        errors = validate_bookpack(bp)
        assert any("hacked_field" in e for e in errors)

    def test_bad_status_rejected(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["sentences"][0]["status"] = "weird"
        errors = validate_bookpack(bp)
        assert any("status" in e for e in errors)

    def test_null_audio_for_failed_sentence_valid(self):
        """K3 (2026-08-14): TTS/对齐失败句的 audio 是 None (pack.py 的
        `None if not s.audio else {...}`) —— 之前 schema 只许 object, 任何一句
        TTS 失败就整本 pack 校验失败 (实测: Frindle 1461 句处报"期望 object, 实得
        NoneType")。这条锁定 null 现在是合法状态。"""
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["sentences"][0]["audio"] = None
        errors = validate_bookpack(bp)
        assert errors == [], errors

    def test_wrong_type_still_rejected_after_null_allowed(self):
        """确认放开 null 没有连带放松成"什么都行"——非 null 非 object 仍要报错。"""
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["sentences"][0]["audio"] = "not an object"
        errors = validate_bookpack(bp)
        assert any("audio" in e for e in errors), errors

    def test_images_field_optional_and_valid(self):
        # R4 (2026-08-08): chapter.images 可选 (老书包无此字段仍合法); 有则须 {file, at}
        bp = _load_fixture("sample_bookpack/bookpack.json")
        assert "images" not in bp["chapters"][0], "fixture 无 images 字段"
        assert validate_bookpack(bp) == []
        bp["chapters"][0]["images"] = [
            {"file": "images/ch_000_cover.jpg", "at": 0},
            {"file": "images/ch_000_fig1.jpg", "at": 2},
        ]
        assert validate_bookpack(bp) == []

    def test_image_entry_requires_file_and_at(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["images"] = [{"file": "images/x.jpg"}]  # 缺 at
        errors = validate_bookpack(bp)
        assert any("at" in e for e in errors)

    def test_unknown_image_field_rejected(self):
        bp = _load_fixture("sample_bookpack/bookpack.json")
        bp["chapters"][0]["images"] = [{"file": "a.jpg", "at": 0, "bogus": 1}]
        errors = validate_bookpack(bp)
        assert any("bogus" in e for e in errors)


class TestJobRequestConformance:
    def test_valid_job_request(self):
        job = {
            "job_id": "abc", "book_path": "C:/x.epub", "out_dir": "C:/out",
            "profile": {"id": "kid", "explain_strategy": "deep", "voice": "af_heart", "speed": 0.9, "highlight_granularity": "word"},
            "models": {"llm": "F:/m.gguf", "tts": "F:/k.pth"},
            "tokens": {"temperature": 0.3, "max_tokens": 400},
        }
        assert validate_job_request(job) == []

    def test_missing_required(self):
        assert validate_job_request({"job_id": "x"}) != []

    def test_bad_enum(self):
        job = {
            "job_id": "a", "book_path": "b", "out_dir": "c",
            "profile": {"id": "p", "explain_strategy": "nope", "voice": "v", "speed": 1, "highlight_granularity": "word"},
            "models": {"llm": "l", "tts": "t"}, "tokens": {},
        }
        assert any("explain_strategy" in e for e in validate_job_request(job))


class TestProgressConformance:
    def test_stage_start(self):
        assert validate_progress({"type": "stage_start", "ts": 1, "stage": "nlp"}) == []

    def test_stage_progress_requires_counts(self):
        errs = validate_progress({"type": "stage_progress", "ts": 1, "stage": "tts"})
        assert any("current" in e for e in errs)

    def test_sentence_done(self):
        assert validate_progress({"type": "sentence_done", "ts": 1, "sentence_index": 5, "status": "partial"}) == []

    def test_error_requires_message(self):
        errs = validate_progress({"type": "error", "ts": 1})
        assert any("message" in e for e in errs)

    def test_unknown_type_rejected(self):
        errs = validate_progress({"type": "bogus", "ts": 1})
        assert errs
