"""PDF / mobi / azw3 / fb2 解析: PyMuPDF (懒加载, 侧车运行时可选依赖)

2026-08-08 (R3.2): 原来是纯 PDF, 扩展成通用 MuPDF 加载器——MuPDF 引擎原生支持
PDF/EPUB/MOBI/AZW3/FB2/XPS/CBZ, 一个依赖覆盖 EPUB 原生解析不了的格式面。
PDF 与这些格式的正文抽法相同 (按页 get_text), 统一走这里。

懒加载纪律: fitz 不在包里时不给用户报 PyInstaller 内部错误, 而是明确提示
"需要 PyMuPDF"。prep/pyproject.toml 的 optional-dependencies 声明了它, 前端
组件健康页可一键安装。
"""
from __future__ import annotations

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, Sentence


def load_pdf(path: str) -> Book:
    """解析 PDF / mobi / azw3 / fb2 (按扩展名不区分, 交给 fitz 自己认)。"""
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise InputError(
            "文档解析器 (PyMuPDF) 未安装",
            "在'组件与模型'页安装 PyMuPDF, 或 `pip install pymupdf`",
        ) from e
    try:
        doc = fitz.open(path)
    except Exception as e:
        raise InputError("文档无法打开 (可能是加密或损坏)", str(e)) from e
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
        raise InputError("文档里没有解析出任何文本 (可能是扫描版)")
    return Book(title=path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1], chapters=chapters)
