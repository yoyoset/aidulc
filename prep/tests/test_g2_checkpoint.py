"""G2 回归测试: checkpoint 失败态 + 重试语义 (审查确认的严重 bug)"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.infra.checkpoint import (
    is_done_sentence,
    load_sentence,
    save_sentence,
    save_stage_result,
)


class TestCheckpointFailureSemantics:
    def test_failed_translation_not_done(self, tmp_path):
        """旧 bug: 翻译失败存原文 → 被误判为完成。现在失败存 None → 可重试。"""
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "translation", None, status="failed")
        assert not is_done_sentence(out, 0, 0, "translation"), "失败句不得判为完成"
        data = load_sentence(out, 0, 0)
        assert data["status"] == "failed"
        assert "translation" in data["failedStages"]

    def test_failed_tts_not_done(self, tmp_path):
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "audio", None, status="failed")
        assert not is_done_sentence(out, 0, 0, "audio")
        assert not is_done_sentence(out, 0, 0, "words")

    def test_success_is_done(self, tmp_path):
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "translation", "你好。", status="ok")
        assert is_done_sentence(out, 0, 0, "translation")

    def test_empty_string_not_done(self, tmp_path):
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "explanation", None, status="failed")
        assert not is_done_sentence(out, 0, 0, "explanation")

    def test_partial_status_not_done(self, tmp_path):
        """partial 句的 stage 不应被跳过 (还有失败阶段待重试)"""
        out = str(tmp_path)
        save_sentence(out, 0, 0, {"status": "partial", "failedStages": ["tts"]})
        assert not is_done_sentence(out, 0, 0, "tts")

    def test_atomic_write_leaves_valid_json(self, tmp_path):
        out = str(tmp_path)
        save_sentence(out, 0, 0, {"original_text": "hello", "segments": []})
        # 模拟写入后文件是完整 JSON
        data = load_sentence(out, 0, 0)
        assert data["original_text"] == "hello"

    def test_corrupt_checkpoint_treated_as_not_done(self, tmp_path):
        out = str(tmp_path)
        import os as _os
        p = os.path.join(out, "checkpoints", "ch000", "s00000.json")
        _os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write("{corrupt json")
        assert load_sentence(out, 0, 0) is None
        assert not is_done_sentence(out, 0, 0, "translation")
