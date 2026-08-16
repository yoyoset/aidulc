"""scripts/audit_sources.py —— 对书库里已登记的源书批量跑 S1-S6 体检, 输出一张表。

一次性运维脚本(不进 prep 包、不进打包), 用途见 docs/GOAL_2026-08-16_STDIMPORT.md
第 2 节: 在改重跑/导入逻辑之前, 先把现有源书按"达标 / 只有警告 / 不达标"分三类,
决定每本书用哪种重跑方式。

判据实现不在这里 —— 复用 aidulc_prep.application.book_audit.evaluate_book,
跟导入把关、备料 parse 拦截是同一份代码。

用法:
    prep\\.venv\\Scripts\\python.exe scripts\\audit_sources.py [--db <data.db 路径>] [--json]
不传 --db 时按 Tauri 的约定自己找: %APPDATA%/aidulc/data_root.txt → <data_root>/data.db
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "prep")))

from aidulc_prep.application.book_audit import evaluate_book  # noqa: E402

_VERDICT_LABEL = {"ok": "达标", "warn": "警告", "block": "不达标"}


def default_db_path() -> str:
    appdata = os.environ.get("APPDATA", "")
    marker = os.path.join(appdata, "aidulc", "data_root.txt")
    if os.path.isfile(marker):
        with open(marker, encoding="utf-8") as f:
            root = f.read().strip()
        if root:
            return os.path.join(root, "data.db")
    return os.path.join(appdata, "aidulc", "data.db")


def list_sources(db_path: str) -> list[tuple[str, str]]:
    """返回 [(title, source_path)]。只读打开, 绝不写用户的库。"""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT title, source_path FROM books WHERE kind='original' ORDER BY title"
        ).fetchall()
    finally:
        conn.close()
    return [(r[0], r[1]) for r in rows]


def short(title: str, n: int = 28) -> str:
    """书名统一截断, 表格才对得齐(源书名普遍带一长串站点后缀)。"""
    t = title.split(" (")[0]
    return t if len(t) <= n else t[: n - 1] + "…"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="audit_sources")
    ap.add_argument("--db", default="", help="data.db 路径 (默认自动定位)")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON 而不是表格")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    db_path = args.db or default_db_path()
    if not os.path.isfile(db_path):
        print(f"找不到数据库: {db_path}", file=sys.stderr)
        return 2
    sources = list_sources(db_path)
    if not sources:
        print("书库里没有 kind=original 的源书", file=sys.stderr)
        return 1

    results = []
    for title, path in sources:
        if not os.path.isfile(path):
            results.append({"path": path, "title": title, "verdict": "block",
                            "chapters": 0, "sentences": 0, "uncovered": 0, "real_missing": [],
                            "untitled": 0, "non_body_titles": [], "anomalies": [],
                            "issues": [{"code": "S0", "level": "block", "message": "源文件已不存在"}]})
            continue
        r = evaluate_book(path)
        r["title"] = title
        results.append(r)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    header = f"{'书名':<30}{'判定':<8}{'章':>5}{'句':>7}{'未覆盖':>7}{'真缺失':>7}{'无题':>6}  问题"
    print(header)
    print("-" * len(header))
    for r in results:
        codes = ",".join(i["code"] for i in r["issues"]) or "-"
        print(
            f"{short(r['title']):<30}{_VERDICT_LABEL.get(r['verdict'], r['verdict']):<8}"
            f"{r['chapters']:>5}{r['sentences']:>7}{r['uncovered']:>7}"
            f"{len(r['real_missing']):>7}{r['untitled']:>6}  {codes}"
        )
    print()
    for r in results:
        if not r["issues"]:
            continue
        print(f"# {short(r['title'], 40)}")
        for i in r["issues"]:
            print(f"    [{i['code']}/{i['level']}] {i['message']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
