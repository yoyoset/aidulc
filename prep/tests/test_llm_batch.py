"""Phase 3 测试: 批量编号对齐 + 对半拆分重试 + echo/错位检测 (纯函数, 无模型)"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.pipeline.llm.batch import (
    looks_untranslated,
    parse_numbered_response,
    split_leading_number,
    translate_batch_with_retry,
)
from aidulc_prep.pipeline.llm.guard import (
    check_batch_length_ratios,
    check_explain_echo,
    check_length_ratio,
    guard_batch,
)
from aidulc_prep.core.errors import EngineError


class TestParseNumbered:
    def test_well_formed(self):
        assert parse_numbered_response("1. 你好\n2. 世界\n3. 再见", 3) == ["你好", "世界", "再见"]

    def test_fullwidth_and_alternate_separators(self):
        content = "1、第一行\n2）第二行\n3. 第三行"
        assert parse_numbered_response(content, 3) == ["第一行", "第二行", "第三行"]

    def test_rejects_mismatched_count(self):
        with pytest.raises(ValueError):
            parse_numbered_response("1. 只有一行", 3)

    def test_rejects_missing_middle(self):
        with pytest.raises(ValueError):
            parse_numbered_response("1. 第一行\n3. 第三行", 2)

    def test_real_sakura_batch_style(self):
        content = "1. 早安。\n2. 今天天气真好。\n3. 一起去上学吧。\n4. 肚子饿了。\n5. 去吃点东西吧。"
        out = parse_numbered_response(content, 5)
        assert out[0] == "早安。"
        assert out[4] == "去吃点东西吧。"

    def test_split_leading_number(self):
        assert split_leading_number("3. 译文") == (3, "译文")
        assert split_leading_number("3、译文") == (3, "译文")
        assert split_leading_number("3）译文") == (3, "译文")
        assert split_leading_number("no number here") == (None, "no number here")


class TestLooksUntranslated:
    def test_verbatim_echo(self):
        assert looks_untranslated("somewhere where you just take, you know,", "somewhere where you just take, you know,")

    def test_case_whitespace_insensitive(self):
        assert looks_untranslated("Hello World", "  hello world  ")

    def test_false_for_real_translation(self):
        assert not looks_untranslated("Hello there.", "你好。")

    def test_false_for_pure_symbols(self):
        assert not looks_untranslated("♪♪♪", "♪♪♪")
        assert not looks_untranslated("123", "123")


class TestRetry:
    def test_success_first_try(self):
        calls = []

        def fake_complete(messages):
            calls.append(1)
            content = "\n".join(f"{i + 1}. 译{i}" for i in range(len(messages[1]["content"].splitlines())))
            return content

        results, failed = translate_batch_with_retry(fake_complete, ["A", "B", "C"])
        assert len(results) == 3
        assert failed == []

    def test_half_split_on_mismatch(self):
        """第一次返回行数不对 → 对半重试, 各半分别成功"""
        calls = {"n": 0}

        def fake_complete(messages):
            calls["n"] += 1
            lines = messages[1]["content"].splitlines()
            n = len(lines)
            if calls["n"] == 1:
                return "1. 只给一行"  # 错误
            return "\n".join(f"{i + 1}. 译{i}" for i in range(n))

        results, failed = translate_batch_with_retry(fake_complete, ["A", "B", "C", "D"])
        assert len(results) == 4
        assert failed == []
        assert calls["n"] == 3  # 1 次整批 + 2 次对半

    def test_single_line_failure_keeps_original(self):
        """单行仍然失败 → 保留原文 + 记失败下标"""
        def fake_complete(messages):
            return "原文没翻译"  # 回显/垃圾

        results, failed = translate_batch_with_retry(fake_complete, ["Hello world."])
        assert results == ["Hello world."]
        assert failed == [0]

    def test_retry_single_echo_line(self):
        """echo 命中的行单独重试, 重试成功则替换"""
        calls = {"n": 0}

        def fake_complete(messages):
            calls["n"] += 1
            if calls["n"] == 1:
                return "1. Hello world."  # 整批回显
            return "1. 你好，世界。"  # 单独重试成功

        results, failed = translate_batch_with_retry(fake_complete, ["Hello world."])
        assert results == ["你好，世界。"]
        assert failed == []
        assert calls["n"] == 2

    def test_empty_input(self):
        results, failed = translate_batch_with_retry(lambda m: "", [])
        assert results == [] and failed == []

    def test_fatal_model_error_propagates(self):
        """P0 修复 (2026-08-13): 模型推理致命失败 (EngineError) 必须往上抛, 不能被吞成
        '每行失败' —— 否则任务一路跑到 pack 还报成功 (后台失败但用户以为成功)。"""
        def dead(messages):
            raise EngineError("LLM 推理失败", "CUDA OOM")

        with pytest.raises(EngineError):
            translate_batch_with_retry(dead, ["A", "B", "C"])

    def test_fatal_error_in_echo_retry_propagates(self):
        """echo 单独重试途中模型死掉也要往上抛, 不能吞成 still_failed。"""
        calls = {"n": 0}

        def flaky(messages):
            calls["n"] += 1
            if calls["n"] == 1:
                return "1. Hello world."  # 整批回显 → 触发单独重试
            raise EngineError("LLM 推理失败", "CUDA OOM")

        with pytest.raises(EngineError):
            translate_batch_with_retry(flaky, ["Hello world."])


class TestGuard:
    def test_length_ratio_normal(self):
        assert check_length_ratio("The committee reached an agreement after hours of discussion.",
                                  "委员会经过数小时讨论达成一致。", 1) is None

    def test_length_ratio_suspicious(self):
        # 译文长得离谱 (3 倍以上)
        reason = check_length_ratio("Hi.", "这是完全没有意义的一大段废话，既长又没有实际内容，完全不像翻译，明显有问题。", 1)
        assert reason is not None

    def test_empty_translation_suspicious(self):
        assert check_length_ratio("Hello world", "", 1) is not None

    def test_batch_ratios(self):
        probs = check_batch_length_ratios(
            ["Hello world", "The committee reached an agreement"],
            ["你好世界", "X" * 300],  # 第二个可疑
        )
        assert len(probs) == 1
        assert "第 2 行" in probs[0]

    def test_explain_echo(self):
        assert check_explain_echo("Hello world.", "Hello world.")
        assert not check_explain_echo("Hello world.", "hello 表示你好, world 表示世界。")

    def test_guard_batch_raises_value_error_not_engine_error(self):
        """P0 修复 (2026-08-13): guard 的输出可疑必须是 ValueError (可重试), 不是 EngineError
        (致命) —— 二者在 batch.translate_batch_with_retry 里用异常类型区分, 混用会把可重试的
        错位当致命错误往上抛、或把致命错误当可重试吞掉。"""
        with pytest.raises(ValueError):
            guard_batch(["Hello world", "Second line"], ["Hello world", "Second line"])
