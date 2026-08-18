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
    # 宽松兜底 (2026-08-18): 严格 JSON 解析救不回来时, 直接按字段名把值抠出来。
    # 实测根因是模型在字符串值里塞了未转义的双引号 —— 主要来源(复述 original_text)
    # 已经从提示词里去掉, 这里兜住剩下的情况: 允许 translation/explanation 的值内部
    # 含裸引号, 用"下一个字段名"或"对象结尾"当右边界, 而不是用第一个引号。
    loose = _loose_extract(cleaned)
    if loose:
        return loose
    raise ValueError("讲解 JSON 解析失败")


_LOOSE_TR = re.compile(r'"translation"\s*:\s*"(.*?)"\s*,\s*"explanation"\s*:', re.S)
# 收尾的 `"` 是**必须**的: 它区分"完整但有裸引号"(该救)和"被截断"(该重试)。
# 贪婪 .* 让它吃到最后一个引号, 所以值内部的裸引号不会提前截断; 而截断的输出末尾
# 没有收尾引号, 直接不匹配 → 交回上层走 EXPLAIN_RETRY_MAX_TOKENS 重试。
# (这一条是既有测试 test_truncated_first_attempt_retries_with_bigger_budget 抓出来的:
#  第一版兜底把半截讲解也"救"了回来, 等于静默产出残缺内容, 比失败更糟。)
_LOOSE_EX = re.compile(r'"explanation"\s*:\s*"(.*)"\s*\}?\s*$', re.S)


def _loose_extract(text: str) -> tuple[str, str] | None:
    """按字段名抠值 (容忍值里的裸引号)。抠不到讲解就返回 None, 交回上层判失败。"""
    ex_m = _LOOSE_EX.search(text)
    if not ex_m:
        return None
    ex = ex_m.group(1).strip().rstrip('"').strip()
    if not ex:
        return None
    tr_m = _LOOSE_TR.search(text)
    tr = tr_m.group(1).strip() if tr_m else ""
    return tr, ex


# 2026-08-18 (第三轮重跑实测): 40064 句里 translate 只失败 5 条, 逐条看原文是
#   'LBYR.com' / 'Twitter.com/LittleBrownYR' / 'v 1.0 HTML' / 'Clickety clickety click!'
# —— 出版社 URL、版本号、拟声词。模型原样回显被判"翻译失败/回显", 判定本身没错, 但
# 前三类句子永远不会成功, 每次重跑都重试一遍并常驻失败清单。和 K33 定的"主动跳过要
# 记成跳过、不能记成失败"是同一条规矩, 所以走 notice 通道。
#
# 全语料实测本函数命中 13 条, 全部是出版社页脚的 URL 和一条版本号, 零误伤。
# 拟声词那类**没有**纳入 —— 理由见下。
#
# **试过并证伪的一条规则**: "整句由同一个词重复构成 → 拟声词 → 不可翻译"。
# 拿 40064 句全语料实测, 命中 69 条, **其中 64 条当前已经有正常译文** —— 逐条看绝大
# 多数是有实义的对话: "No! No!" / "There, there." / "Hello, hello?" / "Stop! stop!" /
# "Wait wait wait!" / "Food! Food!" / "Mama! Mama!" / "Quickly, quickly."。真正的拟声词
# (Tat-tat / Clickety / Bee-bee-bee / Blah blah)是少数, 且没有可靠特征把两者分开。
# 这条规则会把 64 句已经翻译成功的正常对话挡在翻译之外, 比它要解决的问题(5 条永久
# 失败)严重一个量级。删掉, 只保留 URL / 版本号 / 无字母这三条零误报的规则。
#
# 判定刻意保守: 只认"整句都没有可翻译内容"的情况。带 URL 的正常句子
# (如 'Visit LBYR.com for more.') 必须判 False —— 宁可漏判也不能把正常句子挡掉。
_URLISH = re.compile(r"^(?:https?://|www\.)?[\w.-]+\.(?:com|net|org|edu|gov|io|co|uk)(?:/\S*)?$", re.I)
_VERSIONISH = re.compile(r"^v?\s*\d+(?:\.\d+)+\s*[A-Za-z]*$")
_WORD = re.compile(r"[A-Za-z]")


