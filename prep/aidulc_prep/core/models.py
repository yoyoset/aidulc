"""
core/models.py —— 无 I/O 的领域模型 (纯数据结构, 无外部依赖)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

SentenceStatus = Literal["ok", "partial", "failed"]

# aidu POS 枚举 (golden fixture 同步)
AIDU_POS = ["NOUN", "VERB", "ADJ", "ADV", "PRON", "PREP", "CONJ", "PART", "INTJ", "DET", "NUM", "PUNCT", "STOP"]


@dataclass
class Segment:
    """segments 数组元素 [word, POS, lemma] (aidu SENTENCE_SCHEMA.segments)"""
    word: str
    pos: str
    lemma: str

    def to_list(self) -> list[str]:
        return [self.word, self.pos, self.lemma]


@dataclass
class PhrasalVerb:
    """phrasal_verbs 数组元素 (aidu PHRASAL_VERB_SCHEMA)"""
    text: str
    indices: list[int] = field(default_factory=list)
    lemma: str = ""
    translation: str = ""


@dataclass
class WordTiming:
    """words 数组元素 (aidulc 新增, seg_idx 指向 segments 下标)"""
    seg_idx: int
    start_ms: int
    end_ms: int


@dataclass
class SentenceAudio:
    chapter: int
    start_ms: int
    end_ms: int


# M 系列: 失败语义单一事实源 (checkpoint.py 引用, 不再各自维护)
# 翻译/分词失败 → 整句 failed; 其余 → partial (句子仍有译文可读, 可重试)
# 只含阶段名 (translate/nlp), 与 mark_failed 的 stage 参数一致; checkpoint 字段名
# (translation/explanation/audio/words) 由 checkpoint.FIELD_TO_STAGE 映射回阶段名。
FATAL_STAGES = frozenset({"translate", "nlp"})


@dataclass
class Sentence:
    original_text: str
    segments: list[Segment] = field(default_factory=list)
    translation: str = ""
    explanation: str = ""
    phrasal_verbs: list[PhrasalVerb] = field(default_factory=list)
    audio: SentenceAudio | None = None
    words: list[WordTiming] = field(default_factory=list)
    status: SentenceStatus = "ok"
    failed_stages: list[str] = field(default_factory=list)

    def mark_failed(self, stage: str):
        """stage ∈ {nlp, translate, explain, tts, align}。fatal 阶段 → failed, 其余 → partial。"""
        if stage not in self.failed_stages:
            self.failed_stages.append(stage)
        if stage in FATAL_STAGES:
            self.status = "failed"
        elif self.status != "failed":
            self.status = "partial"

    def clear_failed_stage(self, stage: str):
        """某阶段成功后从失败清单移除并重算状态 (重试失败句的核心: 失败可恢复)。

        之前 save_stage_result 成功后从不清理 failedStages, 导致翻译失败的句子重跑成功后
        仍粘着 status="failed"、failedStages=["translate"], explain/tts 继续跳过它 ——
        这就是"重试失败句失效"的根因之一 (审查确认)。"""
        if stage in self.failed_stages:
            self.failed_stages.remove(stage)
        self._recompute_status()

    def _recompute_status(self):
        if any(s in FATAL_STAGES for s in self.failed_stages):
            self.status = "failed"
        elif self.failed_stages:
            self.status = "partial"
        else:
            self.status = "ok"


@dataclass
class ChapterImage:
    """原书插图 (R4, 2026-08-08): at = 渲染在第 at 句之前 (句下标); file = 书包内相对路径"""
    file: str
    at: int


@dataclass
class Chapter:
    index: int
    title: str
    sentences: list[Sentence] = field(default_factory=list)
    audio_file: str = ""
    images: list[ChapterImage] = field(default_factory=list)


@dataclass
class Book:
    title: str
    chapters: list[Chapter] = field(default_factory=list)

    @property
    def sentence_count(self) -> int:
        return sum(len(ch.sentences) for ch in self.chapters)
