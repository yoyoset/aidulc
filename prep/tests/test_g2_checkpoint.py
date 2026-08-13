"""G2 回归测试: checkpoint 失败态 + 重试语义 (审查确认的严重 bug)"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.infra.checkpoint import (
    clear_stages,
    is_done_sentence,
    load_sentence,
    overwrite_sentence,
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
        # failedStages 统一存阶段名 "translate" (不是字段名 "translation"), 与 mark_failed 一致
        assert "translate" in data["failedStages"]

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


class TestRetryContract:
    """重试失败句的契约 (2026-08-13 修复): 阶段失败可被后续成功恢复, 不粘死。"""

    def test_translate_fail_then_success_recovers(self, tmp_path):
        """翻译失败 → failed + failedStages=["translate"]; 重跑成功 → 清失败标记、恢复 ok。
        之前成功不清 failedStages, 重跑成功仍粘 failed → explain/tts 继续跳过 (重试失效)。"""
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "translation", None, status="failed")
        assert load_sentence(out, 0, 0)["status"] == "failed"
        assert load_sentence(out, 0, 0)["failedStages"] == ["translate"]
        save_stage_result(out, 0, 0, "translation", "你好。", status="ok")
        data = load_sentence(out, 0, 0)
        assert data["status"] == "ok"
        assert data["failedStages"] == []
        assert data["translation"] == "你好。"

    def test_tts_fail_then_success_keeps_other_failures(self, tmp_path):
        """tts 失败后成功只清 tts, 不清其它仍未恢复的失败 (partial 语义保持)。"""
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "explanation", None, status="failed")  # explain 失败
        save_stage_result(out, 0, 0, "audio", None, status="failed")  # tts 失败
        assert load_sentence(out, 0, 0)["failedStages"] == ["explain", "tts"]
        save_stage_result(out, 0, 0, "audio", {"start_ms": 0, "end_ms": 1000}, status="ok")
        data = load_sentence(out, 0, 0)
        assert data["failedStages"] == ["explain"], "tts 恢复后 failedStages 只剩 explain"
        assert data["status"] == "partial", "仍剩非 fatal 失败 → partial"


class TestClearStages:
    """手动重跑 (2026-08-13): force_stages 清 checkpoint 强制重跑, 含下游级联。"""

    def test_clear_tts_cascades_to_align(self, tmp_path):
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "translation", "你好。")
        save_stage_result(out, 0, 0, "explanation", "讲解")
        save_stage_result(out, 0, 0, "audio", {"start_ms": 0, "end_ms": 100})
        save_stage_result(out, 0, 0, "words", [{"seg_idx": 0, "start_ms": 0, "end_ms": 100}])
        clear_stages(out, ["tts"])
        data = load_sentence(out, 0, 0)
        assert "translation" in data, "translate 不应被清"
        assert "explanation" in data, "explain 不应被清"
        assert "audio" not in data, "tts 应被清"
        assert "words" not in data, "align (下游) 应被清"

    def test_clear_translate_cascades_to_explain(self, tmp_path):
        out = str(tmp_path)
        save_stage_result(out, 0, 0, "translation", "你好。")
        save_stage_result(out, 0, 0, "explanation", "讲解")
        clear_stages(out, ["translate"])
        data = load_sentence(out, 0, 0)
        assert "translation" not in data, "translate 应被清"
        assert "explanation" not in data, "explain (下游) 应被清"


class TestPositionReconciliation:
    """S2.4: nlp 阶段位置对齐风险修复 (memory/pipeline.md 记录的已知风险)。

    checkpoint 按章节位置存盘, 不按内容寻址。fragment 过滤在两次运行间产生差异时,
    同一位置可能对应不同句子——reconcile_position_checkpoint 是这个修复的核心纯函数,
    独立测试不需要加载真实 spaCy 模型。
    """

    def test_no_prior_checkpoint_no_conflict(self):
        from aidulc_prep.pipeline.nlp.stage import reconcile_position_checkpoint
        result, conflict = reconcile_position_checkpoint({}, "Hello world.")
        assert conflict is None
        assert result == {}

    def test_matching_original_text_preserves_data(self):
        from aidulc_prep.pipeline.nlp.stage import reconcile_position_checkpoint
        existing = {
            "original_text": "Hello world.",
            "translation": "你好世界。",
            "audio": {"start_ms": 0, "end_ms": 1000},
        }
        result, conflict = reconcile_position_checkpoint(existing, "Hello world.")
        assert conflict is None
        assert result["translation"] == "你好世界。"
        assert result["audio"]["end_ms"] == 1000

    def test_mismatched_original_text_clears_stale_data(self):
        """核心场景: 位置 i 的旧 checkpoint 属于另一句话, 必须清空而不是被"匹配"沿用。"""
        from aidulc_prep.pipeline.nlp.stage import reconcile_position_checkpoint
        existing = {
            "original_text": "The old sentence that used to be here.",
            "translation": "曾经在这里的旧句子的译文。",
            "audio": {"start_ms": 5000, "end_ms": 8000},
            "words": [{"seg_idx": 0, "start_ms": 5000, "end_ms": 5200}],
        }
        result, conflict = reconcile_position_checkpoint(existing, "A completely different new sentence.")
        assert conflict is not None
        assert "The old sentence" in conflict
        assert "A completely different" in conflict
        # 必须清空, 不能残留旧句子的 translation/audio/words 挂到新句子名下
        assert result == {}

    def test_legacy_checkpoint_without_original_text_backward_compatible(self):
        """极老的 checkpoint(此字段加入前写的)没有 original_text, 视为"无锚点可比对",
        不触发清空 —— 这是本次修复刻意保留的向后兼容路径, 不是遗漏。"""
        from aidulc_prep.pipeline.nlp.stage import reconcile_position_checkpoint
        existing = {"translation": "旧版本写的译文, 没有 original_text 字段。"}
        result, conflict = reconcile_position_checkpoint(existing, "Any new sentence.")
        assert conflict is None
        assert result["translation"] == "旧版本写的译文, 没有 original_text 字段。"

    def test_reconcile_then_overwrite_roundtrip(self, tmp_path):
        """端到端确认(复现并修复过一次真实 bug): 用 save_sentence(合并语义)"清空"只在
        内存里生效, 磁盘上的旧字段纹丝不动——第一版实现就是这样错的, 靠这个测试跑出来
        才发现。冲突场景必须用 overwrite_sentence(整体替换), 这里验证的是"真的"清空:
        磁盘上确实不残留旧数据, 不只是内存里看着对。"""
        out = str(tmp_path)
        save_sentence(out, 0, 0, {
            "original_text": "Old text at position 0.",
            "translation": "旧译文",
            "audio": {"start_ms": 0, "end_ms": 500},
        })

        # 先证明"save_sentence 清空是假的"这个坑真实存在: 传一个清空的 dict 进去,
        # 合并语义会让磁盘上的旧字段原样保留。
        save_sentence(out, 0, 0, {"original_text": "New text (still via save_sentence)."})
        still_stale = load_sentence(out, 0, 0)
        assert still_stale["translation"] == "旧译文", "这一步是在验证坑本身: save_sentence 的合并语义不会清空旧字段"

        # 真正的修复路径: overwrite_sentence 整体替换。
        overwrite_sentence(out, 0, 0, {"original_text": "New text at position 0."})
        on_disk = load_sentence(out, 0, 0)
        assert on_disk == {"original_text": "New text at position 0."}
        assert "translation" not in on_disk, "旧译文不能残留在磁盘上的新 checkpoint 里"
        assert "audio" not in on_disk, "旧音频时间轴不能残留"

    def test_no_conflict_path_still_preserves_other_stage_data(self, tmp_path):
        """非冲突路径(original_text 匹配)必须继续走 save_sentence 合并语义——
        这是断点续跑的基础: nlp 阶段重跑不能抹掉同一句子已经翻译好的 translation。"""
        from aidulc_prep.pipeline.nlp.stage import reconcile_position_checkpoint
        out = str(tmp_path)
        save_sentence(out, 0, 0, {
            "original_text": "Same sentence.",
            "translation": "已经翻译好的译文, 不该被 nlp 重跑抹掉。",
        })
        existing = load_sentence(out, 0, 0)
        reconciled, conflict = reconcile_position_checkpoint(existing, "Same sentence.")
        assert conflict is None
        reconciled.update({"original_text": "Same sentence.", "segments": []})
        save_sentence(out, 0, 0, reconciled)
        on_disk = load_sentence(out, 0, 0)
        assert on_disk["translation"] == "已经翻译好的译文, 不该被 nlp 重跑抹掉。"
        assert on_disk["segments"] == []
