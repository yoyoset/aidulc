"""EPUB 解析: OPF spine + nav.xhtml TOC 划章节 (zipfile + 标准库, 无第三方依赖)

章节划分 (质量修复 3): 用 EPUB 自带的 nav.xhtml TOC 而非 spine 文件顺序。
- 真实章节标题 (如 "1. First Winter" / "Part I: 2000")
- 过滤非正文条目 (Cover/Title Page/Contents/Map/Range Map/Wolf Charts/References/Index)
"""
from __future__ import annotations

import logging
import os
import re
import zipfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, ChapterImage, Sentence

NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
}

# 非正文 TOC 条目 (封面/目录/地图/图表/索引/尾注/版权等, 以及出版社宣传性尾页——
# 花絮/致谢/书评摘录/其它书预告/讨论指南等—— 都不该成为可读章节)
NON_BODY_TOC = re.compile(
    r"^(cover|title|table of contents|contents?|map|range map|wolf charts|charts?|references?|index|"
    r"notes?|endnotes?|source notes|bibliography|acknowledge?ments?|about the author|also by|"
    r"epigraph|colophon|copyright|dedication|a note about the story|behind the scenes|"
    r"discussion guide|praise for|a sneak peek|"
    r"[ivxlcdm]{1,6}\b)",
    re.I,
)
# 2026-08-18(用户报"导入一本书失败, 不是该转格式吗"追查出来的真根因): 原来这里还有
# 一条 `\d{1,4}$` —— 意图是拦掉索引页里"12" "45" 这类纯页码 TOC 条目, 但它同时会
# 匹配**任何纯数字的 TOC 标题**。实测撞见 Ferris(Kate DiCamillo): NCX 里 32 个真实
# 章节的 navLabel 就是裸数字 "1".."32"(这本书章节标题本来就不带"Chapter"前缀,
# c01.htm 正文以 "It was the summer..." 开头, 内容完整, 不是任何形式的残次书)。
# 这条正则把这 32 章全部当非正文页跳过, 只剩后附内容 1 章 15 句, 直接撞上 S3 阻断
# 阈值("解析结果过少"), 在导入这一步就被拒了——用户在界面上只看到"不达标", 看不出
# 真正原因是解析器自己的正则太宽, 不是书的问题。
#
# 删掉 `\d{1,4}$` 而不是收窄它: 索引页的纯页码是"逐句"出现在解析出的**句子**里,
# 已经有 _looks_like_index 在句子层面拦这类内容(见其 docstring, Wolf 21 872 句索引
# 实测), TOC 标题层面拦纯数字没有独立收益, 只有误伤面。

# 巨章判据: 单个 TOC 条目的文件解析出的候选句数 ≥ 此值 → 按文件内 h1-h6 二次切分。
# 背景 (2026-08-08, 银河系那本真实撞见): 有的书 TOC 条目对应一个超大 XHTML 文件,
# 整本正文都在里面 (老正则会解析出 5351 句的"巨章"), 文件内的 h1-h6 才是真实章节边界。
LARGE_FILE_SPLIT_THRESHOLD = 200

# 章节标题回退 (2026-08-16 实测): 既没有 TOC 条目、也从文件内容抽不出标题时的兜底。
# 之前是 f"Chapter {len(chapters)+1}" —— 这个数字是"这本书目前累计产出了多少章"
# 的位置计数, 不是书里真实的章节序号; 一旦跟同一本书里由 TOC/heading 提供的真实
# "CHAPTER N" 标题交替出现(实测 Wild Robot Boxed Set: 目录里 "17. Chapter 17" 后面
# 紧跟 "18. CHAPTER 16"), 两套编号体系互相打架, 读者会以为章节顺序乱了。
# 诊断过两类根因, 只有一类能修:
#   - Despereaux: <h1><img.../></h1>, 标题在源文件里就是纯装饰图片, 没有可提取的
#     文字, 无法恢复真实标题(54/56 章都是这种)。
#   - Hatchet: <h2><a><span>4</span></a></h2>, 标题文字确实存在但被嵌套标签跟
#     [[HEADING]] 标记拆成了不同行, 理论上可以用向后看几行、吸收短行拼回标题的
#     启发式抓回来——实测过这个启发式在 Number the Stars/Wild Robot 这类本来标题
#     就抽取正常的书上会误吞真实首段导致丢句(1008→1001/3924→3694), 风险和收益
#     不成比例, 这次不做, 只保底把回退文案改诚实, 不再假装成"Chapter N"。
_UNTITLED_CHAPTER = "(Untitled)"


