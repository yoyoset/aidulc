"""
pipeline/llm/stage.py —— 翻译 + 讲解 阶段编排

- 按章分批 (BATCH_SIZE=15), 逐批走 translate_batch_with_retry
- 每句落盘 checkpoint (断点续跑)
- 讲解按 profile explain_strategy 分档
- 失败句 status 标记 + 记入 quality
"""
from __future__ import annotations

import json
import re

from aidulc_prep.core.errors import AidulcError, EngineError
from aidulc_prep.core.models import Chapter, Sentence
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.infra.checkpoint import is_done_sentence, save_stage_result
from aidulc_prep.pipeline.llm.batch import (
    BATCH_SIZE,
    TRANSLATE_SYSTEM,
    translate_batch_with_retry,
)
from aidulc_prep.pipeline.llm.guard import check_explain_echo
from aidulc_prep.pipeline.llm.prompt import explain_system_for


def _clean_json_content(content: str) -> str:
    """JsonCleaner 兜底 (aidu 老路): 剥 ```json 围栏, 截断修复 (括号配平)。
    M 系列: 实现收敛到 json_util.clean_json_content (dict_lookup 共用)。"""
    from aidulc_prep.pipeline.llm.json_util import clean_json_content
    return clean_json_content(content)


def _parse_explain_json(content: str, sentence: str) -> tuple[str, str]:
    """解析单句讲解 JSON。返回 (translation, explanation); 失败抛 ValueError。"""
    cleaned = _clean_json_content(content)
    # 尝试整体解析
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, list) and obj:
            obj = obj[0]
        if isinstance(obj, dict):
            return obj.get("translation", ""), obj.get("explanation", "")
    except json.JSONDecodeError:
        pass
    # 截断修复: 找到最后一个完整对象
    depth = 0
    for i, ch in enumerate(cleaned):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(cleaned[:i + 1])
                    if isinstance(obj, list) and obj:
                        obj = obj[0]
                    if isinstance(obj, dict):
                        return obj.get("translation", ""), obj.get("explanation", "")
                except json.JSONDecodeError:
                    break
    raise ValueError("讲解 JSON 解析失败")


def translate_sentences(
    chapter: Chapter,
    complete_fn,
    out_dir: str,
    quality: QualityReport,
    cancel=None,
    on_batch=None,
) -> None:
    """翻译一章: 分批, 逐句落盘。complete_fn 是 LlmServer.complete 的适配。
    on_batch(done_in_chapter): 每批完成后回调 (UI 实时进度用, 不再等整章)。"""
    pending = []
    indices = []
    for i, s in enumerate(chapter.sentences):
        # 只跳过 nlp 失败的句 (分词失败 = 无 segments, 翻译无从谈起)。之前还跳过
        # s.status == "failed", 导致翻译失败的句子重跑时永远跳过 —— 重试失败句失效 (审查确认)。
        if "nlp" in s.failed_stages:
            continue
        if is_done_sentence(out_dir, chapter.index, i, "translation"):
            s.translation = load_translation(out_dir, chapter.index, i)
            continue
        if s.original_text.strip():
            pending.append(s.original_text)
            indices.append(i)

    processed = 0
    for start in range(0, len(pending), BATCH_SIZE):
        if cancel and cancel():
            raise EngineError("已取消", "translate")
        chunk = pending[start:start + BATCH_SIZE]
        idxs = indices[start:start + BATCH_SIZE]
        try:
            results, failed = translate_batch_with_retry(complete_fn, chunk)
        except Exception as e:
            results, failed = chunk, list(range(len(chunk)))
        for j, i in enumerate(idxs):
            s = chapter.sentences[i]
            if j in failed:
                s.mark_failed("translate")
                # G2: 失败不写原文占位 (旧实现被 is_done_sentence 误判为完成)
                save_stage_result(out_dir, chapter.index, i, "translation", None, status="failed")
                quality.record("translate", ok=False)
                quality.add_failure(chapter.index, i, ["translate"], "翻译失败/回显")
            else:
                s.translation = results[j]
                save_stage_result(out_dir, chapter.index, i, "translation", results[j])
                s.clear_failed_stage("translate")
                quality.record("translate", ok=True)
        processed += len(chunk)
        if on_batch:
            on_batch(processed)


