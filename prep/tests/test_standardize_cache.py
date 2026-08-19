"""runner.py::_parse() 读标准化转换缓存 (2026-08-19)

背景: 用户拍板"导入体检不达标的书自动尝试标准化转换"。转换成功后 Rust 后台任务
把 cli.py --standardize-book 的产出缓存下来, job_request.json 带上
standardize_cache_path 时, _parse() 要读缓存而不是重新原生解析(重解析只会得到
同样的 block 结果)。
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.errors import InputError
from aidulc_prep.pipeline.runner import Runner


def _write_cache(tmp_path, payload):
    p = tmp_path / "cache.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    return str(p)


class TestStandardizeCache:
    def test_parse_reads_cache_when_present(self, tmp_path):
        cache = _write_cache(tmp_path, {
            "verdict": "ok",
            "book": {
                "title": "Cached Title",
                "chapters": [
                    {"title": "Chapter One", "sentences": ["First sentence.", "Second sentence."]},
                    {"title": "Chapter Two", "sentences": ["Third sentence."]},
                ],
            },
        })
        r = Runner({"book_path": "irrelevant.epub", "standardize_cache_path": cache}, str(tmp_path / "out"))
        book = r._parse()
        assert book.title == "Cached Title"
        assert [c.title for c in book.chapters] == ["Chapter One", "Chapter Two"]
        assert [s.original_text for s in book.chapters[0].sentences] == ["First sentence.", "Second sentence."]

    def test_parse_ignores_cache_when_field_absent(self, tmp_path):
        # 没有 standardize_cache_path 字段 → 走原有的原生解析路径, 不受这条改动影响。
        # 用一个不存在的 .txt 文件走 load_book 的错误路径来确认没有误入缓存分支。
        r = Runner({"book_path": str(tmp_path / "nope.txt")}, str(tmp_path / "out"))
        with pytest.raises(InputError):
            r._parse()

    def test_parse_raises_when_cache_path_missing_on_disk(self, tmp_path):
        # 缓存路径写在 job_request 里但文件不存在 —— 必须报错, 不能静默退回原生解析
        # (那样会把"缓存明明该在却读不出来"这类真实故障掩盖成一个正常的 block)。
        r = Runner(
            {"book_path": "irrelevant.epub", "standardize_cache_path": str(tmp_path / "missing.json")},
            str(tmp_path / "out"),
        )
        with pytest.raises(InputError, match="标准化转换缓存读取失败"):
            r._parse()

    def test_parse_raises_when_cache_has_no_book(self, tmp_path):
        # verdict=block 时 cli.py 写的 book 字段是 None —— 理论上 Rust 不会给这种书
        # 注入 cache_path(只有 done 才注入), 但防御性地测一下这条路径本身不会
        # 悄悄产出一本空书。
        cache = _write_cache(tmp_path, {"verdict": "block", "book": None})
        r = Runner({"book_path": "irrelevant.epub", "standardize_cache_path": cache}, str(tmp_path / "out"))
        with pytest.raises(InputError, match="不含可用章节"):
            r._parse()

    def test_parse_raises_on_corrupt_cache_json(self, tmp_path):
        p = tmp_path / "cache.json"
        p.write_text("not json at all", encoding="utf-8")
        r = Runner({"book_path": "irrelevant.epub", "standardize_cache_path": str(p)}, str(tmp_path / "out"))
        with pytest.raises(InputError, match="标准化转换缓存读取失败"):
            r._parse()

    def test_parse_skips_health_check_for_cached_book(self, tmp_path):
        # 缓存路径完全绕开 _check_epub_health(兜底解析没有 spine/uncovered 概念)——
        # 即使章节句数分布看起来很离群(会触发原生路径的 anomalies 警告), 缓存路径
        # 也不应该抛错或记 notice, 因为 _check_epub_health 根本没被调用。
        cache = _write_cache(tmp_path, {
            "verdict": "warn",
            "book": {
                "title": "T",
                "chapters": [{"title": "Ch1", "sentences": ["s"]}] + [
                    {"title": f"Ch{i}", "sentences": ["A normal sentence here."] * 30} for i in range(2, 10)
                ],
            },
        })
        r = Runner({"book_path": "irrelevant.epub", "standardize_cache_path": cache}, str(tmp_path / "out"))
        book = r._parse()  # 不应抛异常
        assert len(book.chapters) == 9