def _norm_zip_path(p: str) -> str:
    """归一化 zip 内部路径: URL 解码(TOC/OPF 的 href 常是 URL 编码, 如 "Chapter%201.xhtml",
    但 zip 内真实成员名不编码, 如 "Chapter 1.xhtml" —— 不解码会导致路径比较失败、
    _read_member 静默读空、章节整个消失不报错, 2026-08-16 实测 Tuck Everlasting 一书因此
    丢失 95% 正文) + 去 ./ ../ 冗余段 + 统一 / 分隔 (物理键比较用)。"""
    p = unquote(p)
    parts: list[str] = []
    for seg in p.replace("\\", "/").split("/"):
        if seg in ("", "."):
            continue
        if seg == ".." and parts:
            parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts)


def _read_member(zf: zipfile.ZipFile, name: str) -> str:
    try:
        return zf.read(name).decode("utf-8", errors="replace")
    except KeyError:
        logging.getLogger("aidulc").warning("EPUB 内找不到文件: %s (可能是路径编码/解析问题)", name)
        return ""


# 行内标签 (2026-08-17 实测确认的真 bug): 这些标签出现在句子**中间**, 不是段落边界。
# 旧实现把所有标签一律换成换行, 于是带行内标记的句子被切碎、标记里的词被整个丢掉。
# 实测 Charlotte's Web 开篇名句:
#   输入 `"Where is Papa going with that <em>ax</em>?" said Fern to her mother...`
#   旧输出 ① `"Where is Papa going with that`  ② `?" said Fern to her mother...`
#   —— 一句变两个残句, 且 "ax" 从正文里彻底消失。
# 实测规模: 约 20% 的段落含行内标签(Charlotte's Web 30/148, Hatchet 34/159),
# 下游翻译/讲解/配音/对齐全都建立在这些残句上。
#
# 这也是 2026-08-16 为 Hatchet(`<h2><a><span>4</span></a></h2>` 标题抽不出来)
# 试过又放弃的那个"向后吸收下一行"启发式的正解 —— 那个方案是在猜, 这个是按 HTML
# 语义区分块级/行内, 顺带把 Frindle 21 章标题全是 'Nick' 的问题一并解决。
_INLINE_TAGS = (
    "a|span|em|strong|b|i|u|s|small|big|tt|font|sub|sup|code|cite|q|abbr|dfn"
    "|kbd|samp|var|mark|del|ins|ruby|rt|rp|bdi|bdo|nobr|time|data"
)
_INLINE_RE = re.compile(rf"</?(?:{_INLINE_TAGS})\b[^>]*>", re.I)

# 块级边界先用哨兵占位, 最后一步才换成换行。中间要把源码里的换行/缩进压成空格 ——
# 否则 calibre 那类把一个段落硬折成多行的 HTML, 就算行内标签处理对了, 段落仍会被
# 源码换行切碎。哨兵用 \x00: 正文里不可能出现, 且不被 \s 匹配, 压空白时不会被吃掉。
_BLOCK_MARK = "\x00"


