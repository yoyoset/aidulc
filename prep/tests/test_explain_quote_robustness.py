"""讲解解析对"原文含引号"的鲁棒性 (2026-08-18)。

实测根因(拿真实跑批数据 + 直接调模型复现): explain 阶段 4.13% 的失败(全书合计
1065 条)几乎全是"讲解 JSON 解析失败", 而失败句里 **93% 含双引号**(成功句只有 32%)。
直接调模型看原始输出:

    输入   '"No," she said, laughing.'
    模型输出 {"original_text": "No," she said, laughing.", "translation": ...
                                   ↑ 未转义, JSON 从这里就崩了

模型本身会转义(同一次输出里 explanation 内部的 \\"上学后\\" 就是对的), 问题出在
**提示词要求它复述 original_text** —— 原文的引号被原样照抄进 JSON 字符串。
原文我们本来就有, 这个字段纯属多余。

A/B 实测(6 句, 4 句带引号): 带 original_text 解析成功 2/6、1.02s/句、生成 1084 字符;
去掉之后 6/6、0.69s/句、681 字符 —— 质量和速度双赢。

这个文件锁定两件事: 提示词里不再要求复述原文; 解析层对残留的裸引号有兜底。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.llm.prompt import EXPLAIN_BRIEF, EXPLAIN_DEEP, explain_system_for
from aidulc_prep.pipeline.llm.stage import _loose_extract, _parse_explain_json


class TestPromptNoLongerAsksForOriginalText:
    def test_neither_strategy_asks_to_echo_original(self):
        for p in (EXPLAIN_BRIEF, EXPLAIN_DEEP):
            assert "original_text" not in p, "复述原文是引号注入的唯一入口, 不该再要求"

    def test_prompt_says_object_not_array(self):
        """explain 是逐句调用, 说"数组"会诱导模型输出 [ {...} ] 包一层。"""
        for p in (EXPLAIN_BRIEF, EXPLAIN_DEEP):
            assert "不是数组" in p

    def test_max_chars_still_appended(self):
        assert "150 字以内" in explain_system_for("brief", max_chars=150)


class TestLooseExtractFallback:
    def test_bare_quotes_inside_explanation_still_parsed(self):
        """模型在讲解里塞了裸引号 —— 严格 JSON 崩, 兜底要能抠出来。"""
        bad = '{"translation": "他笑着说。", "explanation": "laughing 是现在分词, 表示"边笑边说"。"}'
        tr, ex = _parse_explain_json(bad, '"No," she said, laughing.')
        assert tr == "他笑着说。"
        assert "laughing" in ex and "现在分词" in ex

    def test_loose_extract_returns_none_when_no_explanation(self):
        assert _loose_extract('{"translation": "只有译文"}') is None
        assert _loose_extract("完全不是 JSON 的一段话") is None

    def test_loose_extract_rejects_empty_explanation(self):
        """抠出空讲解等于没救回来, 要判失败而不是落一条空记录。"""
        assert _loose_extract('{"translation": "x", "explanation": ""}') is None

    def test_strict_json_still_preferred(self):
        """合法 JSON 走原路径, 兜底不该改变正常结果。"""
        good = '{"translation": "译文", "explanation": "讲解内容"}'
        assert _parse_explain_json(good, "src") == ("译文", "讲解内容")

    def test_translation_optional_when_only_explanation_recoverable(self):
        """译文抠不到但讲解能抠到时, 讲解仍然要保住(译文另有 translate 阶段兜底)。"""
        out = _loose_extract('{"explanation": "只剩讲解能认出来"}')
        assert out is not None and out[1] == "只剩讲解能认出来"

    def test_truncated_output_is_not_rescued(self):
        """兜底必须区分"完整但有裸引号"(该救)和"被截断"(该重试)。

        第一版兜底没区分, 把半截讲解也救了回来 —— 等于静默产出残缺内容, 比失败更糟。
        既有测试 test_truncated_first_attempt_retries_with_bigger_budget 抓到了这一点。
        判据是收尾引号: 截断的输出末尾没有它。
        """
        truncated = '{"translation": "你好", "explanation": "这句话讲的是打招呼, 用法类似'
        assert _loose_extract(truncated) is None

    def test_still_raises_when_nothing_recoverable(self):
        import pytest
        with pytest.raises(ValueError):
            _parse_explain_json("模型这次啥都没吐出来", "src")
