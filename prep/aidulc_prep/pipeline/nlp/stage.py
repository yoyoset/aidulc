"""
pipeline/nlp/stage.py —— NLP 阶段 (M 系列: 从 runner.py 提取, 与 llm/tts stage 对称)

职责: 加载 spaCy 模型 → 逐章批处理 → 落 checkpoint → 记 quality。
模式与 llm/stage.py / tts/stage.py 一致: (book, job, out_dir, quality, cancel) 驱动。
"""
from __future__ import annotations

from aidulc_prep.core.errors import EngineError
from aidulc_prep.core.models import Book
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.infra.checkpoint import load_sentence, save_sentence


def run_nlp_stage(
    book: Book,
    job: dict,
    out_dir: str,
    quality: QualityReport,
    cancel=None,
) -> None:
    """NLP 阶段: 语言驱动的 spaCy 模型 + 批处理。"""
    import spacy

    from aidulc_prep.application.language_registry import get_nlp_model
    from aidulc_prep.pipeline.nlp import process_chapter_nlp_batch

    # H5: 语言驱动的 spaCy 模型 (默认 en_core_web_sm; 注册表可扩展)
    langs = job.get("languages")
    lang = langs.get("source") if isinstance(langs, dict) else job.get("source_language", "en")
    nlp = spacy.load(job.get("models", {}).get("spacy") or get_nlp_model(lang))

    for ch in book.chapters:
        if cancel and cancel():
            raise EngineError("已取消", "nlp")
        # G3: nlp.pipe 批处理 (长书吞吐)
        process_chapter_nlp_batch(ch, nlp, batch_size=1024)
        # Bug fix (审查确认): nlp 失败句记入 quality (旧实现无条件 ok, 成功率永远 100%)
        nlp_failed = sum(1 for s in ch.sentences if s.status == "failed" and "nlp" in s.failed_stages)
        if nlp_failed:
            quality.record("nlp", ok=False)
            quality.add_failure(ch.index, -1, ["nlp"], f"{nlp_failed} 句 nlp 失败")
        else:
            quality.record("nlp", ok=True)
        for i, s in enumerate(ch.sentences):
            # G2: 只更新 nlp 产物, 不覆盖已有 status/failedStages (旧实现重跑清掉失败标记,
            # 导致"重试失败句"失效 — 审查确认的 bug)
            existing = load_sentence(out_dir, ch.index, i) or {}
            existing["original_text"] = s.original_text
            existing["segments"] = [seg.to_list() for seg in s.segments]
            existing["phrasal_verbs"] = [
                {"text": pv.text, "indices": pv.indices, "lemma": pv.lemma, "translation": pv.translation}
                for pv in s.phrasal_verbs
            ]
            save_sentence(out_dir, ch.index, i, existing)
