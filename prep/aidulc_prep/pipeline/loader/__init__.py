"""
pipeline/loader/__init__.py —— 按扩展名分发: epub → epub.py, pdf → pdf.py, txt → txt.py

格式策略 (R3.2, 2026-08-08):
- epub: 原生解析 (零依赖, 段落保真度最好) —— nav.xhtml + toc.ncx + [[HEADING]] 二次切分
- pdf/mobi/azw3/fb2: PyMuPDF 兜底 (MuPDF 引擎一个依赖覆盖, 懒加载, 缺失给人话提示)
- txt: 原生

产出: Book(title, chapters=[Chapter(index, title, sentences=[Sentence(original_text)])])
      —— 此时句子只有 original_text (nlp 阶段才填 segments)。
"""
from __future__ import annotations

import os

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book

SUPPORTED_EXT = {".epub", ".pdf", ".txt", ".mobi", ".azw3", ".fb2"}
# PyMuPDF 兜底格式 (fitz 直接打开, 扩展名不区分)
MUPDF_EXT = {".pdf", ".mobi", ".azw3", ".fb2"}


def load_book(path: str) -> Book:
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_EXT:
        raise InputError(f"不支持的文件格式: {ext}", f"仅支持 {sorted(SUPPORTED_EXT)}")
    if not os.path.exists(path):
        raise InputError(f"文件不存在: {path}")
    if ext == ".epub":
        from aidulc_prep.pipeline.loader.epub import load_epub
        return load_epub(path)
    if ext in MUPDF_EXT:
        from aidulc_prep.pipeline.loader.pdf import load_pdf
        return load_pdf(path)
    # M 系列: txt 归位 txt.py (一格式一模块)
    from aidulc_prep.pipeline.loader.txt import load_txt
    return load_txt(path)
