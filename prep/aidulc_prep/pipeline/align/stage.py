"""
pipeline/align/stage.py —— 对齐校验阶段 (M 系列: 从 runner.py 提取)

职责: 逐句校验时间轴/词覆盖, 记 quality。纯校验无产物落盘。
模式与 llm/tts/nlp stage 一致。
"""
from __future__ import annotations

from aidulc_prep.core.models import Book
from aidulc_prep.core.quality import QualityReport


def run_align_stage(book: Book, quality: QualityReport, cancel=None) -> None:
    """对齐阶段: 校验 word 时间轴 + 词覆盖。"""
    from aidulc_prep.pipeline.align import check_segment_coverage, validate_timeline

    for ch in book.chapters:
        if cancel and cancel():
            return
        for i, s in enumerate(ch.sentences):
            if s.audio is None:
                continue
            problems = validate_timeline(s.words, s.audio.start_ms, s.audio.end_ms)
            missing = check_segment_coverage(s.segments, s.words)
            if missing:
                problems.append(f"{len(missing)} 个词无时间轴: " + ", ".join(
                    s.segments[u].word for u in missing[:10]
                ))
            if problems:
                quality.record("align", ok=False)
                quality.add_failure(ch.index, i, ["align"], "; ".join(problems))
            else:
                quality.record("align", ok=True)