def _strip_tags(html: str) -> str:
    """粗剥 XHTML 标签 + 还原常见实体。标题 (h1-h6) 换行并标记为 HEADING 前缀, 段落以换行分隔。

    R4 (2026-08-08): `<img>` 不再被剥成空行, 而是换行标成 `[[IMG:<src>]]` 记号,
    让 _file_sections 能保留图片在段落流中的位置 (at = 之前有多少句)。

    2026-08-17: 区分块级/行内标签 —— 行内标签去掉但不断行(见 _INLINE_TAGS 上方注释),
    块级标签才是段落边界; 段落内部的源码换行压成空格。"""
    html = re.sub(r"<head.*?</head>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<style.*?</style>", " ", html, flags=re.S | re.I)
    # 无 h1-h6 的整本书单文件兜底 (2026-08-16 实测 Frindle): 有的书(多见于 calibre
    # 转出的老 HTML)整本正文在一个文件里, 一个 h1-h6 都没有, 章节边界只体现在
    # `<p class="ChapterTitle">` 这类 class 命名上。没有这个兜底时大文件二次切分
    # 找不到任何边界, 整本退化成一个 675 句的巨章, 阅读器里无法按章导航。
    # 严格限定在"整个文件一个 h1-h6 都没有"时才启用 —— 有真标题的书走原路径,
    # 一行都不受影响, 因此不可能让已经正常的书退化。
    if not re.search(r"<h[1-6][\s>]", html, flags=re.I):
        html = re.sub(
            r'<(?:p|div)[^>]*\bclass\s*=\s*"[^"]*chapter[^"]*"[^>]*>',
            _BLOCK_MARK + "[[HEADING]]",
            html,
            flags=re.I,
        )
    html = re.sub(r"<(h[1-6])[^>]*>", _BLOCK_MARK + "[[HEADING]]", html, flags=re.I)
    html = re.sub(r"</(h[1-6])>", _BLOCK_MARK, html, flags=re.I)
    # <img src="..."> → [[IMG:src]] (单双引号都兼容; 无 src 的忽略)
    html = re.sub(r'<img[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*/?>',
                  _BLOCK_MARK + "[[IMG:\\1]]" + _BLOCK_MARK, html, flags=re.I)
    html = re.sub(r"<img[^>]*\bsrc\s*=\s*'([^']+)'[^>]*/?>",
                  _BLOCK_MARK + "[[IMG:\\1]]" + _BLOCK_MARK, html, flags=re.I)
    # 行内标签直接去掉(不断行), 其余标签(块级 + 未知)才是段落边界。
    # 未知标签保守当块级处理 —— 与旧行为一致, 只有明确列进 _INLINE_TAGS 的才改判。
    html = _INLINE_RE.sub("", html)
    html = re.sub(r"<[^>]+>", _BLOCK_MARK, html)
    for ent, ch in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")]:
        html = html.replace(ent, ch)
    # 段落内部的源码换行/缩进压成空格(哨兵不是空白字符, 不会被吃掉), 最后还原成换行
    html = re.sub(r"\s+", " ", html)
    return html.replace(_BLOCK_MARK, "\n")


_IMG_MARKER = re.compile(r"^\[\[IMG:(.+?)\]\]$")


def _img_srcs(zf: zipfile.ZipFile, phys: str) -> dict[str, str]:
    """收集一个 XHTML 文件引用的图片: 相对 src → 相对书根的物理路径。

    EPUB 内嵌路径是相对该 xhtml 文件所在目录的 (如 `images/fig1.jpg`), 书根路径
    需要拼上文件所在目录。返回 {原 src: 书根相对路径} 供 _file_sections 换算。"""
    html = _read_member(zf, phys)
    base_dir = os.path.dirname(phys).replace("\\", "/")
    out: dict[str, str] = {}
    for m in re.finditer(r'<img[^>]*\bsrc\s*=\s*(["\'])([^"\']+)\1[^>]*/?>', html, re.I):
        src = m.group(2)
        if src.startswith(("http://", "https://", "data:")):
            continue  # 外链/base64 图片不处理
        if not os.path.isabs(src):
            src = f"{base_dir}/{src}" if base_dir else src
        # 归一化 ./ 与 ../ (zip 内部统一用 / 分隔)
        parts = []
        for seg in src.split("/"):
            if seg in ("", "."):
                continue
            if seg == ".." and parts:
                parts.pop()
            else:
                parts.append(seg)
        out[m.group(2)] = "/".join(parts)
    return out


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


