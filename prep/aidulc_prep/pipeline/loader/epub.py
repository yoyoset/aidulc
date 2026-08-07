"""EPUB 解析: OPF spine + nav.xhtml TOC 划章节 (zipfile + 标准库, 无第三方依赖)

章节划分 (质量修复 3): 用 EPUB 自带的 nav.xhtml TOC 而非 spine 文件顺序。
- 真实章节标题 (如 "1. First Winter" / "Part I: 2000")
- 过滤非正文条目 (Cover/Title Page/Contents/Map/Range Map/Wolf Charts/References/Index)
"""
from __future__ import annotations

import os
import re
import zipfile
from xml.etree import ElementTree as ET

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, Sentence

NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xhtml": "http://www.w3.org/1999/xhtml",
}

# 非正文 TOC 条目 (封面/目录/地图/图表/索引/尾注/版权等 — 不该成为可读章节)
NON_BODY_TOC = re.compile(
    r"^(cover|title|table of contents|contents?|map|range map|wolf charts|charts?|references?|index|"
    r"notes?|endnotes?|source notes|bibliography|acknowledgements?|about the author|also by|"
    r"epigraph|colophon|copyright|dedication|"
    r"[ivxlcdm]{1,6}\b|\d{1,4}$)",
    re.I,
)


def _read_member(zf: zipfile.ZipFile, name: str) -> str:
    try:
        return zf.read(name).decode("utf-8", errors="replace")
    except KeyError:
        return ""


def _strip_tags(html: str) -> str:
    """粗剥 XHTML 标签 + 还原常见实体。标题 (h1-h6) 换行并标记为 HEADING 前缀, 段落以换行分隔。"""
    html = re.sub(r"<head.*?</head>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<style.*?</style>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<(h[1-6])[^>]*>", "\n[[HEADING]]", html, flags=re.I)
    html = re.sub(r"</(h[1-6])>", "\n", html, flags=re.I)
    html = re.sub(r"<[^>]+>", "\n", html)
    for ent, ch in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")]:
        html = html.replace(ent, ch)
    return html


def _parse_toc(nav_html: str) -> list[tuple[str, str]]:
    """解析 nav.xhtml 的 <nav epub:type="toc"> 链接: [(标题, href)]。
    兼容属性顺序不定 + 实体。"""
    toc: list[tuple[str, str]] = []
    for m in re.finditer(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', nav_html, re.S):
        href, text = m.group(1), m.group(2)
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"&#x2019;|&#8217;", "'", text)
        text = text.strip()
        if text and href:
            toc.append((text, href))
    return toc


def load_epub(path: str) -> Book:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise InputError("EPUB 文件损坏", str(e)) from e

    with zf:
        container = _read_member(zf, "META-INF/container.xml")
        m = re.search(r'full-path="([^"]+)"', container)
        if not m:
            raise InputError("EPUB 缺少 container.xml 或 rootfile 声明")
        opf_path = m.group(1)

        opf = _read_member(zf, opf_path)
        opf_dir = os.path.dirname(opf_path).replace("\\", "/")

        # 标题
        title = "Untitled"
        tm = re.search(r"<dc:title[^>]*>([^<]+)</dc:title>", opf, re.S)
        if tm:
            title = tm.group(1).strip()

        # spine 顺序 + manifest href → 物理文件
        # 兼容真实 EPUB: <item> 属性顺序不定 (实测 z-lib 是 href 在前 id 在后,
        # 旧正则硬编码 id 在前 → manifest 0 匹配 → "没有解析出任何章节")
        spine = re.findall(r'<itemref[^>]*idref="([^"]+)"', opf)
        manifest = {}
        for item in re.findall(r'<item[^>]*/?>', opf):
            mid = re.search(r'id="([^"]+)"', item)
            mhref = re.search(r'href="([^"]+)"', item)
            if mid and mhref:
                manifest[mid.group(1)] = mhref.group(1)
        files = [manifest.get(i) for i in spine if i in manifest]

        # 质量修复 3 (章节划分): 用 nav.xhtml TOC 划章节 (真实标题 + 过滤非正文)
        # 兼容 spine id 与 manifest id 不一致的书 (Wolf 21: spine=nav_00, manifest=nav_1)
        # → 直接从 manifest 里找 nav.xhtml (properties="nav"), 不依赖 spine 映射
        toc_items: list[tuple[str, str]] = []
        nav_file = None
        for item in re.findall(r'<item[^>]*/?>', opf):
            if 'properties="nav"' in item or 'properties="navigation"' in item:
                mhref = re.search(r'href="([^"]+)"', item)
                if mhref:
                    nav_file = mhref.group(1)
                    break
        if nav_file is None:
            # 兜底: 文件名含 nav 的条目
            for v in manifest.values():
                if v.lower().endswith("nav.xhtml"):
                    nav_file = v
                    break
        if nav_file:
            nav_full = f"{opf_dir}/{nav_file}" if opf_dir else nav_file
            toc_items = _parse_toc(_read_member(zf, nav_full))

        # 非正文条目过滤 + 去重 (多个 TOC 链接指向同文件取第一个标题)
        seen_files: set[str] = set()
        toc_filtered: list[tuple[str, str]] = []
        for text, href in toc_items:
            if NON_BODY_TOC.match(text.strip()):
                continue
            phys = href.split("#")[0]
            if not phys:
                continue
            if not os.path.isabs(phys) and not phys.startswith(opf_dir):
                phys = f"{opf_dir}/{phys}"
            if phys in seen_files:
                continue
            seen_files.add(phys)
            toc_filtered.append((text, phys))

        chapters: list[Chapter] = []
        if toc_filtered:
            # 用 TOC: 每章 = 一个 TOC 条目的文件内容
            for text, phys in toc_filtered:
                html = _read_member(zf, phys)
                raw_paras = [p.strip() for p in _strip_tags(html).split("\n") if p.strip()]
                paras = [p for p in raw_paras if not p.startswith("[[HEADING]]")]
                sentences = [Sentence(original_text=p) for p in paras if _is_real_sentence(p)]
                if sentences:
                    chapters.append(Chapter(index=len(chapters), title=text, sentences=sentences))
        else:
            # 无 TOC 兜底: 按 spine 顺序 (每文件一章)
            for f in files:
                if not f:
                    continue
                full = f"{opf_dir}/{f}" if opf_dir else f
                html = _read_member(zf, full)
                raw_paras = [p.strip() for p in _strip_tags(html).split("\n") if p.strip()]
                paras = [p for p in raw_paras if not p.startswith("[[HEADING]]")]
                heading = next((p[len("[[HEADING]]"):] for p in raw_paras if p.startswith("[[HEADING]]")), "")
                sentences = [Sentence(original_text=p) for p in paras if _is_real_sentence(p)]
                if sentences and not _looks_like_index(sentences):
                    chapters.append(Chapter(index=len(chapters), title=heading or f"Chapter {len(chapters) + 1}", sentences=sentences))

    if not chapters:
        raise InputError("EPUB 里没有解析出任何章节")
    return Book(title=title, chapters=chapters)


