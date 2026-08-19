"""nav.xhtml/toc.ncx 放在与 opf 不同子目录时的标题解析 (2026-08-19)

实测背景: 用户导入 Impossible Creatures 后 65 章里 64 章标题是 (Untitled)。追下去
发现该书的 nav.xhtml 放在 OEBPS/xhtml/ 下(不是 opf 所在的 OEBPS/ 根)。EPUB3 规范
里 <a href> 是相对 nav.xhtml **自己所在目录**解析的, 但 load_epub_with_spine_health
统一拿 opf_dir 去拼——href "13_FRANK_AUREATE.xhtml" 被拼成
"OEBPS/13_FRANK_AUREATE.xhtml", 而 manifest 里真实物理路径是
"OEBPS/xhtml/13_FRANK_AUREATE.xhtml", 两个 key 永远对不上, toc_body 查表全部落空。

同一个根因还连带炸了 first_body_idx(前页边界判断用的也是这份 toc_body)——前言/
扉页没被正确排除, 混进正文当成了 1 句的碎片章。

修复后回归用户库里另一本真实撞到同一个 bug 的书(First State of Being, nav.xhtml
在 OEBPS/text/ 下, 之前 63 章 18 章 (Untitled)), 以及已在库的 11 本 nav.xhtml
与 opf 同目录的书(toc_dir == opf_dir 时行为必须原样不变)。
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub import load_epub_with_spine_health


def _make_epub_with_nav_in_subdir(nav_dir: str) -> str:
    """构造一个 EPUB3: opf 在 OEBPS/, nav.xhtml **和正文章节文件**都在 OEBPS/<nav_dir>/
    (与 Impossible Creatures 真实结构一致——出版社把 xhtml 内容整体收进子目录, 只有
    opf/container 留在根)。manifest 里的 href 相对 opf_dir 写(含 nav_dir 前缀,
    这部分本来就没问题); nav.xhtml **内部**的 <a href> 相对它自己所在目录写
    (不带 nav_dir 前缀)—— 这才是 bug 复现的关键: 两种"相对"基准不一样。"""
    prefix = f"{nav_dir}/" if nav_dir else ""
    opf = """<?xml version="1.0"?>
    <package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">T</dc:title></metadata>
    <manifest>
      <item id="nav" href="{p}nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
      <item id="c1" href="{p}c1.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="{p}c2.xhtml" media-type="application/xhtml+xml"/>
    </manifest>
    <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>""".format(p=prefix)

    # nav.xhtml 里的 href 相对自己所在目录写(不带 nav_dir 前缀)—— EPUB3 规范行为
    nav_html = """<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol>
      <li><a href="c1.xhtml">Chapter One Real Title</a></li>
      <li><a href="c2.xhtml">Chapter Two Real Title</a></li>
    </ol></nav>
    </body></html>"""

    c1 = "<html><body>" + "".join(f"<p>First chapter sentence number {i} here.</p>" for i in range(3)) + "</body></html>"
    c2 = "<html><body>" + "".join(f"<p>Second chapter sentence number {i} here.</p>" for i in range(3)) + "</body></html>"

    container = (
        '<?xml version="1.0"?><container><rootfiles>'
        '<rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("OEBPS/book.opf", opf)
        zf.writestr(f"OEBPS/{prefix}nav.xhtml", nav_html)
        zf.writestr(f"OEBPS/{prefix}c1.xhtml", c1)
        zf.writestr(f"OEBPS/{prefix}c2.xhtml", c2)
    buf.seek(0)
    safe_name = (nav_dir or "root").replace("/", "_")
    tmp = os.path.join(os.path.dirname(__file__), "..", f"_tmp_navsubdir_{safe_name}.epub")
    with open(tmp, "wb") as f:
        f.write(buf.read())
    return tmp


class TestNavInSubdirectory:
    def test_nav_in_subdir_resolves_real_titles(self):
        # 复现 Impossible Creatures: nav.xhtml 在 OEBPS/xhtml/, href 不带 xhtml/ 前缀
        path = _make_epub_with_nav_in_subdir("xhtml")
        try:
            book, uncovered = load_epub_with_spine_health(path)
            titles = [c.title for c in book.chapters]
            assert titles == ["Chapter One Real Title", "Chapter Two Real Title"], (
                f"nav.xhtml 在子目录时 toc_body 查表应该命中, 实得 {titles} "
                "(退化成 (Untitled) 说明 toc_dir 没生效, href 又被拿 opf_dir 拼了)"
            )
            assert uncovered == []
        finally:
            os.remove(path)

    def test_nav_in_root_unaffected(self):
        # 对照组: nav.xhtml 就在 opf_dir 根下 (绝大多数真实 EPUB 的情况),
        # toc_dir == opf_dir, 修复前后行为必须完全一致
        path = _make_epub_with_nav_in_subdir("")
        try:
            book, uncovered = load_epub_with_spine_health(path)
            titles = [c.title for c in book.chapters]
            assert titles == ["Chapter One Real Title", "Chapter Two Real Title"]
        finally:
            os.remove(path)

    def test_nav_in_nested_subdir(self):
        # 更深一层子目录, 确认不是只对单层生效
        path = _make_epub_with_nav_in_subdir("text/nav")
        try:
            book, _uncovered = load_epub_with_spine_health(path)
            titles = [c.title for c in book.chapters]
            assert titles == ["Chapter One Real Title", "Chapter Two Real Title"]
        finally:
            os.remove(path)
