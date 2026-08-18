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


@dataclass
class Notice:
    """不是失败, 但值得记一笔的事件 (如 checkpoint 位置冲突后强制重跑)。

    2026-08-18: 独立于 failed_sentences 的通道。此前 nlp_realign 走的是
    add_failure, 结果 10 本书的成品里 failedSentences 被放大到几十倍
    (Wild Robot 9023 条里 8784 条是 realign, 真实失败只有 30 条), 而三个
    消费方都直接读 len(failedSentences) —— 用户看到的失败数完全不可信。
    """

    chapter: int
    index: int
    kind: str
    reason: str = ""


class QualityReport:
    def __init__(self) -> None:
        self.stages: dict[str, StageStats] = {}
        self.failed_sentences: list[FailedSentence] = []
        self.notices: list[Notice] = []

    def record(self, stage: str, ok: bool):
        st = self.stages.setdefault(stage, StageStats())
        if ok:
            st.done += 1
        else:
            st.failed += 1

    def add_failure(self, chapter: int, index: int, stages: list[str], reason: str):
        self.failed_sentences.append(FailedSentence(chapter=chapter, index=index, stages=stages, reason=reason))

    def add_notice(self, chapter: int, index: int, kind: str, reason: str = ""):
        self.notices.append(Notice(chapter=chapter, index=index, kind=kind, reason=reason))

    def notice_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for n in self.notices:
            counts[n.kind] = counts.get(n.kind, 0) + 1
        return counts

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
            "notices": [
                {"chapter": n.chapter, "index": n.index, "kind": n.kind, "reason": n.reason}
                for n in self.notices
            ],
            "noticeCounts": self.notice_counts(),
            "summary": self._summary(),
        }

    def _summary(self) -> str:
        n = len(self.failed_sentences)
        if n == 0:
            head = "全部句子成功。"
        else:
            stages = sorted({s for f in self.failed_sentences for s in f.stages})
            head = f"{n} 句有部分阶段失败 ({', '.join(stages)})。"
        # notices 是正常事件, 只作补充说明, 绝不并进失败计数 (见 Notice 的说明)
        realign = self.notice_counts().get("realign", 0)
        if realign:
            head += f" 另有 {realign} 句因原文变化重新对齐(正常, 非失败)。"
        return head
