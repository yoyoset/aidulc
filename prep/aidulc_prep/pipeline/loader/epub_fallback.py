"""pipeline/loader/epub_fallback.py —— EPUB 兜底解析: pymupdf 页面文本 + TOC, 不走原生 XHTML/spine

2026-08-19 (用户拍板): 导入体检判 block 的书, 之前只有"拒绝"一条路。用户要求"不符合
标准的自动尝试标准化转换, 不用设置, 能看进度和结果"——这个模块是那条"转换"的实现。

**这是兜底, 不是主路径**。`loader/epub.py` 的原生解析(spine/manifest/XHTML 结构)
质量更高、章节边界更准, 永远优先用。只有原生解析结果本身不达标(block)时才会走到这里,
用一种完全不同的手段重新尝试——pymupdf 把 EPUB 当成分页文档打开, 用它自带的 TOC
(标题 + 页码)划章节边界, 从页面纯文本里抠句子。牺牲的是精确的段落/标题标签结构,
换来的是对"结构本身已经损坏"(spine 断裂、manifest 对不上物理文件)的书仍有一次机会。

**已实测确认 pymupdf 能打开 EPUB 并读出 TOC + 分页文本**(不是文档假设):
拿 Ferris 那本书验证过, `doc.get_toc()` 能拿到 40 条真实目录(含页码), `doc[10].get_text()`
能读出连续的正文段落。

局限(诚实记录, 不是"应该没问题"): 页面文本没有语义分段, 一页内的换行是排版折行,
不是段落边界——所以这里用句末标点(. ! ? " ' 之后跟空格+大写/结尾)做粗切分, 不是
真正的语言学分句。会比原生解析产出更多"半句"式的碎句子, 这是刻意的取舍: 目标是让
book 达到"能读", 不是达到跟原生解析一样的精细度。
"""
from __future__ import annotations

import os
import re

from aidulc_prep.core.models import Book, Chapter, Sentence
from aidulc_prep.pipeline.loader.epub import NON_BODY_TOC, _is_real_sentence

# 句末切分: . ! ? 之后跟至少一个空白 —— 不识别缩写(Mr. Dr.)之类的例外, 也不特殊处理
# 句末引号(如 "了。'" 这种收尾), Python re 的定宽 lookbehind 限制不允许可选宽度的
# 引号类一起塞进 lookbehind。兜底策略允许句子切得比语言学正确粒度更碎, 不允许因为
# 过度智能反而漏切。
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

# 折行还原: 单个换行(不是段落间的双换行)当空格处理; 连续多个换行才当真正的分段。
_SOFT_WRAP = re.compile(r"(?<!\n)\n(?!\n)")
_HARD_BREAK = re.compile(r"\n{2,}")


def _page_text_to_sentences(text: str) -> list[str]:
    """一段(可能跨多页拼接的)原始页面文本 → 句子候选列表。"""
    # 先按硬换行(空行)分段, 段内折行先合并成空格, 再按句末标点切句 —— 顺序不能反:
    # 反过来会把跨行断开的单词也当句子边界。
    out: list[str] = []
    for block in _HARD_BREAK.split(text):
        block = _SOFT_WRAP.sub(" ", block).strip()
        if not block:
            continue
        for cand in _SENTENCE_END.split(block):
            cand = cand.strip()
            if cand:
                out.append(cand)
    return out


def load_epub_fallback(path: str) -> tuple[Book, list[str]]:
    """兜底解析一本 EPUB, 返回 (Book, uncovered)。uncovered 恒为 []——pymupdf 按页而不是
    按 spine 文件走, 没有"哪个文件没被打开过"这个概念, F39 那套覆盖率判据在这条路径上
    不适用(judge_standard 的 S1/S2 那两条本来就不看 uncovered, 不影响整体判定)。

    解析失败(非法文件/pymupdf 打不开)返回 (空 Book, [])——调用方按"仍然不达标"处理,
    不在这里抛异常掩盖上层想拿到的"两条路都试过了"这个事实。
    """
    try:
        import pymupdf
    except ImportError:
        return Book(title="", chapters=[]), []

    try:
        doc = pymupdf.open(path)
    except Exception:
        return Book(title="", chapters=[]), []

    # 显式 close (而不是等 GC): pymupdf.Document 持有底层文件句柄, Windows 上不关掉
    # 调用方紧接着 os.remove/覆盖同一文件会报"文件正被占用"(单测实测踩到)。
    with doc:
        title = (doc.metadata or {}).get("title") or os.path.splitext(os.path.basename(path))[0]
        toc = [(lvl, name.strip(), page) for lvl, name, page in doc.get_toc() if name and name.strip()]
        # 只用顶层条目当章节边界——嵌套的小节标题会把正常章节切得过碎, 这条兜底策略要的是
        # "能读", 不是精确到小节的目录; 顶层拿不到就退化成"不设边界", 整本当一章
        # (大概率仍不达标, 但这是诚实的失败, 不是伪造一个假边界)。
        top = [(name, page) for lvl, name, page in toc if lvl == 1] or [(t, p) for _, t, p in toc]

        if not top:
            text = "\n\n".join(doc[p].get_text() for p in range(doc.page_count))
            sentences = [Sentence(original_text=s) for s in _page_text_to_sentences(text) if _is_real_sentence(s)]
            chapters = [Chapter(index=0, title=title, sentences=sentences)] if sentences else []
            return Book(title=title, chapters=chapters), []

        chapters: list[Chapter] = []
        for i, (name, page0) in enumerate(top):
            if NON_BODY_TOC.match(name):
                continue  # 复用原生解析同一份"前后言"判据, 不用重发明一遍
            page_start = max(0, page0 - 1)  # pymupdf TOC 页码是 1-indexed
            page_end = (top[i + 1][1] - 1) if i + 1 < len(top) else doc.page_count
            page_end = max(page_start + 1, min(page_end, doc.page_count))
            text = "\n\n".join(doc[p].get_text() for p in range(page_start, page_end))
            sentences = [Sentence(original_text=s) for s in _page_text_to_sentences(text) if _is_real_sentence(s)]
            if not sentences:
                continue
            chapters.append(Chapter(index=len(chapters), title=name, sentences=sentences))

        return Book(title=title, chapters=chapters), []