def _parse_ncx(ncx_html: str) -> list[tuple[str, str]]:
    """解析 EPUB2 的 toc.ncx navMap → [(标题, href)] (递归展平嵌套 navPoint)。

    新增 (2026-08-08, 银河系那本真实撞见): 老书是 EPUB2, 目录在 toc.ncx 不在
    nav.xhtml。此前只认 nav.xhtml, 认不出来就退化成 spine 每文件一章 → 出现
    1 句的"章"和 5351 句的"巨章"。这里补上标准 navPoint 结构解析。
    """
    toc: list[tuple[str, str]] = []
    ncx_ns = NS["ncx"]
    try:
        root = ET.fromstring(ncx_html)
    except ET.ParseError:
        return toc
    # root.iter 会遍历所有层级的 navPoint; navLabel 取该节点直属第一个 (嵌套节点的
    # 子 navLabel 在文档序里靠后, .find 取不到它), content 取直属子节点。
    for navpoint in root.iter(f"{{{ncx_ns}}}navPoint"):
        label = navpoint.find(f"{{{ncx_ns}}}navLabel/{{{ncx_ns}}}text")
        content = navpoint.find(f"{{{ncx_ns}}}content")
        if label is None or content is None:
            continue
        text = (label.text or "").strip()
        href = (content.get("src") or "").strip()
        if text and href:
            toc.append((text, href))
    return toc


def _file_sections(zf: zipfile.ZipFile, phys: str) -> list[tuple[str | None, list[str]]]:
    """读一个 XHTML 文件, 按 [[HEADING]] 标记切成 [(标题|None, [段落/图片记号])]。

    _strip_tags 早已把 h1-h6 标成 [[HEADING]] 前缀 (此前被当垃圾过滤掉), 这里
    改拿它当切分点: 一个文件里若有多个标题, 就是多个真实章节的边界。
    标题行本身不进段落; 开头的非标题段落 (prelude) 归入标题为 None 的一段。
    R4: 段落流里保留 `[[IMG:src]]` 记号 (在段落文本中间), 供换算图片位置。
    """
    html = _read_member(zf, phys)
    raw = [p.strip() for p in _strip_tags(html).split("\n") if p.strip()]
    sections: list[tuple[str | None, list[str]]] = []
    current_title: str | None = None
    current_paras: list[str] = []
    for p in raw:
        if p.startswith("[[HEADING]]"):
            if current_paras or current_title is not None:
                sections.append((current_title, current_paras))
                current_paras = []
            current_title = p[len("[[HEADING]]"):].strip()
        else:
            current_paras.append(p)
    if current_paras or current_title is not None:
        sections.append((current_title, current_paras))
    return sections


def _sentence_candidates(paras: list[str]) -> list[str]:
    return [p for p in paras if _is_real_sentence(p)]


_IMG_MARKER = re.compile(r"^\[\[IMG:(.+?)\]\]$")


def _img_srcs(zf: zipfile.ZipFile, phys: str) -> dict[str, str]:
    """收集一个 XHTML 文件引用的图片: 原 src → 相对书根的物理路径。

    EPUB 内嵌路径相对该 xhtml 所在目录 (如 `images/fig1.jpg`), 拼上文件目录 + 归一化
    ./ ../ 后得到书根相对路径 (zip 内部统一 / 分隔)。外链/http/data: 跳过。
    """
    html = _read_member(zf, phys)
    base_dir = os.path.dirname(phys).replace("\\", "/")
    out: dict[str, str] = {}
    for m in re.finditer(r'<img[^>]*\bsrc\s*=\s*(["\'])([^"\']+)\1[^>]*/?>', html, re.I):
        src = m.group(2)
        if src.startswith(("http://", "https://", "data:")):
            continue
        full = f"{base_dir}/{src}" if (base_dir and not os.path.isabs(src)) else src
        parts = []
        for seg in full.replace("\\", "/").split("/"):
            if seg in ("", "."):
                continue
            if seg == ".." and parts:
                parts.pop()
            else:
                parts.append(seg)
        out[src] = "/".join(parts)
    return out


def _extract_images(paras: list[str], src_map: dict[str, str]) -> list[ChapterImage]:
    """从段落流里取图片记号, 换算成 (书根相对路径, 渲染在第 at 句之前)。

    at = 该图片记号之前已经累计的真实句子数 (句子流按 _sentence_candidates 过滤后
    的位置), 保证图片嵌在正文流里而不是堆到开头。"""
    images: list[ChapterImage] = []
    sentence_count = 0
    for p in paras:
        m = _IMG_MARKER.match(p)
        if m:
            src = m.group(1)
            # 外链/http/data: 与 _img_srcs 的过滤保持一致, 不进 src_map → 跳过
            if src in src_map:
                images.append(ChapterImage(file=src_map[src], at=sentence_count))
        elif _is_real_sentence(p):
            sentence_count += 1
    return images


