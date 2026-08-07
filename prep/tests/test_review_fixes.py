"""审查修复回归测试: partial 语义 / 失败粘死 / 时间轴推进"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.infra.checkpoint import is_done_sentence, load_sentence, save_stage_result


class TestPartialSemantics:
    def test_tts_failure_is_partial_not_failed(self):
        """审查确认 B1: explain/tts/align 失败应为 partial (有译文仍可读), 不是 failed"""
        out = str(__import__("tempfile").mkdtemp())
        save_stage_result(out, 0, 0, "tts", None, status="failed")
        data = load_sentence(out, 0, 0)
        assert data["status"] == "partial", f"tts 失败应为 partial, 实得 {data['status']}"
        assert "tts" in data["failedStages"]

    def test_translate_failure_is_failed(self):
        out = str(__import__("tempfile").mkdtemp())
        save_stage_result(out, 0, 0, "translation", None, status="failed")
        data = load_sentence(out, 0, 0)
        assert data["status"] == "failed", "翻译失败应为 failed"

    def test_partial_then_success_recovers_to_ok(self):
        """partial 句后续成功阶段可恢复为 ok (不粘死)"""
        out = str(__import__("tempfile").mkdtemp())
        save_stage_result(out, 0, 0, "tts", None, status="failed")
        assert load_sentence(out, 0, 0)["status"] == "partial"
        save_stage_result(out, 0, 0, "tts", {"start_ms": 0, "end_ms": 1000})
        assert load_sentence(out, 0, 0)["status"] == "ok", "成功后应恢复 ok"

    def test_partial_translation_done_not_retranslated(self):
        """partial 句 translation 已完成 → is_done_sentence 判完成 (重跑不重复翻译)"""
        out = str(__import__("tempfile").mkdtemp())
        save_stage_result(out, 0, 0, "translation", "你好。")
        save_stage_result(out, 0, 0, "tts", None, status="failed")
        assert is_done_sentence(out, 0, 0, "translation"), "partial 句翻译已完成不应重译"
        assert not is_done_sentence(out, 0, 0, "tts"), "tts 失败应可重试"


class TestQualityReportPersisted:
    def test_run_writes_quality_report(self, tmp_path):
        """I-C: 任务结束 quality_report.json 必须落盘 (Rust 侧 jobs.error 摘要来源)"""
        import json
        from aidulc_prep.pipeline.runner import Runner
        job = {"book_path": str(tmp_path / "b.txt"), "profile": "default", "ffmpeg_path": ""}
        out = str(tmp_path / "out")
        os.makedirs(out, exist_ok=True)
        r = Runner(job, out)
        r._write_quality_report()
        p = os.path.join(out, "quality_report.json")
        assert os.path.exists(p), "quality_report.json 未落盘"
        data = json.load(open(p, encoding="utf-8"))
        assert "failedSentences" in data
        assert "stages" in data
