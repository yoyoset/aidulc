"""scripts/gen_perf_book.py —— 生成不同规模的性能测试书 (M0 基线)

生成 deterministic 的英文小说文本, 用于 1k/10k/100k 句规模基准。
- 输出 TXT 文件 (loader 直接可用)
- 章节数可配, 每章段落数可配
- 内容用公版风格句子重复组合, 保证可复现
"""
import argparse
import hashlib
import os
import random
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

SENTENCE_POOL = [
    "Alice was beginning to get very tired of sitting by her sister on the bank.",
    "The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down.",
    "Either the well was very deep, or she fell very slowly, for she had plenty of time as she went down.",
    "She generally gave herself very good advice, though she very seldom followed it.",
    "The Queen turned crimson with fury, and, after glaring at her for a moment like a wild beast, screamed.",
    "It was all very well to say Drink me, but the wise little Alice was not going to do that in a hurry.",
    "Curiouser and curiouser! cried Alice; she was so much surprised that she could not help a little shriek.",
    "The Mock Turtle sighed deeply, and drew the back of one flapper across his eyes.",
    "Would the fall never come to an end? she asked herself, wondering how many miles she had fallen by this time.",
    "She was close behind it when she turned the corner, but the Rabbit was no longer to be seen.",
    "The table was a large one, but the three were all crowded together at one corner of it.",
    "She felt that she was dozing off, and had just begun to dream that she was walking hand in hand with Dinah.",
    "There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself.",
    "Down, down, down. Would the fall never come to an end? she said aloud, wondering what would happen next.",
    "The pool was getting quite crowded with the birds and animals that had fallen into it.",
    "She took down a jar from one of the shelves as she passed; it was labelled ORANGE MARMALADE.",
]


def gen_book(total_sentences: int, sentences_per_para: int = 8, chapters: int = 10, seed: int = 42) -> str:
    rng = random.Random(seed)
    out = []
    per_chapter = total_sentences // chapters
    for c in range(chapters):
        out.append(f"CHAPTER {c + 1}\n")
        count = 0
        while count < per_chapter:
            para = []
            for _ in range(sentences_per_para):
                if count >= per_chapter:
                    break
                para.append(rng.choice(SENTENCE_POOL))
                count += 1
            out.append(" ".join(para) + "\n")
            out.append("\n")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sentences", type=int, default=1000)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.out is None:
        out = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "contracts", "fixtures", "perf",
            f"perf_{args.sentences}.txt",
        )
    else:
        out = args.out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    text = gen_book(args.sentences)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    h = hashlib.sha256(text.encode()).hexdigest()[:16]
    print(f"wrote {out}: {len(text)} chars, sha256={h}")


if __name__ == "__main__":
    main()