def probe_toc_source(path: str) -> str:
    """只探测 EPUB 的目录来源, 不解析全文 (处理前体检用)。
    返回 'nav.xhtml' | 'toc.ncx' | 'none'。"""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return "none"
    with zf:
        container = _read_member(zf, "META-INF/container.xml")
        m = re.search(r'full-path="([^"]+)"', container)
        if not m:
            return "none"
        opf_path = m.group(1)
        opf = _read_member(zf, opf_path)
        opf_dir = os.path.dirname(opf_path).replace("\\", "/")
        manifest: dict[str, str] = {}
        for item in re.findall(r'<item[^>]*/?>', opf):
            mid = re.search(r'id="([^"]+)"', item)
            mhref = re.search(r'href="([^"]+)"', item)
            if mid and mhref:
                manifest[mid.group(1)] = mhref.group(1)
        _items, source = _find_toc_source(zf, opf, manifest, opf_dir)
        return source


def _build_chapters_from_file(
    zf: zipfile.ZipFile,
    phys: str,
    default_title: str,
) -> list[Chapter]:
    """把一个 XHTML 文件转成章节列表 (小文件 = 一章; 大文件按 [[HEADING]] 二次切分)。"""
    sections = _file_sections(zf, phys)
    src_map = _img_srcs(zf, phys)
    all_paras = [p for _, paras in sections for p in paras]
    total_candidates = len(_sentence_candidates(all_paras))
    if total_candidates < LARGE_FILE_SPLIT_THRESHOLD:
        # 小文件: 整文件一章, 标题用 TOC 条目名 (旧行为, heading 标记丢弃)
        sentences = [Sentence(original_text=p) for p in _sentence_candidates(all_paras)]
        if not sentences:
            return []
        return [Chapter(index=0, title=default_title, sentences=sentences,
                        images=_extract_images(all_paras, src_map))]
    # 大文件: 每个 heading 段一章, 标题取该段 heading (没有 heading 的 prelude 用 TOC 名)
    chapters: list[Chapter] = []
    for sec_title, paras in sections:
        sentences = [Sentence(original_text=p) for p in _sentence_candidates(paras)]
        if not sentences:
            continue
        chapters.append(
            Chapter(index=len(chapters), title=sec_title or default_title, sentences=sentences,
                    images=_extract_images(paras, src_map))
        )
    return chapters


def _find_toc_source(
    zf: zipfile.ZipFile,
    opf: str,
    manifest: dict[str, str],
    opf_dir: str,
) -> tuple[list[tuple[str, str]], str]:
    """定位目录来源, 返回 (toc_items, source)。source ∈ {nav.xhtml, toc.ncx, none}。

    顺序: 先找 EPUB3 的 nav.xhtml (properties="nav"), 没有再看 EPUB2 的 toc.ncx
    (spine toc 属性 → manifest id → media-type → 文件名兜底)。
    """
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
        nav_full = _norm_zip_path(f"{opf_dir}/{nav_file}" if opf_dir else nav_file)
        return _parse_toc(_read_member(zf, nav_full)), "nav.xhtml"

    # EPUB2 目录 (2026-08-08 补): 老书用 toc.ncx 而非 nav.xhtml。
    ncx_file = None
    toc_ref = re.search(r'<spine[^>]*\btoc="([^"]+)"', opf)
    if toc_ref and toc_ref.group(1) in manifest:
        ncx_file = manifest[toc_ref.group(1)]
    if ncx_file is None:
        for item in re.findall(r'<item[^>]*/?>', opf):
            if 'application/x-dtbncx+xml' in item:
                mhref = re.search(r'href="([^"]+)"', item)
                if mhref:
                    ncx_file = mhref.group(1)
                    break
    if ncx_file is None:
        for v in manifest.values():
            if v.lower().endswith(".ncx"):
                ncx_file = v
                break
    if ncx_file:
        ncx_full = _norm_zip_path(f"{opf_dir}/{ncx_file}" if opf_dir else ncx_file)
        return _parse_ncx(_read_member(zf, ncx_full)), "toc.ncx"

    return toc_items, "none"


def load_epub(path: str) -> Book:
    book, _ = load_epub_with_spine_health(path)
    return book


