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
FATAL_STAGES = frozenset({"translate", "nlp", "translation"})


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
        """stage ∈ {nlp, translate, explain, tts, align}"""
        if stage not in self.failed_stages:
            self.failed_stages.append(stage)
        if self.status == "ok":
            self.status = "partial"
        if stage in ("translate", "nlp"):
            # 翻译失败 = 整句无内容, 升为 failed; tts/align 失败句子仍有译文可读
            self.status = "failed"
        elif stage in ("explain", "tts", "align"):
            self.status = "partial" if self.status != "failed" else self.status


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
