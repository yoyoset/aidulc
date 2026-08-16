"""章节标题回退文案(2026-08-16): 用户截图实测 Wild Robot Boxed Set 章节列表出现
"17. Chapter 17" 紧跟 "18. CHAPTER 16" 这种乱序观感——根因是回退文案
f"Chapter {len(chapters)+1}" 里的数字是"这本书目前累计产出了多少章"的位置计数,
不是书里真实的章节序号, 跟同一本书里由 TOC/heading 提供的真实 "CHAPTER N" 标题
交替出现时两套编号体系互相打架。改成不带数字的诚实文案 "(Untitled)" 后不会再跟
任何真实标题的编号冲突。"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub import _UNTITLED_CHAPTER, load_epub_with_spine_health

_CONTAINER = (
    '<?xml version="1.0"?><container><rootfiles>'
    '<rootfile full-path="book.opf"/></rootfiles></container>'
)


def _make_epub(tmp_path, manifest_items, written, toc_entries=""):
    items = "".join(f'<item id="{i}" href="{h}" media-type="application/xhtml+xml"/>' for i, h in manifest_items)
    refs = "".join(f'<itemref idref="{i}"/>' for i, _ in manifest_items)
    opf = (
        '<?xml version="1.0"?><package><metadata><dc:title>T</dc:title></metadata>'
        f"<manifest>{items}</manifest><spine>{refs}</spine></package>"
    )
    p = os.path.join(tmp_path, "test.epub")
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("META-INF/container.xml", _CONTAINER)
        zf.writestr("book.opf", opf)
        for name, content in written.items():
            zf.writestr(name, content)
    return p


class TestUntitledChapterFallback:
    def test_heading_only_image_falls_back_to_honest_untitled_label(self, tmp_path):
        """<h1><img.../></h1>——标题在源文件里就是纯装饰图片, 没有可提取的文字
        (实测 Despereaux 场景), 不该假装成一个具体的 Chapter N。"""
        p = _make_epub(
            str(tmp_path),
            manifest_items=[("c1", "ch1.xhtml")],
            written={
                "ch1.xhtml": '<html><body><h1><img src="deco.png"/></h1><p>'
                + "Real prose sentence here. " * 5
                + "</p></body></html>",
            },
        )
        book, _ = load_epub_with_spine_health(p)
        assert book.chapters[0].title == _UNTITLED_CHAPTER

    def test_fallback_label_has_no_number_to_collide_with_real_titles(self, tmp_path):
        """回退文案不带数字——不会跟相邻真实 "CHAPTER N" 标题的编号打架
        (实测 Wild Robot Boxed Set: 修复前 "17. Chapter 17" 后紧跟 "18. CHAPTER 16",
        两套编号互相矛盾)。"""
        assert not any(c.isdigit() for c in _UNTITLED_CHAPTER)
