import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.standard import BLOCK, WARN, StandardIssue, judge_standard, verdict


def judge(**kw):
    """Helper: 每个用例只传自己关心的参数。"""
    base = dict(opened=True, chapter_count=20, sentence_count=1000, real_missing=[],
                total_files=20, untitled_count=0, non_body_titles=[], anomalies=[], severe_anomalies=[])
    base.update(kw)
    return judge_standard(**base)


def test_all_pass():
    """全部达标 → 空列表, verdict 返回 "ok" """
    issues = judge()
    assert issues == []
    assert verdict(issues) == "ok"


def test_s1_block_short_circuit():
    """S1: EPUB 打不开 → 只有一条 S1 BLOCK, 短路返回(忽略其它会触发的判据)"""
    issues = judge(opened=False, chapter_count=0, sentence_count=0)
    assert len(issues) == 1
    assert issues[0].code == "S1"
    assert issues[0].level == BLOCK
    assert "打不开或读不到 spine" in issues[0].message


def test_s2_block_high_missing_ratio():
    """S2 阻断: 30% > 10% → BLOCK"""
    issues = judge(real_missing=["a", "b", "c"], total_files=10)
    assert any(issue.code == "S2" and issue.level == BLOCK for issue in issues)


def test_s2_warn_low_missing_ratio():
    """S2 警告: 1% < 10% → WARN"""
    issues = judge(real_missing=["a"], total_files=100)
    assert any(issue.code == "S2" and issue.level == WARN for issue in issues)


def test_s2_missing_zero_denominator():
    """S2 分母为 0 不崩溃: ratio 取 0.0 → WARN"""
    issues = judge(real_missing=["a"], total_files=0)
    assert any(issue.code == "S2" and issue.level == WARN for issue in issues)


def test_s3_block_zero_chapters():
    """S3: chapter_count=0 → BLOCK"""
    issues = judge(chapter_count=0, sentence_count=100)
    assert any(issue.code == "S3" and issue.level == BLOCK for issue in issues)


def test_s3_block_insufficient_sentences():
    """S3: sentence_count=49 < 50 → BLOCK; sentence_count=50 → 无 S3"""
    issues_49 = judge(sentence_count=49)
    assert any(issue.code == "S3" and issue.level == BLOCK for issue in issues_49)

    issues_50 = judge(sentence_count=50)
    assert not any(issue.code == "S3" for issue in issues_50)


def test_s4_few_outliers_not_reported():
    """S4: 少量离群(1 条 / 20 章 = 5% < 20%)不报警 (2026-08-16 实测标定)"""
    issues = judge(anomalies=["第 3 章无正文"])
    assert not any(issue.code == "S4" for issue in issues)


def test_s5_warn_untitled_exceeds_threshold():
    """S5: 30% > 20% → WARN; 20% 不超过 → 无 S5"""
    issues_30 = judge(chapter_count=10, untitled_count=3)
    assert any(issue.code == "S5" and issue.level == WARN for issue in issues_30)

    issues_20 = judge(chapter_count=10, untitled_count=2)
    assert not any(issue.code == "S5" for issue in issues_20)


def test_s6_warn_non_body_titles():
    """S6: 有前后言条目 → WARN"""
    issues = judge(non_body_titles=["ABOUT THE AUTHOR"])
    assert any(issue.code == "S6" and issue.level == WARN for issue in issues)


def test_verdict_three_states():
    """verdict 三态: BLOCK → "block"; 仅 WARN → "warn"; 空 → "ok" """
    issues_block = judge(opened=False)
    assert verdict(issues_block) == "block"

    issues_warn = judge(real_missing=["a"], total_files=100)
    assert verdict(issues_warn) == "warn"

    issues_ok = judge()
    assert verdict(issues_ok) == "ok"


def test_standard_issue_to_dict():
    """StandardIssue.to_dict() 返回三个键"""
    issue = StandardIssue("S1", BLOCK, "test message")
    d = issue.to_dict()
    assert d == {"code": "S1", "level": BLOCK, "message": "test message"}
    assert set(d.keys()) == {"code", "level", "message"}


def test_s4_severe_always_reported():
    """S4: 严重异常(0 句章/巨章)无条件报警, 不看占比"""
    issues = judge(severe_anomalies=["第 3 章无正文"], anomalies=["第 3 章无正文"])
    assert any(issue.code == "S4" and issue.level == WARN for issue in issues)


def test_s4_high_outlier_ratio_reported():
    """S4: 普通离群在占比 > 20% 时报警 (3/10 = 30% > 20%)"""
    issues = judge(chapter_count=10, anomalies=["a", "b", "c"])
    assert any(issue.code == "S4" and issue.level == WARN for issue in issues)


def test_s4_boundary_20_percent_not_reported():
    """S4: 正好 20% 边界(不超过 >), 不报警 (2/10 = 20%)"""
    issues = judge(chapter_count=10, anomalies=["a", "b"])
    assert not any(issue.code == "S4" for issue in issues)


def test_s3_single_chapter_book_warns():
    """S3: 整本书只有 1 章但句数够多(≥200)→ WARN 而非 BLOCK"""
    issues = judge(chapter_count=1, sentence_count=675)
    s3_issues = [issue for issue in issues if issue.code == "S3"]
    assert len(s3_issues) == 1
    assert s3_issues[0].level == WARN
    assert "章节切分" in s3_issues[0].message


def test_s3_single_chapter_short_book_is_block_not_warn():
    """S3: 1 章 <50 句 → BLOCK 第一条分支, 不走第二条 WARN"""
    issues = judge(chapter_count=1, sentence_count=30)
    s3_issues = [issue for issue in issues if issue.code == "S3"]
    assert len(s3_issues) == 1
    assert s3_issues[0].level == BLOCK
    assert "解析结果过少" in s3_issues[0].message


def test_s3_normal_book_no_warn():
    """S3: 正常书(21 章 675 句) 无 S3 警告"""
    issues = judge(chapter_count=21, sentence_count=675)
    assert not any(issue.code == "S3" for issue in issues)
