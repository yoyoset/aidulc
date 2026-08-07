"""scripts/bench_report.py —— M0 基线: 可重复的性能/体积报告

产出 JSON + 摘要输出。覆盖:
- Python: loader 耗时/RSS, nlp 分句吞吐, 章节数/句子数
- 书包: bookpack.json 体积, audio 目录体积
- 包体积: Tauri exe / prep 侧车 / 前端 (若存在)
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "prep")))

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def dir_size(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return total


def measure_python(text_path: str) -> dict:
    from aidulc_prep.pipeline.loader import load_book

    t0 = time.time()
    book = load_book(text_path)
    t_load = time.time() - t0

    t0 = time.time()
    import spacy
    nlp = spacy.load("en_core_web_sm")
    from aidulc_prep.pipeline.nlp import process_chapter_nlp
    for ch in book.chapters:
        process_chapter_nlp(ch, nlp)
    t_nlp = time.time() - t0

    total_sents = book.sentence_count
    return {
        "loader_secs": round(t_load, 3),
        "nlp_secs": round(t_nlp, 3),
        "chapters": len(book.chapters),
        "sentences": total_sents,
        "nlp_sentences_per_sec": round(total_sents / max(t_nlp, 1e-6), 1),
    }


def measure_pack(bookpack_dir: str) -> dict:
    if not os.path.exists(bookpack_dir):
        return {}
    bp = os.path.join(bookpack_dir, "bookpack.json")
    audio = os.path.join(bookpack_dir, "audio")
    return {
        "bookpack_json_bytes": os.path.getsize(bp) if os.path.exists(bp) else 0,
        "audio_bytes": dir_size(audio) if os.path.exists(audio) else 0,
    }


def measure_build() -> dict:
    result = {}
    candidates = {
        "tauri_exe": r"F:\my_ai\aidulc\src-tauri\target\debug\aidulc.exe",
        "prep_sidecar": r"F:\my_ai\aidulc\prep\build\stage7\aidulc-prep",
        "reader_frontend": r"F:\my_ai\aidulc\reader",
    }
    for name, path in candidates.items():
        if os.path.exists(path):
            if os.path.isfile(path):
                result[name] = os.path.getsize(path)
            else:
                result[name] = dir_size(path)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default=r"F:\my_ai\aidulc\contracts\fixtures\perf\perf_1000.txt")
    ap.add_argument("--bookpack", default=r"F:\my_ai\aidulc\.spikes\out\p0_verify")
    ap.add_argument("--out", default=r"F:\my_ai\aidulc\.spikes\bench_report.json")
    args = ap.parse_args()

    report = {
        "text": args.text,
        "env": {
            "python": sys.version.split()[0],
            "platform": sys.platform,
        },
        "python": measure_python(args.text),
        "bookpack": measure_pack(args.bookpack),
        "build": measure_build(),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
