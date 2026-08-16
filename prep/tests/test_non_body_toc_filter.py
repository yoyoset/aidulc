"""NON_BODY_TOC 正则(2026-08-16): 出版社宣传性尾页(致谢/花絮/书评摘录/其它书预告/
讨论指南)被当成正文章节, 翻译+讲解+配音全跑一遍。实测 Wild Robot Boxed Set 一书
13 处这类条目全部漏过滤(逐条打开 bookpack.json 验证过, 见 epub.py 里的注释)。"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub import NON_BODY_TOC


class TestNonBodyTocBlocksBackMatter:
    def test_acknowledgments_american_spelling_no_e(self):
        """美式拼写(无 e)之前完全没被拦, 实测 Wild Robot/Despereaux 都用这个拼写。"""
        assert NON_BODY_TOC.match("ACKNOWLEDGMENTS")

    def test_acknowledgements_british_spelling_still_works(self):
        assert NON_BODY_TOC.match("ACKNOWLEDGEMENTS")

    def test_a_note_about_the_story(self):
        assert NON_BODY_TOC.match("A NOTE ABOUT THE STORY")

    def test_behind_the_scenes(self):
        assert NON_BODY_TOC.match("BEHIND THE SCENES")

    def test_discussion_guide(self):
        assert NON_BODY_TOC.match("DISCUSSION GUIDE")

    def test_praise_for_matches_as_prefix_with_varying_quoted_title(self):
        """书评摘录标题总是带一本书名(引号内容, 每本书不一样)——必须前缀匹配,
        不能要求整串精确相等。"""
        assert NON_BODY_TOC.match('PRAISE FOR "THE WILD ROBOT"')
        assert NON_BODY_TOC.match('PRAISE FOR "SOME OTHER BOOK ENTIRELY"')

    def test_sneak_peek_matches_at_and_of_variants(self):
        assert NON_BODY_TOC.match('A SNEAK PEEK AT "THE WILD ROBOT ESCAPES"')
        assert NON_BODY_TOC.match('A SNEAK PEEK OF "THE WILD ROBOT PROTECTS"')

    def test_about_the_author_already_worked_no_regression(self):
        assert NON_BODY_TOC.match("ABOUT THE AUTHOR")


class TestNonBodyTocDoesNotSwallowRealChapters:
    """回归防线: 补正则时最容易犯的错是把匹配面扩得太宽, 连累真实章节标题。
    这几条是实测过的真实书籍章节标题(Wild Robot/Despereaux/Number the Stars)。"""

    def test_real_chapter_titles_pass_through(self):
        real_titles = [
            'CHAPTER 1: THE OCEAN',
            'THE CITY',
            'Prologue',
            'Epilogue',
            'Chapter 25',
            'THE ROBOT SLEEPS',
            'A New Home',
        ]
        for t in real_titles:
            assert not NON_BODY_TOC.match(t), f"真实章节标题被误判成非正文: {t!r}"
