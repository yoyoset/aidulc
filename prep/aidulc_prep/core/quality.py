"""
core/quality.py —— QualityReport 累积器 (失败句 / 原因分类 / 各阶段成功率)
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class StageStats:
    done: int = 0
    failed: int = 0

    @property
    def success_rate(self) -> float:
        total = self.done + self.failed
        return round(self.done / total, 3) if total else 1.0


@dataclass
class FailedSentence:
    chapter: int
    index: int
    stages: list[str] = field(default_factory=list)
    reason: str = ""


class QualityReport:
    def __init__(self) -> None:
        self.stages: dict[str, StageStats] = {}
        self.failed_sentences: list[FailedSentence] = []

    def record(self, stage: str, ok: bool):
        st = self.stages.setdefault(stage, StageStats())
        if ok:
            st.done += 1
        else:
            st.failed += 1

    def add_failure(self, chapter: int, index: int, stages: list[str], reason: str):
        self.failed_sentences.append(FailedSentence(chapter=chapter, index=index, stages=stages, reason=reason))

    def to_dict(self) -> dict:
        return {
            "stages": {
                k: {"done": v.done, "failed": v.failed, "successRate": v.success_rate}
                for k, v in sorted(self.stages.items())
            },
            "failedSentences": [
                {"chapter": f.chapter, "index": f.index, "stages": f.stages, "reason": f.reason}
                for f in self.failed_sentences
            ],
            "summary": self._summary(),
        }

    def _summary(self) -> str:
        n = len(self.failed_sentences)
        if n == 0:
            return "全部句子成功。"
        stages = sorted({s for f in self.failed_sentences for s in f.stages})
        return f"{n} 句有部分阶段失败 ({', '.join(stages)})。"
