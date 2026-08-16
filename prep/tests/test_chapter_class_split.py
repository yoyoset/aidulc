import os
import re
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub import _strip_tags


def test_chapter_class_becomes_heading_when_no_h_tags():
    """输入含 class="ChapterTitle" 但无 h1-h6 时, [[HEADING]] 应出现 2 次"""
    html = '<html><body><p class="ChapterTitle">One</p><p>body text</p><p class="ChapterTitle">Two</p></body></html>'
    result = _strip_tags(html)
    assert result.count("[[HEADING]]") == 2


def test_chapter_class_ignored_when_h_tags_present():
    """输入含 h1 和 class="ChapterTitle" 时, [[HEADING]] 只出现 1 次(只有 h1 那个)"""
    html = '<html><body><h1>Real</h1><p class="ChapterTitle">One</p><p>body text</p><p class="ChapterTitle">Two</p></body></html>'
    result = _strip_tags(html)
    assert result.count("[[HEADING]]") == 1


def test_case_insensitive_class_match():
    """class="chapter-title" / class="calibre_CHAPTER" 都能命中"""
    html1 = '<html><body><p class="chapter-title">Section</p></body></html>'
    result1 = _strip_tags(html1)
    assert result1.count("[[HEADING]]") == 1

    html2 = '<html><body><p class="calibre_CHAPTER">Section</p></body></html>'
    result2 = _strip_tags(html2)
    assert result2.count("[[HEADING]]") == 1


def test_unrelated_class_not_matched():
    """class="calibre10" / class="Padding" 不产生 [[HEADING]]"""
    html1 = '<html><body><p class="calibre10">Text</p></body></html>'
    result1 = _strip_tags(html1)
    assert result1.count("[[HEADING]]") == 0

    html2 = '<html><body><p class="Padding">Text</p></body></html>'
    result2 = _strip_tags(html2)
    assert result2.count("[[HEADING]]") == 0


def test_div_also_matched():
    """<div class="chapter">x</div> 能命中"""
    html = '<html><body><div class="chapter">Content</div><p>text</p></body></html>'
    result = _strip_tags(html)
    assert result.count("[[HEADING]]") == 1
