"""行内标签不该断句 (2026-08-17)。

实测根因: `_strip_tags` 旧实现把**所有**标签一律换成换行, 包括 `<em>/<a>/<span>` 这类
行内标签。后果(拿 Charlotte's Web 开篇名句复现):

    输入  '"Where is Papa going with that <em>ax</em>?" said Fern to her mother...'
    旧输出 ① '"Where is Papa going with that'
          ② '?" said Fern to her mother as they were setting the table.'
    —— 一句变两个残句, 且 "ax" 被 _is_real_sentence 过滤掉, 从正文里彻底消失。

约 20% 的段落含行内标签(实测 Charlotte's Web 30/148, Hatchet 34/159), 下游翻译/讲解/
配音/对齐全建立在这些残句上。

10 本真实书前后对比(2026-08-17 实测): 章数基本不变(两处 -1 都是出版社广告页/空章),
句数下降(碎片被拼回), **非空白字符数 10/10 本全部增加, 合计 +13086**, 没有一本减少
——这是"纯增益零回归"的判据: 如果有内容丢失, 字符数必然下降。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.loader.epub import _sentence_candidates, _strip_tags


def lines(html: str) -> list[str]:
    return [x.strip() for x in _strip_tags(html).split("\n") if x.strip()]


class TestInlineTagsDoNotBreakSentences:
    def test_em_inside_sentence_keeps_one_sentence(self):
        """这条就是根因复现: 带 <em> 的句子必须保持完整, 且 <em> 里的词不能丢。"""
        html = ('<p>"Where is Papa going with that <em>ax</em>?" said Fern to her '
                'mother as they were setting the table.</p>')
        assert lines(html) == [
            '"Where is Papa going with that ax?" said Fern to her mother as '
            'they were setting the table.'
        ]

    def test_word_inside_inline_tag_survives_sentence_filter(self):
        html = "<p>He grabbed the <strong>hatchet</strong> and swung hard at the tree.</p>"
        out = _sentence_candidates(lines(html))
        assert len(out) == 1
        assert "hatchet" in out[0]

    def test_multiple_inline_kinds(self):
        html = "<p>A <a href='x'>link</a>, an <i>italic</i>, a <span>span</span> and <b>bold</b> all inline.</p>"
        assert lines(html) == ["A link, an italic, a span and bold all inline."]

    def test_block_tags_still_split(self):
        """只改行内标签的判定, 块级标签仍然是段落边界。"""
        html = "<p>First sentence here.</p><p>Second sentence here.</p><div>Third one.</div>"
        assert lines(html) == ["First sentence here.", "Second sentence here.", "Third one."]

    def test_unknown_tag_still_treated_as_block(self):
        """未列进 _INLINE_TAGS 的标签保守当块级处理 —— 与旧行为一致, 不误改。"""
        html = "<p>Before.</p><weird>After.</weird>"
        assert lines(html) == ["Before.", "After."]


class TestSourceLineWrapping:
    def test_paragraph_wrapped_across_source_lines_is_joined(self):
        """calibre 那类把一个段落硬折成多行的 HTML: 折行是排版, 不是句子边界。"""
        html = "<p>Line one\n   wrapped by calibre onto\n   three source lines.</p>"
        assert lines(html) == ["Line one wrapped by calibre onto three source lines."]


class TestHeadingTitlesRecovered:
    def test_frindle_style_title_with_anchor(self):
        """Frindle: <p class="ChapterTitle"><a>真标题</a></p>。旧实现 <a> 被换成换行,
        [[HEADING]] 后面成了空的 → 21 章全部退回同一个 TOC 兜底标题('Nick')。"""
        html = ('<p class="ChapterTitle"><a name="ch01" id="ch01">Chapter One - Nick</a></p>'
                '<p>IF YOU ASKED the kids at Lincoln Elementary School about it.</p>')
        assert lines(html)[0] == "[[HEADING]]Chapter One - Nick"

    def test_hatchet_style_nested_heading(self):
        """Hatchet: <h2><a><span>4</span></a></h2>。2026-08-16 试过"向后吸收下一行"的
        启发式来抢救, 实测会误吞正文导致丢句而放弃 —— 按块级/行内语义区分才是正解。"""
        html = "<h2><a><span>4</span></a></h2><p>Brian looked out the window.</p>"
        assert lines(html)[0] == "[[HEADING]]4"

    def test_plain_heading_unchanged(self):
        html = "<h1>Chapter One</h1><p>Body.</p>"
        assert lines(html) == ["[[HEADING]]Chapter One", "Body."]


class TestImageMarkersSurvive:
    def test_img_marker_still_isolated_on_its_own_line(self):
        """[[IMG:src]] 记号要独占一行 —— _file_sections 靠它算图片在段落流里的位置。"""
        html = '<p>Before the picture.</p><img src="images/a.jpg"/><p>After it.</p>'
        assert lines(html) == ["Before the picture.", "[[IMG:images/a.jpg]]", "After it."]

    def test_img_inside_paragraph_does_not_swallow_text(self):
        html = '<p>Text before <img src="i/x.png"/> text after.</p>'
        assert lines(html) == ["Text before", "[[IMG:i/x.png]]", "text after."]


class TestEntitiesAndWhitespace:
    def test_nbsp_collapses_to_single_space(self):
        html = "<p>Two&nbsp;&nbsp;words here.</p>"
        assert lines(html) == ["Two words here."]

    def test_block_mark_sentinel_never_leaks_into_output(self):
        """哨兵 \\x00 是内部实现细节, 绝不能出现在正文里。"""
        html = "<p>Some text</p><div>More</div>"
        assert "\x00" not in _strip_tags(html)
