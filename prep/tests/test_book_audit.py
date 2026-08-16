import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.application.book_audit import _PURE_NUMBERING, evaluate_book


def test_broken_file_is_s1_block(tmp_path):
    """破损文件返回 S1 阻断, evaluate_book 不抛异常。"""
    # 创建一个内容是 b"not a zip" 的假 EPUB 文件
    broken_epub = tmp_path / "broken.epub"
    broken_epub.write_bytes(b"not a zip")

    result = evaluate_book(str(broken_epub))

    # 检查返回值包含 error 键
    assert "error" in result
    # 检查 verdict 是 "block"
    assert result["verdict"] == "block"
    # 检查 issues 中有 S1 代码
    s1_issues = [i for i in result["issues"] if i["code"] == "S1"]
    assert len(s1_issues) == 1
    assert s1_issues[0]["level"] == "block"


def test_pure_numbering_excluded():
    """_PURE_NUMBERING 正则: 纯数字/罗马数字命中, 有实字的不命中。"""
    # 命中的情况
    assert _PURE_NUMBERING.match("17")
    assert _PURE_NUMBERING.match("XIV")
    assert _PURE_NUMBERING.match("3.")

    # 不命中的情况
    assert not _PURE_NUMBERING.match("ABOUT THE AUTHOR")
    assert not _PURE_NUMBERING.match("Chapter 3")


def test_result_dict_has_stable_keys(tmp_path):
    """evaluate_book 返回的 dict 必须包含指定的键。"""
    broken_epub = tmp_path / "broken.epub"
    broken_epub.write_bytes(b"not a zip")

    result = evaluate_book(str(broken_epub))

    required_keys = {
        "path",
        "title",
        "chapters",
        "sentences",
        "uncovered",
        "real_missing",
        "untitled",
        "non_body_titles",
        "anomalies",
        "issues",
        "verdict",
    }
    assert set(result.keys()) >= required_keys


def test_json_serializable(tmp_path):
    """evaluate_book 返回值必须可以直接 json.dumps。"""
    import json

    broken_epub = tmp_path / "broken.epub"
    broken_epub.write_bytes(b"not a zip")

    result = evaluate_book(str(broken_epub))

    # 不应该抛异常
    json_str = json.dumps(result, ensure_ascii=False)
    assert json_str  # 至少有一些内容
