"""PDF 解析: PyMuPDF (懒加载, 侧车运行时依赖)"""
from __future__ import annotations

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, Sentence


def load_pdf(path: str) -> Book:
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise InputError("PDF 解析需要 PyMuPDF", "pip install pymupdf") from e
    try:
        doc = fitz.open(path)
    except Exception as e:
        raise InputError("PDF 无法打开 (可能是加密或损坏)", str(e)) from e
    chapters: list[Chapter] = []
    for page in doc:
        text = page.get_text("text").strip()
        if not text:
            continue
        paras = [p.strip() for p in text.split("\n") if p.strip()]
        sentences = [Sentence(original_text=p) for p in paras]
        chapters.append(Chapter(index=len(chapters), title=f"Page {len(chapters) + 1}", sentences=sentences))
    doc.close()
    if not chapters:
        raise InputError("PDF 里没有解析出任何文本 (可能是扫描版)")
    return Book(title=path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1], chapters=chapters)
