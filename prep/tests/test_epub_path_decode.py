"""EPUB 路径 URL 解码 + 体检阻断阈值(2026-08-16 实测 Tuck Everlasting 一书因路径未
解码丢失 95% 正文, 全程无错误无警告——见 pipeline/loader/epub.py::_norm_zip_path 和
pipeline/runner.py::Runner._check_epub_health 的注释)。"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, Sentence
from aidulc_prep.pipeline.loader.epub import _norm_zip_path
from aidulc_prep.pipeline.runner import Runner


class TestNormZipPathDecodesUrlEncoding:
    def test_percent20_decodes_to_space(self):
        """实测根因: TOC/OPF href 是 URL 编码(Chapter%201.xhtml), zip 内真实成员名
        不编码(Chapter 1.xhtml, 带字面空格)——不解码路径比较永远失败。"""
        assert _norm_zip_path("OEBPS/Text/Chapter%201.xhtml") == "OEBPS/Text/Chapter 1.xhtml"

    def test_plain_path_without_encoding_unchanged(self):
        assert _norm_zip_path("OEBPS/Text/Chapter1.xhtml") == "OEBPS/Text/Chapter1.xhtml"

    def test_still_strips_dot_segments_after_decode(self):
        assert _norm_zip_path("OEBPS/../Text/Chapter%201.xhtml") == "Text/Chapter 1.xhtml"

    def test_percent_encoded_special_chars_like_quotes(self):
        # 常见于带书名/引号的文件名 (如宣传页 "PRAISE FOR ...")
        assert _norm_zip_path("Text/A%20Note.xhtml") == "Text/A Note.xhtml"


def make_book(chapter_sentence_counts):
    chapters = [
        Chapter(index=i, title=f"Ch{i}", sentences=[Sentence(original_text="x") for _ in range(n)])
        for i, n in enumerate(chapter_sentence_counts)
    ]
    return Book(title="Test", chapters=chapters)


class TestCheckEpubHealth:
    def _runner(self):
        return Runner({}, os.path.join(os.path.dirname(__file__), "_tmp_health_test"))

    def test_uncovered_over_10_percent_raises(self):
        """9 个未覆盖 / (1 章产出 + 9 未覆盖) = 90% 远超 10% 阈值 → 拒绝处理,
        不产出残缺书包(实测 Tuck Everlasting 场景: 大比例未覆盖=数据丢失, 不是噪音)。"""
        book = make_book([5])
        uncovered = [f"Text/ch{i}.xhtml" for i in range(9)]
        r = self._runner()
        try:
            r._check_epub_health(book, uncovered)
            assert False, "应该抛 InputError"
        except InputError as e:
            assert "正文丢失" in str(e.human) or "正文丢失" in str(e)

    def test_uncovered_under_10_percent_does_not_raise(self):
        """1 个未覆盖 / (20 章产出 + 1 未覆盖) ≈ 4.8%, 低于阈值 —— 不阻断
        (这类少量未覆盖多半是目录页/图片说明页, 是正常现象, 不该拦住整本书)。"""
        book = make_book([5] * 20)
        uncovered = ["Text/some_caption_page.xhtml"]
        r = self._runner()
        r._check_epub_health(book, uncovered)  # 不应抛异常

    def test_no_uncovered_no_anomalies_is_silent(self):
        book = make_book([5, 5, 5])
        r = self._runner()
        r._check_epub_health(book, [])  # 不应抛异常, 也不应报错

    def test_empty_book_with_uncovered_does_not_divide_by_zero(self):
        """total=0 时(理论上不该发生, 但防御一下)不能除零崩溃。"""
        book = make_book([])
        r = self._runner()
        r._check_epub_health(book, [])  # total=0, 不应抛 ZeroDivisionError
