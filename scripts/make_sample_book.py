"""生成 aidulc 自测素材:
1. contracts/fixtures/sample_book/ —— 最小文本 EPUB (3 章, 内容为已知答案的公版文本)
2. 已知答案: 章节数 / 句子数 / 每句 segments 由测试断言, 不依赖真实模型

素材用 Project Gutenberg 公版 (Alice 第一章前几段, 自己打字, 不下载) —— Phase 1 DoD:
"用公版素材如 Project Gutenberg, 不用有版权的书"。
"""
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "contracts" / "fixtures" / "sample_book"

MIMETYPE = "application/epub+zip"

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">sample-alice</dc:identifier><dc:title>Alice's Adventures in Wonderland (sample)</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    {items}
  </manifest>
  <spine>
    {spine}
  </spine>
</package>
"""

XHTML = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {n}</title></head>
<body><h1>Chapter {n}. {title}</h1>
{paras}
</body></html>
"""

# 自己打字的公版文本 (Alice in Wonderland, 1865, 公版)
CHAPTERS = {
    1: ("Down the Rabbit-Hole", [
        "Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do.",
        "Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it.",
        "So she was considering in her own mind whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies.",
        "Suddenly a White Rabbit with pink eyes ran close by her.",
    ]),
    2: ("The Pool of Tears", [
        "Curiouser and curiouser! cried Alice.",
        "Now I am opening out like the largest telescope that ever was.",
        "Goodbye feet! for when I look down at my feet, they seem almost out of sight.",
    ]),
    3: ("A Caucus-Race and a Long Tale", [
        "They were indeed a queer-looking party that assembled on the bank.",
        "The first question of course was, how to get dry again.",
        "The best thing to get us dry would be a Caucus-race.",
    ]),
}

# 已知答案 (nlp 阶段 golden): 第 1 章每句的 segments 前几项
GOLDEN_CH1_SEGMENTS = [
    [["Alice", "NOUN", "Alice"], ["was", "VERB", "be"], ["beginning", "VERB", "begin"], ["to", "PART", "to"]],
    [["Once", "ADV", "once"], ["or", "CONJ", "or"], ["twice", "ADV", "twice"], ["she", "PRON", "she"]],
    [["So", "ADV", "so"], ["she", "PRON", "she"], ["was", "VERB", "be"], ["considering", "VERB", "consider"]],
    [["Suddenly", "ADV", "suddenly"], ["a", "DET", "a"], ["White", "ADJ", "white"], ["Rabbit", "NOUN", "rabbit"]],
]


def make_epub(out: Path = OUT / "alice_sample.epub") -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    items = []
    spine = []
    chapters_xhtml = []
    for n, (title, paras) in CHAPTERS.items():
        iid = f"ch{n}"
        items.append(f'<item id="{iid}" href="ch{n}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{iid}"/>')
        body = "\n".join(f"<p>{p}</p>" for p in paras)
        chapters_xhtml.append((f"ch{n}.xhtml", XHTML.format(n=n, title=title, paras=body)))
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), MIMETYPE, compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/content.opf", OPF.format(items="\n    ".join(items), spine="\n    ".join(spine)), compress_type=zipfile.ZIP_DEFLATED)
        for name, xhtml in chapters_xhtml:
            zf.writestr(f"OEBPS/{name}", xhtml, compress_type=zipfile.ZIP_DEFLATED)
    return out


if __name__ == "__main__":
    p = make_epub()
    print(f"wrote {p} ({p.stat().st_size} bytes)")
