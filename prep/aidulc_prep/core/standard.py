"""core/standard.py —— "aidulc 标准书" 6 条判据 (S1-S6) 的唯一定义

docs/GOAL_2026-08-16_STDIMPORT.md 拍板: 同一套判据要在三处复用(手动体检脚本、
导入时把关、备料 parse 阶段拦截), 一处定义不允许各写各的。

保持纯函数无 I/O: 输入已经算好的原始指标(章数/句数/真缺失文件等), 输出结构化
判定结果。真正读 zip、解析 EPUB 的部分在 application/book_audit.py, 不在这里
——core/ 不许依赖 pipeline/。
"""

from __future__ import annotations

from dataclasses import dataclass

BLOCK = "block"
WARN = "warn"


@dataclass
class StandardIssue:
    """一条不达标记录。code 是判据编号(S1..S6), level 是 BLOCK/WARN, message 是人话。"""
    code: str
    level: str
    message: str

    def to_dict(self) -> dict:
        return {"code": self.code, "level": self.level, "message": self.message}


def judge_standard(
    *,
    opened: bool,
    chapter_count: int,
    sentence_count: int,
    real_missing: list[str],
    total_files: int,
    untitled_count: int,
    non_body_titles: list[str],
    anomalies: list[str],
    severe_anomalies: list[str] | None = None,
) -> list[StandardIssue]:
    """
    按 6 条判据(S1-S6)判定 EPUB 是否达到"标准书"要求。

    参数:
        opened: EPUB 能否作为 zip 打开并读到 spine
        chapter_count: 成功解析的章节数
        sentence_count: 成功解析的句子总数
        real_missing: 真的读不到的正文文件(URL 解码后仍读不到), 由调用方用 classify 逻辑算好
        total_files: 章节数 + 未覆盖文件数(比例分母)
        untitled_count: 标题回退成 "(Untitled)" 的章数
        non_body_titles: 章节标题里仍然命中前后言正则的标题列表
        anomalies: core/health.py::detect_anomalies 的输出
        severe_anomalies: anomalies 里无歧义的那部分(某章 0 句 / 某章 >1000 句巨章),
            这类无条件报警, 不看占比

    返回:
        StandardIssue 列表，按 S1→S6 顺序。无问题返回空列表。
    """
    issues = []

    # S1: EPUB 能否打开
    if not opened:
        return [StandardIssue("S1", BLOCK, "EPUB 打不开或读不到 spine")]

    # S2: 正文文件读取失败
    if real_missing:
        ratio = len(real_missing) / total_files if total_files else 0.0
        if ratio > 0.10:
            issues.append(StandardIssue(
                "S2",
                BLOCK,
                f"{len(real_missing)}/{total_files} 个正文文件读取失败({ratio:.0%}), 多半是路径编码/解析问题"
            ))
        else:
            issues.append(StandardIssue(
                "S2",
                WARN,
                f"{len(real_missing)} 个正文文件读取失败: {', '.join(real_missing[:3])}"
            ))

    # S3: 解析结果过少
    if chapter_count < 1 or sentence_count < 50:
        issues.append(StandardIssue(
            "S3",
            BLOCK,
            f"解析结果过少: {chapter_count} 章 / {sentence_count} 句(标准要求 ≥1 章且 ≥50 句)"
        ))
    # S3(第二条, 2026-08-16 实测 Frindle 补): 句子够多但只切出 1 章 = 章节切分
    # 完全失效, 阅读器里整本书无法按章导航。这不该判"达标"。
    elif chapter_count == 1 and sentence_count >= 200:
        issues.append(StandardIssue(
            "S3",
            WARN,
            f"整本书只解析出 1 章({sentence_count} 句), 章节切分多半失效, 阅读器里无法按章导航"
        ))

    # S4 (2026-08-16 按 10 本真实书重新标定): 严重异常(0 句章/巨章)无条件报;
    # 普通离群(某章短于中位数 1/3)在真实书里太常见——实测 10 本书的异常率
    # 0%~14.4%, 9/10 本都会命中, 报了等于没报——只在占比 > 20% 时才报。
    severe = severe_anomalies or []
    if severe:
        issues.append(StandardIssue(
            "S4",
            WARN,
            f"{len(severe)} 章句数严重异常: {'; '.join(severe[:3])}"
        ))
    elif anomalies and chapter_count and len(anomalies) / chapter_count > 0.20:
        issues.append(StandardIssue(
            "S4",
            WARN,
            f"{len(anomalies)}/{chapter_count} 章句数分布离群({len(anomalies) / chapter_count:.0%}): {'; '.join(anomalies[:3])}"
        ))

    # S5: 标题缺失过多
    if chapter_count and untitled_count / chapter_count > 0.20:
        issues.append(StandardIssue(
            "S5",
            WARN,
            f"{untitled_count}/{chapter_count} 章标题缺失退化成 (Untitled)({untitled_count / chapter_count:.0%}), 章节列表会难以辨认"
        ))

    # S6: 前后言条目混进正文
    if non_body_titles:
        issues.append(StandardIssue(
            "S6",
            WARN,
            f"{len(non_body_titles)} 个前后言条目混进了正文章节: {', '.join(non_body_titles[:3])}"
        ))

    return issues


def verdict(issues: list[StandardIssue]) -> str:
    """整体判定: 有 BLOCK → "block"; 只有 WARN → "warn"; 空 → "ok"。"""
    for issue in issues:
        if issue.level == BLOCK:
            return "block"
    if issues:
        return "warn"
    return "ok"
