"""
pipeline/loader/txt.py —— TXT 加载 (M 系列: 从 __init__ 分发器归位, 一格式一模块)

按空行分隔的段落聚合为章节: 每 8 段一章 (TXT 无结构时的最简策略)。
"""
from __future__ import annotations

import os

from aidulc_prep.core.models import Book, Chapter, Sentence

PARAS_PER_CHAPTER = 8


def load_txt(path: str) -> Book:
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    title = os.path.splitext(os.path.basename(path))[0]
    chapters = split_txt_into_chapters(text, title)
    return Book(title=title, chapters=chapters)


def split_txt_into_chapters(text: str, title: str) -> list[Chapter]:
    """纯函数, 可单测。空文本 → 单个空章 (保持原行为)。"""
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chapters: list[Chapter] = []
    for i in range(0, len(paras), PARAS_PER_CHAPTER):
        chunk = paras[i:i + PARAS_PER_CHAPTER]
        sentences = [Sentence(original_text=p) for p in chunk]
        chapters.append(Chapter(index=len(chapters), title=f"Section {len(chapters) + 1}", sentences=sentences))
    if not chapters:
        chapters.append(Chapter(index=0, title=title or "Book", sentences=[]))
    return chapters
