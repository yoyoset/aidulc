"""R3.1 (2026-08-08) 测试: EPUB2 toc.ncx 目录 + [[HEADING]] 二次切分

DoD: 纯函数单测覆盖 _parse_ncx / _build_chapters_from_file; 用内联构造的
EPUB2 包 (container.xml + opf + toc.ncx) 验证 ncx 被正确认成章节来源。
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.errors import InputError
from aidulc_prep.pipeline.loader import load_book
from aidulc_prep.pipeline.loader.epub import (
    LARGE_FILE_SPLIT_THRESHOLD,
    _build_chapters_from_file,
    _file_sections,
    _parse_ncx,
    load_epub,
)


def _make_epub(opf: str, extra: dict[str, str], container: str | None = None) -> str:
    """构造临时 epub, 返回路径。container 默认标准 META-INF/container.xml。"""
    if container is None:
        container = (
            '<?xml version="1.0"?><container><rootfiles>'
            '<rootfile full-path="book.opf"/></rootfiles></container>'
        )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("book.opf", opf)
        for name, content in extra.items():
            zf.writestr(name, content)
    buf.seek(0)
    tmp = os.path.join(os.path.dirname(__file__), "..", "_tmp_epub2.epub")
    with open(tmp, "wb") as f:
        f.write(buf.read())
    return tmp


class TestParseNcx:
    def test_flat_navmap(self):
        ncx = """<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <navMap>
            <navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/></navPoint>
            <navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="ch2.xhtml"/></navPoint>
          </navMap>
        </ncx>"""
        assert _parse_ncx(ncx) == [("Chapter One", "ch1.xhtml"), ("Chapter Two", "ch2.xhtml")]

    def test_nested_navmap_flattened(self):
        # 嵌套 navPoint (Part → 子章): 全部展平
        ncx = """<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap>
            <navPoint id="p1"><navLabel><text>Part I</text></navLabel><content src="part1.xhtml"/>
              <navPoint id="c1"><navLabel><text>1. First</text></navLabel><content src="c1.xhtml"/></navPoint>
              <navPoint id="c2"><navLabel><text>2. Second</text></navLabel><content src="c2.xhtml"/></navPoint>
            </navPoint>
          </navMap>
        </ncx>"""
        assert _parse_ncx(ncx) == [
            ("Part I", "part1.xhtml"),
            ("1. First", "c1.xhtml"),
            ("2. Second", "c2.xhtml"),
        ]

    def test_broken_ncx_returns_empty(self):
        assert _parse_ncx("not xml at all") == []


class TestFileSections:
    def test_splits_on_headings(self):
        html = """<html><body>
          <h1>Chapter One</h1><p>First sentence here.</p><p>Second one.</p>
          <h2>Sub Section</h2><p>Third sentence.</p>
        </body></html>"""
        import zipfile as z
        buf = io.BytesIO()
        with z.ZipFile(buf, "w") as zf:
            zf.writestr("f.xhtml", html)
        buf.seek(0)
        zf = z.ZipFile(buf)
        sections = _file_sections(zf, "f.xhtml")
        assert sections == [
            ("Chapter One", ["First sentence here.", "Second one."]),
            ("Sub Section", ["Third sentence."]),
        ]


class TestBuildChaptersFromFile:
    def _write(self, html: str) -> "zipfile.ZipFile":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("big.xhtml", html)
        buf.seek(0)
        return zipfile.ZipFile(buf)

    def test_small_file_is_one_chapter_with_toc_title(self):
        # 小文件 (< 阈值): 整文件一章, 标题 = TOC 条目名 (旧行为不变)
        body = "<h1>Ignored heading</h1>" + "".join(
            f"<p>Sentence number {i} is here.</p>" for i in range(5)
        )
        zf = self._write(body)
        chs = _build_chapters_from_file(zf, "big.xhtml", "TOC Title")
        assert len(chs) == 1
        assert chs[0].title == "TOC Title"
        assert len(chs[0].sentences) == 5

    def test_large_file_splits_into_heading_sections(self):
        # 大文件 (>= 阈值句数): 按 h1-h6 切成多章, 标题取 heading
        n = LARGE_FILE_SPLIT_THRESHOLD + 5
        parts = []
        parts.append(f"<h1>First Section</h1>" + "".join(
            f"<p>Alpha sentence {i} is long enough to pass the real sentence filter.</p>"
            for i in range(n // 2)
        ))
        parts.append(f"<h1>Second Section</h1>" + "".join(
            f"<p>Beta sentence {i} is long enough to pass the real sentence filter.</p>"
            for i in range(n // 2)
        ))
        zf = self._write("<html><body>" + "".join(parts) + "</body></html>")
        chs = _build_chapters_from_file(zf, "big.xhtml", "Fallback Title")
        assert len(chs) == 2
        assert chs[0].title == "First Section"
        assert chs[1].title == "Second Section"
        assert len(chs[0].sentences) == n // 2
        assert len(chs[1].sentences) == n // 2

    def test_empty_file_no_chapters(self):
        zf = self._write("<html><body></body></html>")
        assert _build_chapters_from_file(zf, "big.xhtml", "T") == []

    def test_small_file_keeps_images_with_position(self):
        # R4: 图插在段落流里, at = 该图之前的真实句数
        body = ("<h1>Ch</h1>"
                "<p>First sentence here is long enough.</p>"
                "<p><img src='images/fig1.jpg'/></p>"
                "<p>Second sentence here is long enough.</p>")
        zf = self._write(body)
        chs = _build_chapters_from_file(zf, "big.xhtml", "TOC")
        assert len(chs) == 1
        imgs = chs[0].images
        assert len(imgs) == 1
        assert imgs[0].at == 1, f"图应插在第 1 句之后 (前有 1 句), 实得 at={imgs[0].at}"
        assert imgs[0].file.endswith("images/fig1.jpg")

    def test_img_src_resolved_relative_to_xhtml_dir(self):
        # 图片 src 相对 xhtml 目录: 本文件在 OEBPS/ 下, images/fig 在 OEBPS/images/
        import zipfile as z
        buf = io.BytesIO()
        with z.ZipFile(buf, "w") as zf:
            zf.writestr("OEBPS/ch.xhtml",
                        "<html><body><p>Alpha sentence is long enough.</p>"
                        "<p><img src='../images/fig1.jpg'/></p></body></html>")
        buf.seek(0)
        zf = z.ZipFile(buf)
        chs = _build_chapters_from_file(zf, "OEBPS/ch.xhtml", "T")
        assert chs[0].images[0].file == "images/fig1.jpg"

    def test_external_and_data_images_skipped(self):
        body = ("<p><img src='https://example.com/x.jpg'/></p>"
                "<p><img src='data:image/png;base64,abc'/></p>"
                "<p>Only real sentence here is long enough.</p>")
        zf = self._write(body)
        chs = _build_chapters_from_file(zf, "big.xhtml", "T")
        assert chs[0].images == []


class TestPackImages:
    """R4: pack._copy_chapter_images 从源 EPUB 拷图进书包 images/ 并改写 file 路径"""

    def test_copies_images_and_renames_with_chapter_prefix(self):
        from aidulc_prep.core.models import Book, Chapter, ChapterImage, Sentence
        from aidulc_prep.pipeline.pack import _copy_chapter_images
        import tempfile
        import shutil

        src = os.path.join(os.path.dirname(__file__), "..", "_tmp_img_src.epub")
        with zipfile.ZipFile(src, "w") as zf:
            zf.writestr("OEBPS/images/fig1.jpg", b"\xff\xd8\xfffakejpeg")
        ch = Chapter(index=2, title="T", sentences=[Sentence(original_text="x.")],
                     images=[ChapterImage(file="OEBPS/images/fig1.jpg", at=0)])
        images_dir = tempfile.mkdtemp(prefix="aidulc_img_")
        try:
            _copy_chapter_images(ch, images_dir, src)
            assert ch.images[0].file == "images/ch_002_fig1.jpg"
            assert os.path.exists(os.path.join(images_dir, "ch_002_fig1.jpg"))
            with open(os.path.join(images_dir, "ch_002_fig1.jpg"), "rb") as f:
                assert f.read() == b"\xff\xd8\xfffakejpeg"
        finally:
            os.remove(src)
            shutil.rmtree(images_dir, ignore_errors=True)

    def test_missing_image_dropped_not_fatal(self):
        from aidulc_prep.core.models import Chapter, ChapterImage, Sentence
        from aidulc_prep.pipeline.pack import _copy_chapter_images
        import tempfile
        import shutil

        src = os.path.join(os.path.dirname(__file__), "..", "_tmp_img_src2.epub")
        with zipfile.ZipFile(src, "w") as zf:
            zf.writestr("OEBPS/images/fig1.jpg", b"data")
        ch = Chapter(index=0, title="T", sentences=[Sentence(original_text="x.")],
                     images=[ChapterImage(file="OEBPS/images/fig1.jpg", at=0),
                             ChapterImage(file="OEBPS/images/nonexistent.png", at=1)])
        images_dir = tempfile.mkdtemp(prefix="aidulc_img2_")
        try:
            _copy_chapter_images(ch, images_dir, src)
            # 缺的那张被去掉, 在的那张保留
            assert [i.file for i in ch.images] == ["images/ch_000_fig1.jpg"]
        finally:
            os.remove(src)
            shutil.rmtree(images_dir, ignore_errors=True)

    def test_non_zip_source_removes_all_images(self):
        from aidulc_prep.core.models import Chapter, ChapterImage, Sentence
        from aidulc_prep.pipeline.pack import _copy_chapter_images
        import tempfile
        import shutil

        ch = Chapter(index=0, title="T", sentences=[Sentence(original_text="x.")],
                     images=[ChapterImage(file="fig1.jpg", at=0)])
        images_dir = tempfile.mkdtemp(prefix="aidulc_img3_")
        try:
            _copy_chapter_images(ch, images_dir, "C:/not_a_zip.txt")
            assert ch.images == []
        finally:
            shutil.rmtree(images_dir, ignore_errors=True)


class TestLoadEpub2:
    def test_epub2_toc_ncx_used_as_chapter_source(self):
        """EPUB2 (无 nav.xhtml, 有 toc.ncx): 章节来自 ncx 而非 spine 逐文件。"""
        opf = """<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">NCX Book</dc:title></metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
            <item id="frag" href="frag.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx">
            <itemref idref="frag"/>
            <itemref idref="ch1"/>
            <itemref idref="ch2"/>
          </spine>
        </package>"""
        ncx = """<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap>
            <navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/></navPoint>
            <navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="ch2.xhtml"/></navPoint>
          </navMap>
        </ncx>"""
        extra = {
            "toc.ncx": ncx,
            "ch1.xhtml": "<html><body><p>First chapter real sentence one.</p><p>And a second real sentence.</p></body></html>",
            "ch2.xhtml": "<html><body><p>Second chapter real sentence.</p></body></html>",
            # spine 里的碎片文件 (不在 ncx 里): 不应成为章节
            "frag.xhtml": "<html><body><p>Cover</p></body></html>",
        }
        tmp = _make_epub(opf, extra)
        try:
            book = load_epub(tmp)
            assert book.title == "NCX Book"
            assert len(book.chapters) == 2, f"ncx 应给出 2 章, 实得 {len(book.chapters)}"
            assert book.chapters[0].title == "Chapter One"
            assert book.chapters[1].title == "Chapter Two"
            assert len(book.chapters[0].sentences) == 2
        finally:
            os.remove(tmp)

    def test_ncx_with_fragments_still_one_chapter_per_entry(self):
        # spine 有碎片文件也不该进来; 无 nav.xhtml 时 ncx 是唯一目录来源
        opf = """<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Frag Book</dc:title></metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx"><itemref idref="c1"/></spine>
        </package>"""
        ncx = """<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap><navPoint id="a"><navLabel><text>Alpha</text></navLabel><content src="c1.xhtml#start"/></navPoint></navMap>
        </ncx>"""
        extra = {
            "toc.ncx": ncx,
            "c1.xhtml": "<html><body><h1>Alpha</h1><p>Some real sentence content.</p></body></html>",
        }
        tmp = _make_epub(opf, extra)
        try:
            book = load_epub(tmp)
            assert len(book.chapters) == 1
            assert book.chapters[0].title == "Alpha"
            assert len(book.chapters[0].sentences) >= 1
        finally:
            os.remove(tmp)


class TestMupdfFallbackRouting:
    """R3.2 (2026-08-08): pdf/mobi/azw3/fb2 走 PyMuPDF 兜底, epub 不走。"""

    def test_mobi_ext_is_supported(self):
        # .mobi 已加入 SUPPORTED_EXT: 不存在的文件应报"文件不存在"而非"不支持格式"
        with pytest.raises(InputError) as ei:
            load_book("C:/definitely/missing.mobi")
        assert "文件不存在" in str(ei.value)

    def test_mobi_missing_file_gives_human_error(self):
        # 不存在的文件: 在打开前就报"文件不存在", 而不是 PyMuPDF 的错
        with pytest.raises(InputError) as ei:
            load_book("C:/definitely/missing.mobi")
        assert "文件不存在" in str(ei.value)

    def test_unsupported_ext_still_rejected(self):
        with pytest.raises(InputError) as ei:
            load_book("book.docx")
        assert "不支持" in str(ei.value)

    def test_pymupdf_missing_gives_human_hint(self, monkeypatch):
        # 模拟 fitz 未安装: 报"PyMuPDF 未安装"的人话提示, 不是 ImportError 原始堆栈
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "fitz":
                raise ImportError("No module named 'fitz'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        # 用真实存在的 EPUB? 不, 直接调 load_pdf 验证懒加载提示
        from aidulc_prep.pipeline.loader.pdf import load_pdf
        with pytest.raises(InputError) as ei:
            load_pdf("whatever.pdf")
        assert "PyMuPDF" in str(ei.value)
