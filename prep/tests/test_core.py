"""core 层纯函数单测 (无模型无网络, 可 CI)"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.pos_map import map_pos, AIDU_POS_ENUM
from aidulc_prep.core.models import Sentence
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.core.errors import EngineError, ModelError, format_job_failure


class TestPosMap:
    def test_basic_mapping(self):
        assert map_pos("NOUN") == "NOUN"
        assert map_pos("VERB") == "VERB"
        assert map_pos("ADJ") == "ADJ"
        assert map_pos("ADV") == "ADV"
        assert map_pos("PRON") == "PRON"
        assert map_pos("DET") == "DET"
        assert map_pos("NUM") == "NUM"
        assert map_pos("INTJ") == "INTJ"
        assert map_pos("PUNCT") == "PUNCT"

    def test_adp_to_prep(self):
        assert map_pos("ADP") == "PREP"

    def test_cconj_sconj_to_conj(self):
        assert map_pos("CCONJ") == "CONJ"
        assert map_pos("SCONJ") == "CONJ"

    def test_propn_to_noun(self):
        assert map_pos("PROPN") == "NOUN"

    def test_aux_to_verb(self):
        assert map_pos("AUX") == "VERB"

    def test_tag_overrides(self):
        assert map_pos("PART", "TO") == "PART"  # 不定式 to
        assert map_pos("PART", "POS") == "PART"  # 所有格 's
        assert map_pos("DET", "PRP$") == "DET"   # my/your
        assert map_pos("ADP", "RP") == "PART"    # 短语动词小品词
        assert map_pos("PRON", "EX") == "PRON"   # there

    def test_unknown_fallback(self):
        assert map_pos("") == "X"
        assert map_pos("BOGUS") == "X"

    def test_all_outputs_in_aidu_enum(self):
        for pos in ["ADJ", "ADP", "ADV", "AUX", "CCONJ", "DET", "INTJ", "NOUN", "NUM", "PART",
                    "PRON", "PROPN", "PUNCT", "SCONJ", "SYM", "X", ""]:
            assert map_pos(pos) in AIDU_POS_ENUM or map_pos(pos) == "X"


class TestSentenceStatus:
    def test_translate_failure_marks_failed(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("translate")
        assert s.status == "failed"
        assert s.failed_stages == ["translate"]

    def test_tts_failure_marks_partial(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("tts")
        assert s.status == "partial"

    def test_align_failure_keeps_partial_after_ok(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("align")
        assert s.status == "partial"
        assert s.failed_stages == ["align"]

    def test_no_duplicate_stages(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("tts")
        s.mark_failed("tts")
        assert s.failed_stages == ["tts"]

    def test_failed_stays_failed_after_partial_stage(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("translate")
        s.mark_failed("align")
        assert s.status == "failed"

    def test_clear_failed_stage_recovers(self):
        """重试契约: 失败后成功清标记并重算状态 (translate 失败 → clear → ok)。"""
        s = Sentence(original_text="Hello.")
        s.mark_failed("translate")
        assert s.status == "failed" and s.failed_stages == ["translate"]
        s.clear_failed_stage("translate")
        assert s.status == "ok" and s.failed_stages == []

    def test_clear_failed_stage_keeps_other_failures(self):
        s = Sentence(original_text="Hello.")
        s.mark_failed("translate")
        s.mark_failed("tts")
        s.clear_failed_stage("tts")
        assert s.status == "failed", "translate 仍失败 → failed"
        assert s.failed_stages == ["translate"]


class TestQualityReport:
    def test_success_rate(self):
        q = QualityReport()
        q.record("tts", ok=True)
        q.record("tts", ok=True)
        q.record("tts", ok=False)
        assert q.stages["tts"].done == 2
        assert q.stages["tts"].failed == 1
        assert q.stages["tts"].success_rate == round(2 / 3, 3)

    def test_summary_empty(self):
        q = QualityReport()
        assert "全部句子成功" in q._summary()

    def test_summary_with_failures(self):
        q = QualityReport()
        q.add_failure(chapter=0, index=2, stages=["tts", "align"], reason="TTS 时长异常")
        s = q._summary()
        assert "1 句" in s and "tts" in s and "align" in s

    def test_to_dict_shape(self):
        q = QualityReport()
        q.record("parse", ok=True)
        q.add_failure(chapter=0, index=1, stages=["tts"], reason="x")
        d = q.to_dict()
        assert "stages" in d and "failedSentences" in d and "summary" in d
        assert d["failedSentences"][0]["index"] == 1


class TestErrors:
    def test_human_detail_separation(self):
        e = EngineError("llama 起不来", "spawn failed: 端口占用 8088")
        assert e.human == "llama 起不来"
        assert e.detail == "spawn failed: 端口占用 8088"

    def test_format_job_failure(self):
        assert "模型问题" in format_job_failure(ModelError("GGUF 缺失"))
        assert "引擎问题" in format_job_failure(EngineError("起不来"))
