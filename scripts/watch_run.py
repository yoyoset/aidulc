"""scripts/watch_run.py —— 跑批期间的定点体检(只读, 绝不写用户数据)

用途: 2026-08-17 夜间跑批时每小时抽查一次, 看新落地的几项改动是不是真按设计在起作用:
  1. 统一标准 —— 这本书解析出的章/句数, 跟导入体检时的判定对不对得上
  2. 章节 —— 成品里有多少章标题退化成 (Untitled)
  3. 字数 —— 讲解实际长度分布 vs 档案里设的 explain_max_chars(K33 是否真的生效)
  4. 速度 —— run.log 里 TIMING 行的每次调用耗时和阶段吞吐

判据不在这里重新实现: 章/句数走 aidulc_prep.application.book_audit.evaluate_book,
跟导入把关、备料 parse 是同一份。

用法: prep\\.venv\\Scripts\\python.exe scripts\\watch_run.py [--db E:/aidulc_data/data.db]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "prep")))

DEFAULT_DB = "E:/aidulc_data/data.db"

_TIMING = re.compile(r"TIMING stage=(\w+).*?elapsed=([\d.]+)s")


def jobs(db_path: str) -> list[dict]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT id, book_path, status, stage, progress, output_dir, profile_id, error"
            " FROM jobs ORDER BY updated_at DESC"
        ).fetchall()
    finally:
        conn.close()
    keys = ["id", "book_path", "status", "stage", "progress", "output_dir", "profile_id", "error"]
    return [dict(zip(keys, r)) for r in rows]


def profile_limits(out_dir: str) -> tuple[int, int, str]:
    """从这次任务的 job_request.json 快照读讲解上限/门槛/策略(不是读当前档案表——
    快照才是这本书实际跑的时候用的那份)。"""
    try:
        with open(os.path.join(out_dir, "job_request.json"), encoding="utf-8") as f:
            p = json.load(f).get("profile", {})
        return (
            int(p.get("explain_max_chars", 0)),
            int(p.get("explain_min_sentence_chars", 0)),
            str(p.get("explain_strategy", "")),
        )
    except Exception:
        return (0, 0, "")


def explain_stats(out_dir: str, limit: int = 4000) -> dict:
    """扫 checkpoints 里已落地的讲解, 统计长度分布 + 超限比例。"""
    root = os.path.join(out_dir, "checkpoints")
    lens: list[int] = []
    src_lens: list[int] = []
    skipped_short = 0
    if not os.path.isdir(root):
        return {"n": 0}
    for ch in sorted(os.listdir(root)):
        d = os.path.join(root, ch)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if len(lens) >= limit:
                break
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            ex = data.get("explanation") or ""
            orig = data.get("original_text") or ""
            if orig:
                src_lens.append(len(orig))
            if ex:
                lens.append(len(ex))
            elif data.get("translation"):
                skipped_short += 1
    if not lens:
        return {"n": 0, "translated_no_explain": skipped_short}
    lens.sort()
    return {
        "n": len(lens),
        "median": int(statistics.median(lens)),
        "p90": lens[int(len(lens) * 0.9) - 1],
        "max": lens[-1],
        "src_median": int(statistics.median(src_lens)) if src_lens else 0,
        "translated_no_explain": skipped_short,
    }


def timing_stats(out_dir: str) -> dict:
    """run.log 里的 TIMING 行 → 每阶段调用次数和单次耗时中位数。"""
    path = os.path.join(out_dir, "run.log")
    by_stage: dict[str, list[float]] = {}
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                m = _TIMING.search(line)
                if m:
                    by_stage.setdefault(m.group(1), []).append(float(m.group(2)))
    except OSError:
        return {}
    return {
        s: {"calls": len(v), "median_s": round(statistics.median(v), 2),
            "total_min": round(sum(v) / 60, 1)}
        for s, v in by_stage.items()
    }


def pack_chapters(out_dir: str) -> dict:
    """成品 bookpack.json 的章节标题健康度(跑完才有)。"""
    path = os.path.join(out_dir, "bookpack.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            bp = json.load(f)
    except Exception:
        return {}
    titles = [c.get("title", "") for c in bp.get("chapters", [])]
    if not titles:
        return {}
    untitled = sum(1 for t in titles if t.strip() == "(Untitled)")
    return {"chapters": len(titles), "untitled": untitled,
            "untitled_pct": round(untitled / len(titles) * 100, 1),
            "sample": titles[:6]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="watch_run")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--audit", action="store_true",
                    help="额外对源书跑一次 S1-S6 体检(慢, 每本几秒)")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    js = jobs(args.db)
    active = [j for j in js if j["status"] in ("running", "queued", "paused")]
    recent = [j for j in js if j["status"] in ("done", "partial", "failed")][:6]

    print("## 队列")
    for j in js[:8]:
        name = j["book_path"].split("\\")[-1].split(" (")[0]
        print(f"  {j['status']:<9} {j['stage'] or '-':<10} {j['progress']:>5.1f}%  "
              f"档案={j['profile_id']:<8} {name}"
              + (f"  ERR={j['error'][:60]}" if j.get("error") else ""))
    print(f"  (活跃 {len(active)} / 完成或失败 {len(recent)})")

    for j in js[:3]:
        if j["status"] not in ("running", "done", "partial", "failed"):
            continue
        name = j["book_path"].split("\\")[-1].split(" (")[0]
        out = j["output_dir"]
        mx, mn, strategy = profile_limits(out)
        print(f"\n## {name}  [{j['status']}/{j['stage']}]")
        print(f"  档案快照: 策略={strategy} 字数上限={mx} 触发门槛={mn}")
        es = explain_stats(out)
        if es.get("n"):
            over = "超限" if mx and es["median"] > mx else "在限内"
            print(f"  讲解长度: n={es['n']} 中位={es['median']} p90={es['p90']} 最长={es['max']}"
                  f" (原文中位={es['src_median']}) → {over}")
            print(f"  已翻译但无讲解(门槛跳过或未跑到): {es['translated_no_explain']}")
        else:
            print(f"  讲解: 还没有落地 (已翻译无讲解 {es.get('translated_no_explain', 0)} 句)")
        ts = timing_stats(out)
        for stage, v in sorted(ts.items()):
            print(f"  速度 {stage}: {v['calls']} 次, 单次中位 {v['median_s']}s, 累计 {v['total_min']} 分钟")
        pc = pack_chapters(out)
        if pc:
            print(f"  成品章节: {pc['chapters']} 章, (Untitled) {pc['untitled']} 章 ({pc['untitled_pct']}%)")
            print(f"  标题样本: {pc['sample']}")

        if args.audit:
            from aidulc_prep.application.book_audit import evaluate_book
            r = evaluate_book(j["book_path"])
            print(f"  源书体检: {r['verdict']} {r['chapters']}章/{r['sentences']}句 "
                  f"issues={[i['code'] for i in r['issues']]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
