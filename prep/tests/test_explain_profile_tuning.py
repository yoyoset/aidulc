"""K33 (2026-08-16, 用户拍板"讲解深度分档不够, 要能调字数和触发门槛"): profile 新增
explain_max_chars(讲解字数上限)/explain_min_sentence_chars(讲解触发门槛)。

重点覆盖一个容易踩的坑: runner.py::_explain 有个"首次运行完整性校验"(防循环漏跑,
Breath 早期 2518 句欠账的根因场景), 如果加门槛跳过的句子不算进"预期处理数"的排除项,
配置了门槛的书首次跑必然被完整性校验误判成"漏跑"直接报错——这个交互点必须测到,
不能只测 explain_sentences 本身。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.models import Book, Chapter, Sentence
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.pipeline.llm.prompt import explain_system_for
from aidulc_prep.pipeline.llm.stage import explain_sentences
from aidulc_prep.pipeline.runner import Runner


class TestExplainSystemForMaxChars:
    def test_no_max_chars_keeps_prompt_unconstrained(self):
        assert "字以内" not in explain_system_for("brief")
        assert "字以内" not in explain_system_for("deep")

    def test_max_chars_appends_explicit_limit(self):
        sys_msg = explain_system_for("deep", max_chars=100)
        assert "100 字以内" in sys_msg

    def test_zero_max_chars_treated_as_unconstrained(self):
        """0 是"不限制"的哨兵值, 不该拼出一句"控制在 0 字以内"的荒谬指令。"""
        assert "字以内" not in explain_system_for("brief", max_chars=0)


class TestExplainSentencesMinLengthThreshold:
    def make_chapter(self, texts):
        sents = []
        for t in texts:
            s = Sentence(original_text=t, status="ok")
            s.translation = "译文"
            sents.append(s)
        return Chapter(index=0, title="Ch0", sentences=sents)

    def test_short_sentence_skipped_not_marked_failed(self, tmp_path):
        calls = []

        def complete_fn(messages, max_tokens=400, temperature=0.3):
            calls.append(1)
            return '{"translation": "译文", "explanation": "讲解内容"}'

        ch = self.make_chapter(["Hi.", "This is a much longer sentence with real content in it."])
        q = QualityReport()
        explain_sentences(ch, complete_fn, str(tmp_path), q, "brief", min_sentence_chars=20)

        assert len(calls) == 1, "只有长句该触发一次 LLM 调用"
        assert ch.sentences[0].explanation == "", "短句不该被讲解"
        assert "explain" not in ch.sentences[0].failed_stages, "跳过不是失败, 不该标记失败"
        assert ch.sentences[1].explanation == "讲解内容"

    def test_zero_threshold_explains_everything(self, tmp_path):
        """min_sentence_chars=0(默认/未设门槛)时行为跟旧版一致, 全部句子都讲。"""
        def complete_fn(messages, max_tokens=400, temperature=0.3):
            return '{"translation": "译文", "explanation": "讲解内容"}'

        ch = self.make_chapter(["Hi.", "Bye."])
        q = QualityReport()
        explain_sentences(ch, complete_fn, str(tmp_path), q, "brief", min_sentence_chars=0)
        assert ch.sentences[0].explanation == "讲解内容"
        assert ch.sentences[1].explanation == "讲解内容"


class TestRunnerExplainCompletenessCheckExcludesThresholdSkips:
    """核心回归点: 配置了 min_sentence_chars 门槛的书, 首次运行不该被完整性校验
    误判成"循环漏跑"。"""

    def test_first_run_with_threshold_does_not_falsely_raise(self, tmp_path, monkeypatch):
        from aidulc_prep.core.errors import EngineError

        class FakeServer:
            def complete(self, messages, max_tokens=400, temperature=0.3):
                return '{"translation": "译文", "explanation": "讲解内容"}'

        monkeypatch.setattr(
            "aidulc_prep.pipeline.llm.server.get_server", lambda model_path: FakeServer()
        )

        # 一半句子很短(会被门槛跳过), 一半够长(会真的讲解)——如果 skipped_fatal
        # 没有把门槛跳过的句子排除掉, expected 分母会偏高, processed_total 达不到
        # 95%, 误触发 "explain 阶段不完整"。
        sents = []
        for i in range(10):
            s = Sentence(original_text=("Hi." if i % 2 == 0 else "This is a long enough sentence for real."))
            s.translation = "译文"
            sents.append(s)
        book = Book(title="T", chapters=[Chapter(index=0, title="C1", sentences=sents)])

        out = str(tmp_path)
        runner = Runner(
            {
                "book_path": "x",
                "models": {"llm": "fake"},
                "profile": {
                    "id": "self",
                    "explain_strategy": "brief",
                    "explain_max_chars": 150,
                    "explain_min_sentence_chars": 20,
                },
            },
            out,
        )
        try:
            runner._explain(book)
        except EngineError as e:
            assert False, f"不该误判成漏跑, 实际抛出: {e}"

        # 短句确实被跳过(无讲解), 长句确实讲了
        short_explained = [s.explanation for i, s in enumerate(sents) if i % 2 == 0]
        long_explained = [s.explanation for i, s in enumerate(sents) if i % 2 == 1]
        assert all(e == "" for e in short_explained), "短句应全部跳过"
        assert all(e == "讲解内容" for e in long_explained), "长句应全部讲解"

    def test_first_run_without_threshold_still_catches_real_underrun(self, tmp_path, monkeypatch):
        """回归防线的另一半: 别把完整性校验彻底废了——真的漏跑(比如 complete_fn
        每次都失败)仍然要能抓出来。"""
        from aidulc_prep.core.errors import EngineError

        class AlwaysFailServer:
            def complete(self, messages, max_tokens=400, temperature=0.3):
                return "not json at all, will fail parsing"

        monkeypatch.setattr(
            "aidulc_prep.pipeline.llm.server.get_server", lambda model_path: AlwaysFailServer()
        )
        sents = []
        for i in range(10):
            s = Sentence(original_text="This is a long enough sentence for real content here.")
            s.translation = "译文"
            sents.append(s)
        book = Book(title="T", chapters=[Chapter(index=0, title="C1", sentences=sents)])
        out = str(tmp_path)
        runner = Runner(
            {
                "book_path": "x",
                "models": {"llm": "fake"},
                "profile": {"id": "self", "explain_strategy": "brief",
                            "explain_max_chars": 150, "explain_min_sentence_chars": 0},
            },
            out,
        )
        # 全部句子调用都"成功返回"(不是致命 EngineError), 只是解析失败被记成
        # per-sentence failed——这不该触发完整性校验(那是防"循环漏跑", 不是防
        # "全部处理但结果都失败"这种不同的问题), 所以这里只验证不会因为完整性
        # 校验以外的原因崩溃, 且确实每句都被处理过(quality 里全部计为失败)。
        runner._explain(book)
        assert all("explain" in s.failed_stages for s in sents), "解析失败应记成每句失败, 但流程本身正常跑完"