def _is_real_sentence(text: str) -> bool:
    """判断是否是可处理的真实句子 (过滤页码/单字符/无字母装饰/目录标记/段落碎片/人名残句)。"""
    # 段落续行碎片: 以 , ; — 开头 (EPUB 分页把首词丢了, Wolf 21 实测 10 处)
    if text[:1] in (",", ";", "—"):
        return False
    # 纯数字/符号 (页码, 章节号)
    if not any(c.isalpha() for c in text):
        return False
    # 字母数 < 3 (单字符、缩写残余)
    letters = sum(1 for c in text if c.isalpha())
    if letters < 3:
        return False
    # 纯数字+标点的"标题页码"如 "1." "2." 
    stripped = re.sub(r"[\d\s.,;:!?()\[\]\"']+", "", text)
    if not stripped:
        return False
    # 全大写短目录标记 (CONTENTS/FOREWORD/PROLOGUE/CHAPTER 等) — 非句子
    if text.isupper() and len(text) < 40:
        return False
    # 全大写短串 (如 "A" "HE" 已在上过滤; 这里兜底 2-3 字母缩写)
    if len(text) <= 2:
        return False
    # 质量修复 4 (Wolf 21 实测 55 失败句根源): 超短残句/人名/网址/纯数字
    # - ≤4 字符 (He/The/In/Jaws/May/June/255 — tts 合成无意义)
    if len(text) <= 4:
        return False
    # - 网址 (www.yellowstone.org/wolf-project,)
    if re.match(r"^www\.|^https?://", text, re.I):
        return False
    # - 裸域名 URL (mrjamesnestor.com/breath — Notes 尾注里大量出现)
    if re.match(r"^[\w-]+(\.[\w-]+)+\.[a-z]{2,}(/\S*)?$", text, re.I):
        return False
    # - 纯"名+姓"人名残句 (Tom Zieber / Diane Hargreaves — 讲解失败无意义)
    words = text.split()
    if 2 <= len(words) <= 3 and all(w[0].isupper() for w in words if w.isalpha()):
        return False
    # - 以 "." 结尾的残句碎片 (the park. / them. — nlp 拆句残留)
    if len(text) < 12 and text.endswith(".") and not text[0].isupper():
        return False
    return True


def _looks_like_index(sentences: list) -> bool:
    """索引/参考文献页检测 (Wolf 21 实测: 书末 872 句索引全部翻译失败)。
    特征: 多数句子以 ';' ',' '—' '→' 或 '数字:' 开头 (索引条目续行), 或 ≤4 词。
    整章命中即跳过。"""
    if len(sentences) < 20:
        return False
    frag = 0
    for s in sentences:
        t = s.original_text.strip()
        # 索引条目: 以分隔符/页码开头 或 极短 (≤4 词无句点)
        if t[:1] in (";", ",", "—", "→") or re.match(r"^\d+[.:]?\s", t):
            frag += 1
        elif len(t.split()) <= 4 and not t.endswith((".", "!", "?", "\"")):
            frag += 1
    return frag / len(sentences) > 0.5
