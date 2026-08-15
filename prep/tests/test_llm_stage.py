"""explain_sentences 截断重试 (2026-08-15 实测复现: Wonder 一书 2983/7357 句 explain
全部报"讲解 JSON 解析失败") ——deep 策略讲解偏长, 首次 max_tokens 预算不够时应加大
预算重试一次, 而不是一次截断就永久判失败(见 pipeline/llm/stage.py 的注释)。"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.errors import EngineError
from aidulc_prep.core.models import Chapter, Sentence
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.pipeline.llm.stage import (
    EXPLAIN_MAX_TOKENS,
    EXPLAIN_RETRY_MAX_TOKENS,
    explain_sentences,
)


def make_chapter():
    s = Sentence(original_text="Hello world.", status="ok")
    s.translation = "你好世界。"
    return Chapter(index=0, title="Ch0", sentences=[s])


class TestExplainRetry:
    def test_truncated_first_attempt_retries_with_bigger_budget(self, tmp_path):
        """首次调用输出被截断(不是合法 JSON) → 用更大 max_tokens 重试一次 → 成功。"""
        calls = []

        def fake_complete(messages, max_tokens=400, temperature=0.3):
            calls.append(max_tokens)
            if max_tokens == EXPLAIN_MAX_TOKENS:
                # 模拟第一次预算不够, 讲解写到一半被截断(右花括号没了)
                return '{"translation": "你好", "explanation": "这句话讲的是打招呼, 用法类似'
            return '{"translation": "你好", "explanation": "完整讲解"}'

        ch = make_chapter()
        q = QualityReport()
        explain_sentences(ch, fake_complete, str(tmp_path), q, "deep")

        assert calls == [EXPLAIN_MAX_TOKENS, EXPLAIN_RETRY_MAX_TOKENS], f"应该先小预算再大预算重试一次, 实得 {calls}"
        assert ch.sentences[0].explanation == "完整讲解"
        assert "explain" not in ch.sentences[0].failed_stages
        assert q.stages["explain"].done == 1
        assert q.stages["explain"].failed == 0

    def test_still_truncated_after_retry_marks_failed_once(self, tmp_path):
        """两次都截断 → 只重试一次就放弃, 记一次失败, 不无限重试。"""
        calls = []

        def always_truncated(messages, max_tokens=400, temperature=0.3):
            calls.append(max_tokens)
            return '{"translation": "你好", "explanation": "没写完'

        ch = make_chapter()
        q = QualityReport()
        explain_sentences(ch, always_truncated, str(tmp_path), q, "deep")

        assert calls == [EXPLAIN_MAX_TOKENS, EXPLAIN_RETRY_MAX_TOKENS], f"应该恰好尝试两次, 实得 {calls}"
        assert "explain" in ch.sentences[0].failed_stages
        assert q.stages["explain"].failed == 1

    def test_fatal_engine_error_not_retried_as_format_issue(self, tmp_path):
        """模型推理致命失败(EngineError, 是 AidulcError 子类)不当格式问题重试,
        直接冒泡成失败——同 translate_batch_with_retry 的纪律(致命错误不能吞成
        '这句话解析失败', 否则任务照常报成功, 是 P0 红线)。"""
        calls = []

        def boom(messages, max_tokens=400, temperature=0.3):
            calls.append(max_tokens)
            raise EngineError("LLM 推理失败: 模拟崩溃")

        ch = make_chapter()
        q = QualityReport()
        explain_sentences(ch, boom, str(tmp_path), q, "deep")

        assert calls == [EXPLAIN_MAX_TOKENS], f"致命错误不该重试, 实得调用次数 {len(calls)}"
        assert "explain" in ch.sentences[0].failed_stages

    def test_success_on_first_attempt_does_not_retry(self, tmp_path):
        """第一次就成功不该多打一次请求(浪费推理时间)。"""
        calls = []

        def clean(messages, max_tokens=400, temperature=0.3):
            calls.append(max_tokens)
            return '{"translation": "你好", "explanation": "第一次就对了"}'

        ch = make_chapter()
        q = QualityReport()
        explain_sentences(ch, clean, str(tmp_path), q, "deep")

        assert calls == [EXPLAIN_MAX_TOKENS], f"第一次成功不该重试, 实得 {calls}"
        assert ch.sentences[0].explanation == "第一次就对了"
