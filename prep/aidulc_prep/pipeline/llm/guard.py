"""
pipeline/llm/guard.py —— echo 检测 + 整段错位检测 (3.5 静默失败防线)

- echo: batch.py 的 looks_untranslated 已在单行层检测, 这里是句子层 (讲解场景)
- 错位: 批次内原文/译文长度比值异常检测 (subgen 定位过的根因: 编号对齐骗过校验)
"""
from __future__ import annotations

# 译文/原文 字符比正常区间 (中文翻译通常比英文原文短或相近; 异常偏长/偏短可疑)
RATIO_MIN = 0.2
RATIO_MAX = 3.0


def check_length_ratio(original: str, translation: str, index: int) -> str | None:
    """返回可疑原因; None = 正常。"""
    o_len = len(original.strip())
    t_len = len(translation.strip())
    if o_len == 0 or t_len == 0:
        return f"第 {index} 行原文或译文为空"
    ratio = t_len / o_len
    if ratio < RATIO_MIN or ratio > RATIO_MAX:
        return f"第 {index} 行译文/原文长度比异常 ({ratio:.2f}, 原文 {o_len} 字符, 译文 {t_len} 字符)"
    return None


def check_batch_length_ratios(originals: list[str], translations: list[str]) -> list[str]:
    """批次级: 返回所有可疑行原因。"""
    problems = []
    for i, (o, t) in enumerate(zip(originals, translations)):
        reason = check_length_ratio(o, t, i + 1)
        if reason:
            problems.append(reason)
    return problems


def check_explain_echo(sentence: str, explanation: str) -> bool:
    """讲解整段抄原文? 覆盖 explanation 为英文原文拷贝的情况。"""
    # M 系列: echo 检测单一实现 (batch.py)
    from aidulc_prep.pipeline.llm.batch import looks_untranslated
    return looks_untranslated(sentence, explanation)


def guard_batch(originals: list[str], translations: list[str]) -> None:
    """批次防线: 错位检测 + echo 检测, 任一可疑抛 ValueError (触发对半重试)。
    单行不触发 (单行 echo 走 _retry_untranslated 的重试流, 避免双重处理)。
    ValueError 与 parse_numbered_response 同语义 = "输出格式问题可重试"; 而模型加载/推理
    失败是 AidulcError (EngineError/ModelError), 由 batch.translate_batch_with_retry 直接
    往上抛、不重试 —— 二者必须用不同异常类型区分 (P0: 否则模型死了每句被吞成"失败"还报成功)。"""
    from aidulc_prep.pipeline.llm.batch import looks_untranslated
    if len(originals) < 2:
        return
    problems = check_batch_length_ratios(originals, translations)
    for i, (o, t) in enumerate(zip(originals, translations)):
        if looks_untranslated(o, t):
            problems.append(f"第 {i + 1} 行是原文回显 (echo)")
    if problems:
        raise ValueError("批量输出可疑: " + "; ".join(problems[:5]))

