"""application/book_audit.py —— 源书体检(S1-S6)的 I/O 层

core/standard.py 只做纯判定, 这里负责真的打开 EPUB、解析、算出 6 条判据需要的
原始指标。导入时把关(Rust 侧调 cli.py --audit-book)和手动体检脚本共用这一个入口。

2026-08-19: 加了 evaluate_book_fallback —— 判 block 的书自动走 pymupdf 兜底重解析
(loader/epub_fallback.py)再判一次, 用户拍板"不符合标准的自动尝试标准化转换"。
两条路径共用同一份"从 Book 对象算出六条判据原始指标"的逻辑(_judge_book), 不允许
再抄一遍——之前 evaluate_book 一处写死, 现在拆出来给两条调用方复用。
"""
from __future__ import annotations

import re

# S6 用: 章节标题命中前后言正则才算"混进正文", 但 NON_BODY_TOC 里还有
# `\d{1,4}$` / 罗马数字两条分支——真实章节标题本来就大量是纯数字("17")或
# 罗马数字, 拿它们当"前后言混入"会全是误报。这里先把纯数字/罗马数字标题排除。
_PURE_NUMBERING = re.compile(r"^[\divxlcdmIVXLCDM\s.\-]+$")


def _empty_result(path: str, error: str) -> dict:
    from aidulc_prep.core.standard import judge_standard, verdict

    issues = judge_standard(
        opened=False,
        chapter_count=0,
        sentence_count=0,
        real_missing=[],
        total_files=0,
        untitled_count=0,
        non_body_titles=[],
        anomalies=[],
        severe_anomalies=[],
    )
    return {
        "path": path,
        "title": "",
        "chapters": 0,
        "sentences": 0,
        "uncovered": 0,
        "real_missing": [],
        "untitled": 0,
        "distinct_titles": 0,
        "non_body_titles": [],
        "anomalies": [],
        "severe_anomalies": [],
        "error": error,
        "issues": [i.to_dict() for i in issues],
        "verdict": verdict(issues),
    }


def _judge_book(path: str, book, uncovered: list[str]) -> dict:
    """从已经解析好的 Book(不管来自原生解析还是 pymupdf 兜底)算出六条判据的
    原始指标并判定。两条调用方(evaluate_book / evaluate_book_fallback)共用。"""
    from aidulc_prep.core.health import detect_anomalies
    from aidulc_prep.core.standard import judge_standard, verdict
    from aidulc_prep.pipeline.loader.epub import NON_BODY_TOC, _UNTITLED_CHAPTER, classify_uncovered

    # classify_uncovered 靠重新打开 zip 用 _read_member 探测"真的读不到"——兜底路径
    # (pymupdf 按页而不是按 spine 文件走)不产出有意义的 uncovered 列表, 传空列表时
    # classify_uncovered 本身对空输入直接返回空, 零开销, 不需要为它分叉逻辑。
    real_missing = classify_uncovered(path, uncovered)
    titles = [c.title or "" for c in book.chapters]
    untitled = sum(1 for t in titles if t == _UNTITLED_CHAPTER)
    # 标题去重数(S5 的重名维度): 全书标题只剩个位数几个 = 章节列表无法区分
    distinct_titles = len({t.strip() for t in titles if t.strip()})
    non_body = [
        t
        for t in titles
        if t
        and not _PURE_NUMBERING.match(t.strip())
        and NON_BODY_TOC.match(t.strip())
    ]
    counts = [len(c.sentences) for c in book.chapters]
    anomalies = detect_anomalies(counts, real_missing)
    # 严重异常单独算(不靠 anomalies 的字符串匹配, 直接从句数重新判定):
    # 0 句章和 >1000 句巨章是无歧义信号, S4 对它们无条件报警。
    severe = [
        f"第 {i} 章{'无正文' if c == 0 else f' {c} 句(巨章)'}"
        for i, c in enumerate(counts, start=1)
        if c == 0 or c > 1000
    ]
    total_files = len(book.chapters) + len(uncovered)
    issues = judge_standard(
        opened=True,
        chapter_count=len(book.chapters),
        sentence_count=book.sentence_count,
        real_missing=real_missing,
        total_files=total_files,
        untitled_count=untitled,
        distinct_titles=distinct_titles,
        non_body_titles=non_body,
        anomalies=anomalies,
        severe_anomalies=severe,
    )

    return {
        "path": path,
        "title": book.title,
        "chapters": len(book.chapters),
        "sentences": book.sentence_count,
        "uncovered": len(uncovered),
        "real_missing": real_missing,
        "untitled": untitled,
        "distinct_titles": distinct_titles,
        "non_body_titles": non_body,
        "anomalies": anomalies,
        "severe_anomalies": severe,
        "issues": [i.to_dict() for i in issues],
        "verdict": verdict(issues),
    }


def evaluate_book(path: str) -> dict:
    """体检一本源书(原生解析), 返回可直接 json.dumps 的 dict
    (给 Rust 导入把关和体检脚本共用)。"""
    from aidulc_prep.pipeline.loader.epub import load_epub_with_spine_health

    try:
        book, uncovered = load_epub_with_spine_health(path)
    except Exception as e:
        return _empty_result(path, str(e))
    return _judge_book(path, book, uncovered)


def evaluate_book_fallback(path: str) -> dict:
    """体检一本源书(pymupdf 兜底解析), 只在 evaluate_book 判 block 之后调用。

    返回形状和 evaluate_book 完全一致(多一个 verdict 字段照旧), 调用方(标准化
    后台任务)拿这份结果的 verdict 决定 standardize_status 是 done 还是 failed。"""
    from aidulc_prep.pipeline.loader.epub_fallback import load_epub_fallback

    try:
        book, uncovered = load_epub_fallback(path)
    except Exception as e:
        return _empty_result(path, str(e))
    return _judge_book(path, book, uncovered)
