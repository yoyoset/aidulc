"""
pipeline/loader/__init__.py —— 按扩展名分发: epub → epub.py, pdf → pdf.py, txt → txt.py

产出: Book(title, chapters=[Chapter(index, title, sentences=[Sentence(original_text)])])
      —— 此时句子只有 original_text (nlp 阶段才填 segments)。
"""
from __future__ import annotations

import os

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book

SUPPORTED_EXT = {".epub", ".pdf", ".txt"}


def load_book(path: str) -> Book:
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_EXT:
        raise InputError(f"不支持的文件格式: {ext}", f"仅支持 {sorted(SUPPORTED_EXT)}")
    if not os.path.exists(path):
        raise InputError(f"文件不存在: {path}")
    if ext == ".epub":
        from aidulc_prep.pipeline.loader.epub import load_epub
        return load_epub(path)
    if ext == ".pdf":
        from aidulc_prep.pipeline.loader.pdf import load_pdf
        return load_pdf(path)
    # M 系列: txt 归位 txt.py (一格式一模块)
    from aidulc_prep.pipeline.loader.txt import load_txt
    return load_txt(path)
