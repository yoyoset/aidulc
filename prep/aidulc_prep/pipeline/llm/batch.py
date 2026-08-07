"""
pipeline/llm/batch.py —— 批量编号对齐 + 对半拆分重试 (移植 subgen translate/prompt.rs)

三个纯函数, 无 I/O, 全部可单测:
- parse_numbered_response: 解析 "1. 译文\n2. 译文..." → 列表; 行数/连续性不符报错
- translate_batch_with_retry: 失败/错位递归对半重试, 单行失败兜底标记
- build_prompt: 编号批量提示词
"""
from __future__ import annotations

import re
from collections import OrderedDict

BATCH_SIZE = 15  # 与 subgen 生产一致 (真实模型实测过 15 行内稳定)
MAX_TOKENS_PER_LINE = 100
MAX_TOKENS_CAP = 4096

TRANSLATE_SYSTEM = (
    "你是专业的字幕翻译员。将用户给出的带编号英文文本逐行翻译成简体中文。要求:"
    "逐行对应翻译, 严格保留原有的\"编号.\"格式, 每行只输出一条译文, 不要合并或拆分行, "
    "不要添加编号之外的任何解释、注释或原文。即使某一行看起来意思不完整, 也只翻译这一行"
    "本身给出的文字, 不要补全整句。"
)


def parse_numbered_response(content: str, expected: int) -> list[str]:
    """解析 "1. 译文" / "1、译文" / "1) 译文" 行。行数或编号连续性不符 → ValueError。"""
    mapping: OrderedDict[int, str] = OrderedDict()
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        num, rest = split_leading_number(line)
        if num is None:
            continue
        mapping[num] = rest
    if len(mapping) != expected:
        raise ValueError(f"翻译输出行数不匹配(期望 {expected}, 实际 {len(mapping)})")
    out = []
    for i in range(1, expected + 1):
        if i not in mapping:
            raise ValueError(f"翻译输出缺少第 {i} 行")
        out.append(mapping[i])
    return out


def split_leading_number(line: str) -> tuple[int | None, str]:
    m = re.match(r"^(\d+)\s*(?:[.、)）]\s*)(.*)$", line)
    if not m:
        return None, line
    return int(m.group(1)), m.group(2)


def looks_untranslated(original: str, translated: str) -> bool:
    """整行原样抄回 (echo 检测, 照抄 comic-gen _ECHO_MARKERS 的思路, subgen 的实现)。"""
    has_letters = any(c.isalpha() for c in original)
    return has_letters and original.strip().casefold() == translated.strip().casefold()


def translate_batch_with_retry(
    complete_fn,
    texts: list[str],
    system: str = TRANSLATE_SYSTEM,
    temperature: float = 0.2,
) -> tuple[list[str], list[int]]:
    """批量翻译 + 对半重试。complete_fn(messages) → str。
    返回 (results, failed_indices)。失败行的 results 保留原文, failed_indices 记录下标。"""
    if not texts:
        return [], []
    try:
        results = _translate_batch_once(complete_fn, texts, system, temperature)
        if len(results) == len(texts):
            return _retry_untranslated(complete_fn, texts, results, system, temperature)
        raise ValueError("行数不匹配")
    except Exception:
        if len(texts) == 1:
            return [texts[0]], [0]
        mid = len(texts) // 2
        out_l, failed_l = translate_batch_with_retry(complete_fn, texts[:mid], system, temperature)
        out_r, failed_r = translate_batch_with_retry(complete_fn, texts[mid:], system, temperature)
        return out_l + out_r, failed_l + [i + mid for i in failed_r]


def _translate_batch_once(complete_fn, texts: list[str], system: str, temperature: float) -> list[str]:
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts))
    content = complete_fn([
        {"role": "system", "content": system},
        {"role": "user", "content": numbered},
    ])
    results = parse_numbered_response(content, len(texts))
    # M 系列: 接线 guard 防线 (错位/echo 整体检查, 触发对半重试)
    try:
        from aidulc_prep.pipeline.llm.guard import guard_batch
        guard_batch(texts, results)
    except Exception:
        raise  # EngineError → translate_batch_with_retry 捕获 → 对半重试
    return results


def _retry_untranslated(complete_fn, texts, results, system, temperature):
    """echo 命中的行单独重试一次 (subgen 实测: 很多时候脱离同批干扰单独喂反而能翻对)。"""
    suspects = [i for i, (t, r) in enumerate(zip(texts, results)) if looks_untranslated(t, r)]
    if not suspects:
        return results, []
    still_failed = []
    for i in suspects:
        try:
            single = _translate_batch_once(complete_fn, [texts[i]], system, temperature)
            if len(single) == 1 and not looks_untranslated(texts[i], single[0]):
                results[i] = single[0]
            else:
                still_failed.append(i)
        except Exception:
            still_failed.append(i)
    return results, still_failed
