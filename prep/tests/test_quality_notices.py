"""quality notice 通道 (2026-08-18)

背景: nlp_realign 原本走 add_failure, 导致成品里"失败句数"被放大几十倍
(Wild Robot 9023 条里 8784 条是 realign, 真实失败 30 条)。realign 不是失败,
是"checkpoint 位置冲突 → 清空重跑"的正常记账。
"""
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.pipeline.llm.stage import is_untranslatable


def test_notice_does_not_count_as_failure():
    q = QualityReport()
    q.add_notice(3, 7, "realign", "原文变化")
    d = q.to_dict()
    assert d["failedSentences"] == []
    assert d["noticeCounts"] == {"realign": 1}
    assert len(d["notices"]) == 1
    assert d["notices"][0]["kind"] == "realign"


def test_summary_separates_notices_from_failures():
    q = QualityReport()
    q.add_notice(0, 0, "realign", "")
    assert q.to_dict()["summary"].startswith("全部句子成功。")
    assert "1 句因原文变化重新对齐" in q.to_dict()["summary"]
    q.add_failure(1, 2, ["explain"], "讲解 JSON 解析失败")
    s = q.to_dict()["summary"]
    assert s.startswith("1 句有部分阶段失败 (explain)。")
    assert "重新对齐" in s


def test_notice_counts_group_by_kind():
    q = QualityReport()
    for _ in range(3):
        q.add_notice(0, 0, "realign", "")
    q.add_notice(0, 1, "untranslatable", "")
    assert q.to_dict()["noticeCounts"] == {"realign": 3, "untranslatable": 1}


# --- is_untranslatable: 4 个真实失败样本 + 保守性回归 ---

def test_untranslatable_real_failures():
    # 这 4 条是 8/18 跑批里真实、且每轮都会重试失败的原文
    for t in ["LBYR.com", "Twitter.com/LittleBrownYR",
              "Instagram.com/LittleBrownYoungReaders", "v 1.0 HTML"]:
        assert is_untranslatable(t), t


def test_untranslatable_symbols_only():
    for t in ["---", "* * *", "1.2.3", "42"]:
        assert is_untranslatable(t), t


def test_untranslatable_is_conservative():
    """宁可漏判也不能把正常句子挡掉 —— 这些必须全部 False。

    后 8 条来自"整句同词重复 → 拟声词"那条被证伪的规则: 全语料 69 条命中里
    64 条已有正常译文, 所以那条规则被删掉了, 这里锁定它不会回来。
    """
    for t in ["Visit LBYR.com for more.", "Go to www.example.org today.",
              "It was 1.5 miles away.", "Chapter 1", "The ocean was cold.",
              "No! No!", "There, there.", "Hello, hello?", "Stop! stop!",
              "Wait wait wait!", "Food! Food!", "Quickly, quickly.",
              "Blah blah blah."]:
        assert not is_untranslatable(t), t