def load_translation(out_dir: str, chapter: int, index: int) -> str:
    from aidulc_prep.infra.checkpoint import load_sentence
    data = load_sentence(out_dir, chapter, index) or {}
    return data.get("translation", "")


# K3-explain (2026-08-15, 实测复现: Wonder 一书 2983/7357 句 explain 全部报
# "讲解 JSON 解析失败"): deep 策略提示词明确要求"讲得啰嗦一点没关系, 多用打比方"
# (prompt.py EXPLAIN_DEEP), 但 complete_fn 默认 max_tokens=400 —— 长讲解在 JSON
# 右花括号写完前被截断, 输出永远不是合法 JSON。旧代码单次调用不重试, 一次截断
# 就永久判失败。EXPLAIN_MAX_TOKENS 给首次调用更宽的默认预算; 首次仍失败时,
# EXPLAIN_RETRY_MAX_TOKENS 用更大预算重试一次(只针对"这句话本身"重试, 不是
# translate 那种对半拆批, 因为 explain 本来就是逐句调用, 没有批可拆)。
EXPLAIN_MAX_TOKENS = 700
EXPLAIN_RETRY_MAX_TOKENS = 1100


def _explain_one(complete_fn, system: str, i: int, original_text: str, max_tokens: int) -> tuple[str, str]:
    """单次调用 + 解析 + guard 校验。失败抛异常(ValueError 或底层 EngineError 等)。"""
    content = complete_fn([
        {"role": "system", "content": system},
        {"role": "user", "content": f"[{i}] {original_text}"},
    ], max_tokens=max_tokens)
    tr, ex = _parse_explain_json(content, original_text)
    if check_explain_echo(original_text, ex):
        raise ValueError("讲解是原文回显")
    if not ex.strip():
        raise ValueError("讲解为空")
    return tr, ex


def explain_sentences(
    chapter: Chapter,
    complete_fn,
    out_dir: str,
    quality: QualityReport,
    strategy: str,
    cancel=None,
    on_batch=None,
) -> None:
    """按 profile 讲解策略补讲解。strategy ∈ none/brief/deep。
    on_batch(done_in_chapter): 每 10 句回调一次 (UI 实时进度)。
    返回: 本章实际调用 LLM 处理的句数 (跳过的不计)。"""
    system = explain_system_for(strategy)
    if system is None:
        return 0  # 不讲: 所有句跳过

    processed = 0
    for i, s in enumerate(chapter.sentences):
        if cancel and cancel():
            raise EngineError("已取消", "explain")
        if "nlp" in s.failed_stages or "translate" in s.failed_stages:
            continue
        if not s.translation:
            continue
        if is_done_sentence(out_dir, chapter.index, i, "explanation"):
            continue
        try:
            try:
                tr, ex = _explain_one(complete_fn, system, i, s.original_text, EXPLAIN_MAX_TOKENS)
            except AidulcError:
                raise  # 模型加载/推理致命失败不当"输出格式问题"重试, 同 translate_batch_with_retry 的纪律
            except Exception:
                # 首次失败(多半是长讲解被 max_tokens 截断): 加大预算重试一次
                tr, ex = _explain_one(complete_fn, system, i, s.original_text, EXPLAIN_RETRY_MAX_TOKENS)
            s.explanation = ex
            if tr:
                s.translation = tr
            save_stage_result(out_dir, chapter.index, i, "explanation", ex)
            s.clear_failed_stage("explain")
            quality.record("explain", ok=True)
        except Exception as e:
            s.mark_failed("explain")
            save_stage_result(out_dir, chapter.index, i, "explanation", None, status="failed")
            quality.record("explain", ok=False)
            quality.add_failure(chapter.index, i, ["explain"], str(e))
        processed += 1
        if on_batch and processed % 10 == 0:
            on_batch(processed)
    if on_batch:
        on_batch(processed)
    return processed