def classify_uncovered(book_path: str, uncovered: list[str]) -> list[str]:
    """`uncovered` 里区分"真的读不到"(_read_member 因 KeyError 返回原始空字符串,
    是路径解析失败的信号)和"读到了但本来就没正文"(纯插图页等, 正常现象)。
    判据: _read_member 返回的是 _read_member 内部尚未做标签剥离的原始 HTML——
    真实存在的文件哪怕只有一张图也会有 `<html><body><img.../></body></html>`
    这类标记, 原始内容不可能是空字符串; 只有 KeyError(压根没找到这个文件)
    才会让 _read_member 返回 ""。用这个信号精确区分, 而不是直接拿 uncovered
    的原始计数当分子(那样会把插图页/目录页这类正常情况错判成数据丢失,
    2026-08-16 实测过, 见 _check_epub_health 的 docstring)。
    book_path 拿不到/zip 打不开时保守处理, 原样返回整个 uncovered 列表
    (不确定就不放松阈值判断)。"""
    try:
        zf = zipfile.ZipFile(book_path)
    except Exception:
        return uncovered
    with zf:
        return [f for f in uncovered if _read_member(zf, f) == ""]


def load_epub_with_spine_health(path: str) -> tuple[Book, list[str]]:
    """load_epub + 返回未被任何章节覆盖的 spine 文件 (F39 处理前体检用)。

    覆盖 = 有章节产出的文件; 被 _looks_like_index 整章跳过 / 解析出 0 句的文件也算
    未覆盖 —— 这正是 F38 类问题 ("有 spine 文件从头到尾没被打开过") 的判据。"""
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

        # K2-2 (2026-08-13): 封面 —— EPUB2 <meta name="cover" content="id"/> 查 manifest;
        # EPUB3 manifest item 直接标 properties="cover-image"。两种都没有就是真没封面
        # (不是所有书都带, 前端要有占位兜底, 这里不报错不强求)。
        cover_href = None
        # 2026-08-17 实测: XML 属性顺序是任意的, 但旧正则写死了 name 必须出现在 content
        # 之前。Because of Winn-Dixie 写的是 <meta content="my_cover_image" name="cover"/>,
        # Holes 写的是 <meta content="cover-image" name="cover"/> —— 两本都匹配失败,
        # 结果书库里没有封面。两个顺序都要认。
        cover_id = None
        cm = re.search(r'<meta[^>]*\bname="cover"[^>]*\bcontent="([^"]+)"', opf)
        if cm:
            cover_id = cm.group(1)
        else:
            cm2 = re.search(r'<meta[^>]*\bcontent="([^"]+)"[^>]*\bname="cover"', opf)
            if cm2:
                cover_id = cm2.group(1)
        if cover_id and cover_id in manifest:
            cover_href = manifest[cover_id]
        if not cover_href:
            for item in re.findall(r'<item[^>]*/?>', opf):
                if re.search(r'properties="[^"]*cover-image[^"]*"', item):
                    mhref = re.search(r'href="([^"]+)"', item)
                    if mhref:
                        cover_href = mhref.group(1)
                        break
        cover = None
        if cover_href:
            cover = _norm_zip_path(f"{opf_dir}/{cover_href}" if opf_dir else cover_href)

        # 质量修复 3 (章节划分): 用 TOC 划章节 (真实标题 + 过滤非正文)
        # 兼容 spine id 与 manifest id 不一致的书 (Wolf 21: spine=nav_00, manifest=nav_1)
        # → 直接从 manifest 里找 nav.xhtml (properties="nav"), 不依赖 spine 映射
        toc_items, _toc_source = _find_toc_source(zf, opf, manifest, opf_dir)

        # 章节划分 (F38 修复 2026-08-10): 遍历基准 = spine 全量, 不再只看 TOC 引用的文件。
        # 实测根因: TOC 条目是"锚点"不是"文件清单"——《银河系漫游指南》五部长篇的正文
        # 在 TOC 没引用的后续 spine 文件里, 旧逻辑从头到尾没打开过它们, 各只剩 3-14 段。
        #
        # 规则 (2026-08-10, 银河系 331→11894 句 + Wolf 21 回归实测确认):
        #   注: 11894 是最终值 (含 [[IMG:...]] 记号拒绝 + 前页边界); 11918 是加这些过滤
        #   之前的中间值, 已作废 (N8, 全仓统一用 11894)。
        # 1. TOC 退化成 {物理路径: 标题} 映射 (只赋标题/划边界, 不再当文件清单);
        #    NON_BODY_TOC 只决定标题进不进入映射。
        # 2. 正文区边界 = 第一个被"正文 TOC 条目"引用的 spine 文件之前是前页
        #    (Cover/Title/Copyright/Contents/系列页), 不成为章节 —— 否则 Wolf 21 会
        #    把封面/目录页做成 "Chapter 1/2" 垃圾章。
        # 3. 仅被非正文 TOC 条目 (Map/Charts/References/Index) 引用的文件跳过。
        # 4. 正文 TOC 条目出现但不在 spine 的文件补在末尾 (保守, 别丢)。
        # 5. _looks_like_index 过滤保留。
        toc_body: dict[str, str] = {}  # phys -> 标题 (正文条目)
        toc_nonbody: set[str] = set()  # 至少被一个非正文 TOC 条目引用的文件
        for text, href in toc_items:
            text_s = text.strip()
            if not text_s or not href:
                continue
            phys = href.split("#")[0]
            if not phys:
                continue
            if not os.path.isabs(phys) and not phys.startswith(opf_dir):
                phys = f"{opf_dir}/{phys}"
            key = _norm_zip_path(phys)
            if NON_BODY_TOC.match(text_s):
                toc_nonbody.add(key)
            elif key not in toc_body:
                toc_body[key] = text_s

        full_files: list[str] = []
        for f in files:
            if not f:
                continue
            full = f"{opf_dir}/{f}" if opf_dir else f
            full_files.append(_norm_zip_path(full))
        first_body_idx = next(
            (i for i, f in enumerate(full_files) if f in toc_body),
            None,  # 无正文 TOC 引用 → 无前页边界, 退化为"按 spine 逐文件"兜底
        )

        chapters: list[Chapter] = []
        covered: set[str] = set()
        for i, full in enumerate(full_files):
            if full in toc_nonbody and full not in toc_body:
                continue  # Map/Charts/References/Index 等非正文页
            if first_body_idx is not None and i < first_body_idx:
                continue  # 前页: 第一个被正文 TOC 引用的文件之前
            heading = next((t for t, _ in _file_sections(zf, full) if t), "")
            ch_title = toc_body.get(full) or heading or _UNTITLED_CHAPTER
            built = _build_chapters_from_file(zf, full, ch_title)
            before = len(chapters)
            for ch in built:
                ch.index = len(chapters)
                if _looks_like_index(ch.sentences):
                    continue
                chapters.append(ch)
            if len(chapters) > before:
                covered.add(full)

        # TOC 正文条目出现但不在 spine 的文件补在末尾 (保守, 别丢)
        for key, text in toc_body.items():
            if key in full_files:
                continue
            heading = next((t for t, _ in _file_sections(zf, key) if t), "")
            ch_title = text or heading or _UNTITLED_CHAPTER
            built = _build_chapters_from_file(zf, key, ch_title)
            before = len(chapters)
            for ch in built:
                ch.index = len(chapters)
                if _looks_like_index(ch.sentences):
                    continue
                chapters.append(ch)
            if len(chapters) > before:
                covered.add(key)

    if not chapters:
        raise InputError("EPUB 里没有解析出任何章节")
    # F39 判据 = 正文区里没产出任何章节的文件 (前页 / 非正文页按设计跳过, 不算)。
    # 这才是 F38 类问题的信号: 正文文件被跳过/没被打开过 → 有文件没被任何章节覆盖。
    uncovered = [
        f
        for i, f in enumerate(full_files)
        if f not in covered
        and not (f in toc_nonbody and f not in toc_body)
        and (first_body_idx is None or i >= first_body_idx)
    ]
    return Book(title=title, chapters=chapters, cover=cover), uncovered


def _is_real_sentence(text: str) -> bool:
    """判断是否是可处理的真实句子 (过滤页码/单字符/无字母装饰/目录标记/段落碎片/人名残句)。"""
    # 图片记号不是句子 (R4: [[IMG:...]] 只用于定位图片, 不应成为可朗读的句子/章节内容)
    if text.startswith("[[IMG:"):
        return False
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
