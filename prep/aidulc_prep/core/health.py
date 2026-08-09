"""core/health.py —— 处理前体检 (pre-flight) 的纯检测函数 (F39, 2026-08-10)

检测函数保持纯: 输入各章句数 + 未被任何章节覆盖的 spine 文件, 输出人话异常列表。
目标: 在烧几小时 GPU 之前拦住 F38 类问题 —— 银河系那本五部长篇正文在 TOC 没引用
的 spine 文件里, 旧体检 (只看 0/1/>1000 句) 一条都不撞, anomalies 为空。
"""
from __future__ import annotations

import statistics


def detect_anomalies(
    sentence_counts: list[int],
    uncovered_files: list[str] | None = None,
) -> list[str]:
    """章节异常检测 (纯函数, 无 I/O)。

    两条新防线 (都是 F38 类问题的直接判据):
    1. spine 覆盖率: 有文件没被任何章节覆盖 → 显式报出 (判定确定)。
    2. 句数离群: 章节句数远低于全书中位数 (count*3 < 中位数, 且中位数 > 3) →
       可疑正文丢失/碎片章。
    保留既有规则: 0 句 / 恰好 1 句 / >1000 句巨章。
    """
    anomalies: list[str] = []
    for f in uncovered_files or []:
        anomalies.append(f"spine 文件未被任何章节覆盖: {f}")
    n = len(sentence_counts)
    if n == 0:
        return anomalies
    mid = statistics.median(sentence_counts)
    for idx, count in enumerate(sentence_counts, start=1):
        if count == 0:
            anomalies.append(f"第 {idx} 章无正文")
        elif count == 1:
            anomalies.append(f"第 {idx} 章只有 1 句 (可能是碎片章)")
        elif count > 1000:
            anomalies.append(f"第 {idx} 章有 {count} 句 (巨章, 可能切分异常)")
        elif mid > 3 and count * 3 < mid:
            anomalies.append(
                f"第 {idx} 章 {count} 句, 远低于全书中位数 {mid:.0f} 句 (离群, 可能正文丢失)"
            )
    return anomalies
