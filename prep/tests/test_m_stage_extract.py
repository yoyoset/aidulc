"""M 系列回归: nlp/align stage 提取 (runner 只编排, 阶段实现可独立测试)"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.models import Book, Chapter, Sentence
from aidulc_prep.core.quality import QualityReport


def make_book():
    s1 = Sentence(original_text="Hello world.", status="ok")
    s2 = Sentence(original_text="Second sentence.", status="failed")
    s2.failed_stages = ["nlp"]
    ch = Chapter(index=0, title="Ch0", sentences=[s1, s2])
    return Book(title="Test", chapters=[ch])


class TestNlpStage:
    def test_import_and_signature(self):
        """stage 可从包导入且签名对称 (runner 编排, stage 实现)"""
        import inspect
        from aidulc_prep.pipeline.nlp.stage import run_nlp_stage
        params = list(inspect.signature(run_nlp_stage).parameters)
        assert params == ["book", "job", "out_dir", "quality", "cancel"], f"实得 {params}"


class TestAlignStage:
    def test_align_records_ok_for_valid(self, tmp_path):
        """无 audio 的句子跳过; 不崩溃"""
        from aidulc_prep.pipeline.align.stage import run_align_stage
        q = QualityReport()
        book = make_book()
        run_align_stage(book, q)  # 无 audio → 全跳过, 无记录
        assert "align" not in q.stages

    def test_align_signature_symmetry(self):
        import inspect
        from aidulc_prep.pipeline.align.stage import run_align_stage
        params = list(inspect.signature(run_align_stage).parameters)
        assert params == ["book", "quality", "cancel"], f"实得 {params}"
