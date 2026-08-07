"""
pipeline/align.py —— 词级时间轴

路线 1 (Phase 0-A 实测选定): Kokoro TTS 自吐音素时长 → 词级时间轴, 成本 = 0。
本阶段只做校验 + 兜底映射, 不重算。

兜底 (route 2, 暂不实现): ctc-forced-aligner / whisper-cli base.en ——
只有当路线 1 在真实长文本上精度不达标才需要, Phase 4 DoD 先做人耳核对。
"""
from __future__ import annotations


def validate_timeline(words, audio_start_ms: int, audio_end_ms: int) -> list[str]:
    """校验词级时间轴与整句音频区间的**相对**一致性。
    词时间轴是句内相对 ms (Kokoro 输出从 0 开始), 音频区间是章节累计绝对 ms ——
    所以比较基准是句长 (end-start), 不是绝对起点 (Phase 4 端到端踩过: 用绝对起点
    会把所有词判成"早于上一词终点")。
    返回问题列表 (空 = 正常)。"""
    problems = []
    if not words:
        return problems  # 无时间轴 (如 partial 句) 不算错误
    sentence_len = audio_end_ms - audio_start_ms
    prev_end = 0  # 句内相对起点
    for w in words:
        word = getattr(w, "word", w.get("word", "") if isinstance(w, dict) else "?")
        if w.start_ms < prev_end - 50:  # 允许 50ms 重叠容差
            problems.append(f"词 {word} 起点 {w.start_ms} 早于上一词终点 {prev_end}")
        if w.end_ms < w.start_ms:
            problems.append(f"词 {word} 终点 {w.end_ms} 早于起点 {w.start_ms}")
        if w.end_ms > sentence_len + 200:
            problems.append(f"词 {word} 终点 {w.end_ms} 超出句长 {sentence_len}")
        prev_end = max(prev_end, w.end_ms)
    return problems


def check_segment_coverage(segments, words) -> list[int]:
    """检查每个非标点 segment 是否有对应时间轴。

    审查确认 (2026-08-04): 旧实现不检查覆盖率, 倒数第二句半句无词级高亮却 quality 全绿。
    返回缺失时间轴的非标点 segment 下标列表 (空 = 全覆盖)。
    """
    from aidulc_prep.core.word_alignment import _is_punct_like

    covered = set()
    for w in words:
        sidx = getattr(w, "seg_idx", w.get("seg_idx") if isinstance(w, dict) else None)
        if sidx is not None:
            covered.add(sidx)
    missing = []
    for i, seg in enumerate(segments):
        word = getattr(seg, "word", seg.get("word") if isinstance(seg, dict) else "")
        pos = getattr(seg, "pos", seg.get("pos") if isinstance(seg, dict) else "")
        if i in covered:
            continue
        if pos == "PUNCT" or _is_punct_like(word):
            continue
        missing.append(i)
    return missing
