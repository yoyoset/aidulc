"""Phase 2 测试: loader (EPUB/TXT) + nlp (分句/segments/短语)

DoD: 纯函数单测覆盖章节切分 + POS 映射; 对自测素材输出与 golden 一致。
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.errors import InputError
from aidulc_prep.core.models import Book, Chapter, Sentence
from aidulc_prep.pipeline.loader import load_book
from aidulc_prep.pipeline.loader.txt import split_txt_into_chapters

FIXTURES = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "contracts", "fixtures"))
SAMPLE_EPUB = os.path.join(FIXTURES, "sample_book", "alice_sample.epub")

nlp = None


def _get_nlp():
    global nlp
    if nlp is None:
        import spacy
        nlp = spacy.load("en_core_web_sm")
    return nlp


class TestLoaderTxt:
    def test_split_into_chapters(self):
        text = "Para one.\n\nPara two.\n\nPara three.\n\nPara four.\n\nPara five.\n\nPara six.\n\nPara seven.\n\nPara eight.\n\nPara nine."
        chapters = split_txt_into_chapters(text, "T")
        assert len(chapters) == 2  # 8 段一章 → 9 段 = 2 章
        assert len(chapters[0].sentences) == 8
        assert len(chapters[1].sentences) == 1
        assert chapters[0].sentences[0].original_text == "Para one."

    def test_empty_text(self):
        chapters = split_txt_into_chapters("   \n\n  ", "T")
        assert len(chapters) == 1
        assert chapters[0].sentences == []

    def test_unsupported_ext(self):
        with pytest.raises(InputError):
            load_book("book.docx")

    def test_missing_file(self):
        with pytest.raises(InputError):
            load_book("nonexistent.epub")


class TestLoaderEpub:
    def test_sample_epub_structure(self):
        book = load_book(SAMPLE_EPUB)
        assert book.title == "Alice's Adventures in Wonderland (sample)"
        assert len(book.chapters) == 3
        # 第 1 章 4 句 (golden)
        ch1 = book.chapters[0]
        assert len(ch1.sentences) == 4
        assert ch1.sentences[0].original_text.startswith("Alice was beginning to get very tired")
        # 第 2 章 3 句
        assert len(book.chapters[1].sentences) == 3
        # 第 3 章 3 句
        assert len(book.chapters[2].sentences) == 3

    def test_chapter_titles(self):
        book = load_book(SAMPLE_EPUB)
        assert book.chapters[0].title == "Chapter 1. Down the Rabbit-Hole"
        assert book.chapters[1].title == "Chapter 2. The Pool of Tears"

    def test_real_world_epub_href_first_manifest(self):
        """真实书兼容 (z-lib): <item href=... id=...> 属性顺序不定 (旧正则 0 匹配 bug)。
        用真实用户书文件验证 (存在时), 否则用内联 OPF 片段测 manifest 解析。"""
        from aidulc_prep.pipeline.loader.epub import load_epub, _is_real_sentence
        import os
        real = r"C:\Users\yoyos\Downloads\The Reign of Wolf 21 The Saga of Yellowstones Legendary Druid Pack (Rick McIntyre) (z-library.sk, 1lib.sk, z-lib.sk).epub"
        if os.path.exists(real):
            book = load_epub(real)
            assert len(book.chapters) > 10, f"真实书应解析出多章, 实得 {len(book.chapters)}"
            # 质量修复 3: 章节用 nav.xhtml TOC 划分 (真实标题, 非 "Chapter N")
            assert book.chapters[0].title != "Chapter 1", "章节应来自 TOC 而非 spine 序号"
            assert any("First Winter" in ch.title for ch in book.chapters), \
                "应有真实章节标题 (1. First Winter)"
            assert not any(ch.title.lower().startswith(("title page", "contents")) for ch in book.chapters), \
                "封面/目录页不应成为章节"
            # 质量修复验证: 过滤后不应有单字符/纯数字句 (页码/章节号)
            all_texts = [s.original_text for ch in book.chapters for s in ch.sentences]
            junk = [t for t in all_texts if not _is_real_sentence(t)]
            assert not junk, f"仍有垃圾句: {junk[:5]}"
            short = [t for t in all_texts if len(t) <= 2]
            assert not short, f"仍有短句: {short[:5]}"
            # 质量修复 2: 索引/参考文献页整章过滤 (Wolf 21 实测 872 句索引全失败)
            total = len(all_texts)
            assert total < 3000, f"索引页未过滤: {total} 句 (应 ~888)"
            assert not any(t.startswith(';') or t.startswith(',') for t in all_texts), \
                f"仍有索引续行: {[t for t in all_texts if t.startswith(';') or t.startswith(',')][:3]}"
        else:
            # 无真实文件时: 验证 manifest 顺序无关解析 (内联 OPF)
            import zipfile, io
            opf = '''<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item href="html/ch1.xhtml" id="ch1" media-type="application/xhtml+xml"/>
    <item href="html/ch2.xhtml" id="ch2" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>'''
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                zf.writestr("META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
                zf.writestr("book.opf", opf)
                zf.writestr("html/ch1.xhtml", "<html><body><p>First chapter sentence one.</p><p>Second sentence.</p></body></html>")
                zf.writestr("html/ch2.xhtml", "<html><body><p>Second chapter text.</p></body></html>")
            buf.seek(0)
            tmp = os.path.join(os.path.dirname(__file__), "..", "_tmp_href_first.epub")
            with open(tmp, "wb") as f:
                f.write(buf.read())
            try:
                book = load_epub(tmp)
                assert len(book.chapters) == 2
                assert len(book.chapters[0].sentences) == 2
            finally:
                os.remove(tmp)


class TestNlp:
    def test_sentence_split(self):
        from aidulc_prep.pipeline.nlp import sentence_split
        text = "Alice was tired. She fell asleep. Then she woke up!"
        sents = sentence_split(text, _get_nlp())
        assert len(sents) == 3

    def test_segments_match_golden(self):
        """golden: 第 1 章第 1 句的前 4 个 segments"""
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        book = load_book(SAMPLE_EPUB)
        ch = process_chapter_nlp(book.chapters[0], _get_nlp())
        s0 = ch.sentences[0]
        expected = [
            ["Alice", "NOUN", "Alice"], ["was", "VERB", "be"],
            ["beginning", "VERB", "begin"], ["to", "PART", "to"],
        ]
        for got, exp in zip(s0.segments[:4], expected):
            assert [got.word, got.pos, got.lemma] == exp, f"{got} != {exp}"

    def test_punct_is_separate_segment(self):
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        book = load_book(SAMPLE_EPUB)
        ch = process_chapter_nlp(book.chapters[0], _get_nlp())
        s0 = ch.sentences[0]
        assert s0.segments[-1].pos == "PUNCT"
        assert s0.segments[-1].word == "."

    def test_phrasal_verb_detection(self):
        """prt 直出短语动词 (2.4 核心承诺)"""
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[
            Sentence(original_text="He broke up with her last night."),
            Sentence(original_text="She gave up smoking."),
        ])
        process_chapter_nlp(ch, _get_nlp())
        pv0 = ch.sentences[0].phrasal_verbs
        assert len(pv0) == 1
        assert pv0[0].indices[0] == 1  # broke
        assert pv0[0].indices[1] == 2  # up
        # indices 指向 segments 物理下标
        s0 = ch.sentences[0]
        assert s0.segments[pv0[0].indices[0]].word == "broke"
        assert s0.segments[pv0[0].indices[1]].word == "up"
        pv1 = ch.sentences[1].phrasal_verbs
        assert len(pv1) == 1
        assert pv1[0].text == "gave up"

    def test_pos_mapping_on_real_sentence(self):
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[
            Sentence(original_text="The clever girl quickly ran away."),
        ])
        process_chapter_nlp(ch, _get_nlp())
        segs = ch.sentences[0].segments
        # 注意: spaCy 把 "away" 标为 ADV (dep=advmod), 不触发 prt 短语检测 ——
        # 这是已知局限 (记录在案): 副词性小品词依赖 prt 抓不到, v1 接受
        assert [s.pos for s in segs] == ["DET", "ADJ", "NOUN", "ADV", "VERB", "ADV", "PUNCT"]

    def test_whitespace_sentence_failed(self):
        from aidulc_prep.pipeline.nlp import process_chapter_nlp
        ch = Chapter(index=0, title="T", sentences=[Sentence(original_text="   ")])
        process_chapter_nlp(ch, _get_nlp())
        assert ch.sentences[0].status == "failed"
        assert "nlp" in ch.sentences[0].failed_stages
