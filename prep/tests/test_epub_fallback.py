"""pipeline/loader/epub_fallback.py —— pymupdf 兜底解析 (2026-08-19)

背景: 用户拍板"导入判不达标的书, 自动尝试标准化转换, 不用设置, 能看结果"。这是那条
兜底路径的测试, 只在原生解析(loader/epub.py)判 block 之后才会被调用。

实测背书(不是文档假设): 拿真实撞过 block 的书 Ferris(Kate DiCamillo)跑过一次
`evaluate_book_fallback`, 结果 33 章 2793 句 verdict=ok —— 证明这条兜底路径真的能把
一本"两条腿都拄拐"的书救回来。这里用 tmp_path 合成 fixture 测边界条件(前后言过滤/
无 TOC 退化/文件损坏), 不依赖仓库外的真实文件。
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub_fallback import _page_text_to_sentences, load_epub_fallback


def _make_epub(chapters: list[tuple[str, str]], with_nonbody: bool = False) -> str:
    """chapters: [(标题, 正文HTML段落), ...]。每章一页, TOC 顶层条目按顺序对应。"""
    items = []
    toc_entries = []
    if with_nonbody:
        items.append(("cvi", "cvi.xhtml", "<html><body><p>Cover page only.</p></body></html>"))
        toc_entries.append('<li><a href="cvi.xhtml">Cover</a></li>')
    for i, (title, body) in enumerate(chapters):
        fname = f"c{i}.xhtml"
        items.append((f"c{i}", fname, f"<html><body>{body}</body></html>"))
        toc_entries.append(f'<li><a href="{fname}">{title}</a></li>')

    manifest_items = "\n".join(
        f'<item id="{iid}" href="{href}" media-type="application/xhtml+xml"/>' for iid, href, _ in items
    )
    manifest_items += '\n<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
    spine_items = "\n".join(f'<itemref idref="{iid}"/>' for iid, _, _ in items)
    opf = f"""<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>Fallback Test Book</dc:title><dc:identifier id="bid">x</dc:identifier>
      <dc:language>en</dc:language>
    </metadata>
    <manifest>{manifest_items}</manifest>
    <spine>{spine_items}</spine>
    </package>"""

    nav = f"""<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol>{"".join(toc_entries)}</ol></nav>
    </body></html>"""

    container = (
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
        '<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>'
        "</container>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("OEBPS/book.opf", opf)
        zf.writestr("OEBPS/nav.xhtml", nav)
        for _, href, html in items:
            zf.writestr(f"OEBPS/{href}", html)
    buf.seek(0)
    tmp = os.path.join(os.path.dirname(__file__), "..", f"_tmp_fallback_{os.getpid()}.epub")
    with open(tmp, "wb") as f:
        f.write(buf.read())
    return tmp


class TestPageTextToSentences:
    def test_splits_on_sentence_end_and_collapses_soft_wraps(self):
        text = "This is one sentence. This is\nanother one that wraps across a line."
        out = _page_text_to_sentences(text)
        assert out == [
            "This is one sentence.",
            "This is another one that wraps across a line.",
        ]

    def test_blank_line_run_is_a_hard_break(self):
        text = "First paragraph.\n\nSecond paragraph starts fresh."
        out = _page_text_to_sentences(text)
        assert out == ["First paragraph.", "Second paragraph starts fresh."]

    def test_empty_text_yields_nothing(self):
        assert _page_text_to_sentences("") == []
        assert _page_text_to_sentences("\n\n\n") == []


class TestLoadEpubFallback:
    def test_extracts_chapters_with_real_titles(self):
        path = _make_epub([
            ("Chapter One", "".join(f"<p>Alpha sentence number {i} is here for real.</p>" for i in range(8))),
            ("Chapter Two", "".join(f"<p>Beta sentence number {i} is here for real.</p>" for i in range(8))),
        ])
        try:
            book, uncovered = load_epub_fallback(path)
            assert [c.title for c in book.chapters] == ["Chapter One", "Chapter Two"]
            assert len(book.chapters[0].sentences) >= 8
            assert len(book.chapters[1].sentences) >= 8
            assert uncovered == []
        finally:
            os.remove(path)

    def test_front_matter_filtered_via_shared_non_body_regex(self):
        # 复用原生解析同一份 NON_BODY_TOC 判据, 不是重新发明一套前后言过滤
        path = _make_epub(
            [("Chapter One", "".join(f"<p>Real content sentence {i} goes here now.</p>" for i in range(8)))],
            with_nonbody=True,
        )
        try:
            book, _uncovered = load_epub_fallback(path)
            titles = [c.title for c in book.chapters]
            assert "Cover" not in titles
            assert titles == ["Chapter One"]
        finally:
            os.remove(path)

    def test_corrupt_file_returns_empty_book_not_raise(self, tmp_path):
        bad = tmp_path / "broken.epub"
        bad.write_bytes(b"not a zip at all")
        book, uncovered = load_epub_fallback(str(bad))
        assert book.chapters == []
        assert uncovered == []

    def test_no_toc_falls_back_to_single_chapter(self):
        # manifest 里没有任何 nav item/toc 条目: top 为空, 走"整本一章"退化路径
        opf = """<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>No TOC Book</dc:title><dc:identifier id="bid">x</dc:identifier>
          <dc:language>en</dc:language>
        </metadata>
        <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="c1"/></spine>
        </package>"""
        c1 = "<html><body>" + "".join(f"<p>Untocced sentence number {i} is here now.</p>" for i in range(10)) + "</body></html>"
        container = (
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
            '<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>'
            "</container>"
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("mimetype", "application/epub+zip")
            zf.writestr("META-INF/container.xml", container)
            zf.writestr("OEBPS/book.opf", opf)
            zf.writestr("OEBPS/c1.xhtml", c1)
        buf.seek(0)
        tmp = os.path.join(os.path.dirname(__file__), "..", f"_tmp_fallback_notoc_{os.getpid()}.epub")
        with open(tmp, "wb") as f:
            f.write(buf.read())
        try:
            book, _uncovered = load_epub_fallback(tmp)
            assert len(book.chapters) == 1
            assert len(book.chapters[0].sentences) >= 10
        finally:
            os.remove(tmp)
