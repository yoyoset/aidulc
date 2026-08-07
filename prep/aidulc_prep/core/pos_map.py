"""
core/pos_map.py —— spaCy POS/tag → aidu 13 类标签 (纯函数, 表驱动单测)

aidu POS 枚举 (schema_constants.js): NOUN VERB ADJ ADV PRON PREP CONJ PART INTJ DET NUM PUNCT STOP
spaCy 用 Universal Dependencies: ADJ ADP ADV AUX CCONJ DET INTJ NOUN NUM PART PRON PROPN PUNCT SCONJ SYM VERB X
"""
from __future__ import annotations

# spaCy pos_ → aidu (spaCy 输出 UD 大写标签)
POS_MAP = {
    "ADJ": "ADJ",
    "ADP": "PREP",
    "ADV": "ADV",
    "AUX": "VERB",        # was/have/be → 按 aidu 惯例归 VERB
    "CCONJ": "CONJ",
    "DET": "DET",
    "INTJ": "INTJ",
    "NOUN": "NOUN",
    "NUM": "NUM",
    "PART": "PART",       # to/not/'s
    "PRON": "PRON",
    "PROPN": "NOUN",      # aidu 无 propn, 专名归 NOUN (提案 13 类表里 propn→noun)
    "PUNCT": "PUNCT",
    "SCONJ": "CONJ",
    "SYM": "PUNCT",
    "VERB": "VERB",
    "X": "X",
    "": "X",
}

# spaCy tag_ 的一些特殊修正 (tag 比 pos 精确的情况)
TAG_OVERRIDES = {
    "TO": "PART",   # 不定式 to (spaCy pos 常给 PART 或 X)
    "POS": "PART",  # 所有格 's
    "PRP$": "DET",  # my/your → 物主限定词, aidu 更常见标 DET
    "WP$": "DET",
    "EX": "PRON",   # there
    "RP": "PART",   # 短语动词小品词 up/off (prt)
}

# M 系列: 枚举单一事实源 → core.models.AIDU_POS
from aidulc_prep.core.models import AIDU_POS as AIDU_POS_ENUM


def map_pos(pos: str, tag: str = "") -> str:
    """spaCy pos_ (+可选 tag_) → aidu 13 类。未知一律回退 X (aidu 无 X 时用 STOP? 不, 用原 pos 大写截断)。"""
    if tag and tag in TAG_OVERRIDES:
        return TAG_OVERRIDES[tag]
    mapped = POS_MAP.get(pos or "", "X")
    return mapped