def is_untranslatable(text: str) -> bool:
    """整句没有可翻译内容 → 跳过翻译(记 notice, 不记 failed)。保守判定。"""
    t = (text or "").strip()
    if not t:
        return False
    if _URLISH.match(t) or _VERSIONISH.match(t):
        return True
    if not _WORD.search(t):
        return True  # 一个字母都没有: 纯符号/纯数字
    return False


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
        if not s.original_text.strip():
            continue
        if is_untranslatable(s.original_text):
            # 跳过而不是失败: 见 is_untranslatable 上方的说明
            quality.add_notice(
                chapter.index, i, "untranslatable",
                f"原文无可翻译内容, 已跳过: {s.original_text.strip()[:40]}",
            )
            continue
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


def _explain_one(
    complete_fn, system: str, i: int, original_text: str, max_tokens: int,
    chapter_index: int = -1, attempt: int = 1,
) -> tuple[str, str]:
    """单次调用 + 解析 + guard 校验。失败抛异常(ValueError 或底层 EngineError 等)。
    chapter_index/attempt 只用于性能探针日志, 不影响调用逻辑。"""
    import time
    t0 = time.perf_counter()
    content = complete_fn([
        {"role": "system", "content": system},
        {"role": "user", "content": f"[{i}] {original_text}"},
    ], max_tokens=max_tokens)
    elapsed = time.perf_counter() - t0
    # 性能探针 (2026-08-15): attempt=2 是重试(EXPLAIN_RETRY_MAX_TOKENS), 单独看出
    # "重试拖慢了多少" —— 跟 translate 那条放一起 grep 就能比出两个阶段耗时差距。
    import logging
    from aidulc_prep.infra.timing import format_timing_line
    logging.getLogger("aidulc").info(format_timing_line(
        "explain", elapsed, chapter=chapter_index, sentence=i, attempt=attempt, max_tokens=max_tokens,
    ))
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
    max_chars: int | None = None,
    min_sentence_chars: int = 0,
) -> None:
    """按 profile 讲解策略补讲解。strategy ∈ none/brief/deep。
    on_batch(done_in_chapter): 每 10 句回调一次 (UI 实时进度)。
    max_chars: K33 讲解字数上限, 拼进提示词(见 prompt.py::explain_system_for)。
    min_sentence_chars: K33 讲解触发门槛, 原文长度低于此值的句子直接跳过不讲解
    (跳过不落 checkpoint、不计入 quality——是"这句不需要讲", 不是"讲解失败";
    runner.py::_explain 的完整性校验要把这类跳过一并排除在 expected 分母之外,
    否则会被误判成"循环漏跑"报错, 见那边的调用点注释)。
    返回: 本章实际调用 LLM 处理的句数 (跳过的不计)。"""
    system = explain_system_for(strategy, max_chars=max_chars)
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
        if min_sentence_chars and len(s.original_text.strip()) < min_sentence_chars:
            continue  # K33: 原文太短, 不值得讲(比如"Crack!"这类拟声词/极短句)
        try:
            try:
                tr, ex = _explain_one(complete_fn, system, i, s.original_text, EXPLAIN_MAX_TOKENS,
                                       chapter_index=chapter.index, attempt=1)
            except AidulcError:
                raise  # 模型加载/推理致命失败不当"输出格式问题"重试, 同 translate_batch_with_retry 的纪律
            except Exception:
                # 首次失败(多半是长讲解被 max_tokens 截断): 加大预算重试一次
                tr, ex = _explain_one(complete_fn, system, i, s.original_text, EXPLAIN_RETRY_MAX_TOKENS,
                                       chapter_index=chapter.index, attempt=2)
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
