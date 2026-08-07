"""
pipeline/nlp.py —— spaCy 分句 + segments + 短语候选

2.4 的核心: segments/phrasal_verbs 从 LLM 手里拿走。
- segments: spaCy en_core_web_sm → map_pos 到 aidu 13 类
- phrasal_verbs: 依存树 prt 直出 (零对齐错误)

关键契约: segments 下标 = 全句物理序 (标点独立占位), phrasal_verbs.indices 指向该下标。
"""
from __future__ import annotations

from aidulc_prep.core.models import Book, Chapter, PhrasalVerb, Segment, Sentence
from aidulc_prep.core.pos_map import map_pos

# spaCy dep 里短语动词小品词的标记
PRT_DEPS = {"prt"}
# prt 必须挂在动词头上
PRT_HEAD_POS = {"VERB", "AUX"}


def process_chapter_nlp_batch(chapter: Chapter, nlp, batch_size: int = 512) -> Chapter:
    """G3: 用 nlp.pipe 批量处理章节句子 (避免逐句调用, 长书吞吐提升)。

    与 process_chapter_nlp 行为一致 (段落展开为多句 + segments + 短语), 但一次 pipe 一批。
    """
    texts = [s.original_text for s in chapter.sentences]
    docs = list(nlp.pipe(texts, batch_size=batch_size))
    expanded: list[Sentence] = []
    for sent, doc in zip(chapter.sentences, docs):
        if not sent.original_text.strip():
            sent.status = "failed"
            sent.failed_stages.append("nlp")
            expanded.append(sent)
            continue
        spacy_sents = [s for s in doc.sents if s.text.strip()]
        if not spacy_sents:
            sent.status = "failed"
            sent.failed_stages.append("nlp")
            expanded.append(sent)
            continue
        for sp in spacy_sents:
            if not _has_content(sp.text.strip()):
                continue
            seg_sent = _sentence_from_spacy(sp)
            expanded.append(seg_sent)
    chapter.sentences = expanded
    return chapter


def _has_content(text: str) -> bool:
    """句子是否值得保留: 无字母/纯标点碎片 (spaCy 会把孤立句号/引号拆成句) 直接丢弃。
    字母 < 3 的碎片 (如 '.' '\"' '[' '.\xa0.') 交给 loader 层过滤, 这里是最后一层防线。"""
    if not text:
        return False
    letters = sum(1 for c in text if c.isalpha())
    return letters >= 3


def _sentence_from_spacy(sp) -> Sentence:
    """把一个 spaCy sentence 转成 Sentence (segments + 短语候选)。"""
    seg_sent = Sentence(original_text=sp.text.strip())
    segments: list[Segment] = []
    index_to_token: dict[int, object] = {}
    for tok in sp:
        seg = Segment(word=tok.text, pos=map_pos(tok.pos_, tok.tag_), lemma=tok.lemma_)
        segments.append(seg)
        index_to_token[len(segments) - 1] = tok
    seg_sent.segments = segments

    pvs: list[PhrasalVerb] = []
    for idx, tok in index_to_token.items():
        if tok.dep_ in PRT_DEPS and tok.head.pos_ in PRT_HEAD_POS:
            head_idx = _find_seg_idx(segments, tok.head.text)
            if head_idx is None:
                continue
            existing = next((pv for pv in pvs if pv.indices and pv.indices[0] == head_idx), None)
            if existing:
                existing.indices.append(idx)
                existing.text = " ".join([segments[i].word for i in existing.indices])
            else:
                pvs.append(PhrasalVerb(
                    text=f"{tok.head.text} {tok.text}",
                    indices=[head_idx, idx],
                    lemma="",
                    translation="",
                ))
    seg_sent.phrasal_verbs = pvs
    return seg_sent


def process_chapter_nlp(chapter: Chapter, nlp) -> Chapter:
    """对一章做 nlp: 分句 + segments + 短语候选。nlp 是已加载的 spaCy pipeline。

    审查确认 (2026-08-04): 旧实现只取 doc.sents 的第一句, 同段落后续句子全部丢失。
    现在一个段落 (Sentence.original_text) 可能含多个 spaCy 句子 —— 每个 spaCy 句子
    生成独立的 Sentence 对象, 段落下标连续追加, 保持章节内句子顺序。
    """
    expanded: list[Sentence] = []
    for sent in chapter.sentences:
        if not sent.original_text.strip():
            sent.status = "failed"
            sent.failed_stages.append("nlp")
            expanded.append(sent)
            continue
        doc = nlp(sent.original_text)
        spacy_sents = [s for s in doc.sents if s.text.strip()]
        if not spacy_sents:
            sent.status = "failed"
            sent.failed_stages.append("nlp")
            expanded.append(sent)
            continue
        for sp in spacy_sents:
            if not _has_content(sp.text.strip()):
                continue
            seg_sent = Sentence(original_text=sp.text.strip())
            segments: list[Segment] = []
            index_to_token: dict[int, object] = {}
            for tok in sp:
                seg = Segment(word=tok.text, pos=map_pos(tok.pos_, tok.tag_), lemma=tok.lemma_)
                segments.append(seg)
                index_to_token[len(segments) - 1] = tok

            seg_sent.segments = segments

            # 短语动词候选: prt → 动词头
            pvs: list[PhrasalVerb] = []
            for idx, tok in index_to_token.items():
                if tok.dep_ in PRT_DEPS and tok.head.pos_ in PRT_HEAD_POS:
                    head_idx = _find_seg_idx(segments, tok.head.text)
                    if head_idx is None:
                        continue
                    existing = next((pv for pv in pvs if pv.indices and pv.indices[0] == head_idx), None)
                    if existing:
                        existing.indices.append(idx)
                        existing.text = " ".join([segments[i].word for i in existing.indices])
                    else:
                        pvs.append(PhrasalVerb(
                            text=f"{tok.head.text} {tok.text}",
                            indices=[head_idx, idx],
                            lemma="",
                            translation="",
                        ))
            seg_sent.phrasal_verbs = pvs
            expanded.append(seg_sent)
    chapter.sentences = expanded
    return chapter


def _find_seg_idx(segments: list[Segment], word: str) -> int | None:
    for i, s in enumerate(segments):
        if s.word == word:
            return i
    return None


def sentence_split(text: str, nlp) -> list[str]:
    """纯函数式分句 (测试用): 返回句子列表。"""
    doc = nlp(text)
    return [s.text.strip() for s in doc.sents if s.text.strip()]
