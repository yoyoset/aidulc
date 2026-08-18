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


def reconcile_position_checkpoint(existing: dict, new_original_text: str) -> tuple[dict, str | None]:
    """位置对齐风险修复 (memory/pipeline.md 记录的已知风险, 2026-08-07 修)。

    checkpoint 按"章节位置"存盘(chXXX/sNNNNN.json), 不是按内容寻址。若 fragment 过滤
    在两次运行间产生差异(句子总数变化), 同一个位置 i 在两次运行里可能对应不同的句子——
    这个位置上历史的 translation/explanation/audio/words 其实属于"曾经在这个位置"的
    另一句话, 不能被当前句子沿用(hydrate 只检查 original_text 是否匹配, 而调用方马上
    就要把 original_text 覆写成当前句子的文本, 不在这里清空旧阶段数据的话, hydrate 会
    看到"匹配"的假象、把别的句子的译文/音频错误地接到这句上)。

    纯函数, 无 I/O: 输入旧 checkpoint dict + 这次解析出的原文, 判断是否需要清空。
    清空强制重跑这一句不是最优(要重新过 translate/explain/tts/align)但正确——
    "不确定时选择重跑而不是用可能错的数据", 与断点续跑的既有取舍一致。

    返回: (可能被清空的 dict, 冲突原因摘要或 None)。
    """
    old_text = existing.get("original_text")
    if old_text and old_text != new_original_text:
        reason = f"位置原文变化(旧: {old_text[:30]!r} → 新: {new_original_text[:30]!r})"
        return {}, reason
    return existing, None


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
            reconciled, conflict = reconcile_position_checkpoint(existing, s.original_text)
            nlp_fields = {
                "original_text": s.original_text,
                "segments": [seg.to_list() for seg in s.segments],
                "phrasal_verbs": [
                    {"text": pv.text, "indices": pv.indices, "lemma": pv.lemma, "translation": pv.translation}
                    for pv in s.phrasal_verbs
                ],
            }
            if conflict:
                # 必须整体替换(overwrite_sentence), 不能用 save_sentence 的合并写入——
                # 合并语义是"和磁盘上的旧内容 update()", reconcile 在内存里清空的 {} 传给
                # save_sentence 不会真的清掉磁盘上的旧 translation/audio(踩过这个坑,
                # 已用 roundtrip 测试复现确认, 见 checkpoint.py::save_sentence 的说明)。
                from aidulc_prep.infra.checkpoint import overwrite_sentence
                # 2026-08-18: 这里原来走 add_failure —— 但重新对齐不是失败, 是保护
                # 数据正确性的正常动作。8/17 改了 EPUB 行内标签解析后几乎每句原文都变了,
                # 于是近乎全量记账, 成品里 Wild Robot 的"失败句数"被放大到 9023
                # (真实失败 30)。改走 notice 通道, 不进 failedSentences。
                quality.add_notice(
                    ch.index, i, "realign",
                    f"{conflict}, 已清空该位置历史阶段数据强制重跑, 防止张冠李戴",
                )
                overwrite_sentence(out_dir, ch.index, i, nlp_fields)
            else:
                reconciled.update(nlp_fields)
                save_sentence(out_dir, ch.index, i, reconciled)
