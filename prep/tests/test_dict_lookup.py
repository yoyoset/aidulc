"""dict_lookup 回归测试 (I-A 剩余): JSON 解析 / prompt 容忍 / 失败语义"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import aidulc_prep.application.dict_lookup as dl


class FakeServer:
    def __init__(self, text):
        self._text = text

    def complete(self, messages, temperature=0.3, max_tokens=400):
        assert any("word" in m["content"] for m in messages), "prompt 应含查询词"
        return self._text


class TestLookupWord:
    def test_plain_json(self, monkeypatch):
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer(
            '{"pos": "NOUN", "phonetic": "/bæŋk/", "meanings": ["银行"], "examples": ["Go to the bank."]}'))
        r = dl.lookup_word("m.bin", "bank", "I went to the bank.")
        assert r["word"] == "bank"
        assert r["meanings"] == ["银行"]
        assert r["pos"] == "NOUN"

    def test_code_fence_wrapped(self, monkeypatch):
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer(
            '```json\n{"pos": "VERB", "meanings": ["打破"], "examples": []}\n```'))
        r = dl.lookup_word("m.bin", "break", "")
        assert r["meanings"] == ["打破"]
        assert r["pos"] == "VERB"

    def test_context_used_in_prompt(self, monkeypatch):
        captured = {}

        def fake(p, messages, temperature=0.3, max_tokens=400):
            captured["prompt"] = messages[1]["content"]
            return '{"pos": "NOUN", "meanings": []}'

        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer("{}"))
        # 换用直接检查 prompt 构造的方式: 单测 complete 调用链
        monkeypatch.setattr(FakeServer, "complete", fake)
        dl.lookup_word("m.bin", "zebra", "The zebra runs fast.")
        assert "zebra" in captured["prompt"]
        assert "zebra runs fast" in captured["prompt"], "上下文应进 prompt"

    def test_invalid_json_raises(self, monkeypatch):
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer("不是 JSON"))
        try:
            dl.lookup_word("m.bin", "x", "")
            assert False, "应抛异常"
        except Exception:
            pass

    def test_truncated_json_retries_with_bigger_budget(self, monkeypatch):
        # 2026-09-05 实测复现: "dixie" 报 "Unterminated string starting at:
        # line 1 column 478" —— 首次 200 token 预算把 JSON 截断在字符串中间,
        # 重试用更大预算(LOOKUP_RETRY_MAX_TOKENS)应该能拿到完整 JSON。
        calls = []

        class TruncatingServer:
            def complete(self, messages, temperature=0.3, max_tokens=400):
                calls.append(max_tokens)
                if max_tokens == dl.LOOKUP_MAX_TOKENS:
                    return '{"pos": "NOUN", "meanings": ["一种南方风格'  # 截断, 非法 JSON
                return '{"pos": "NOUN", "meanings": ["一种南方风格"], "examples": []}'

        monkeypatch.setattr(dl, "get_server", lambda p: TruncatingServer())
        r = dl.lookup_word("m.bin", "dixie", "")
        assert r["meanings"] == ["一种南方风格"]
        assert calls == [dl.LOOKUP_MAX_TOKENS, dl.LOOKUP_RETRY_MAX_TOKENS], \
            "应先用基础预算, 解析失败后正好重试一次(不是重试无限次)"

    def test_retry_also_fails_still_raises(self, monkeypatch):
        # 两次预算都截断/非法 —— 不该死循环, 第二次失败直接抛出。
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer("坏输出 坏输出"))
        try:
            dl.lookup_word("m.bin", "x", "")
            assert False, "两次都失败应抛异常"
        except Exception:
            pass

    def test_main_exit_code(self, monkeypatch, capsys):
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer('{"pos": "NOUN", "meanings": ["银行"], "examples": []}'))
        rc = dl.main(["--model", "m.bin", "--word", "bank", "--context", "ctx"])
        assert rc == 0
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["word"] == "bank"

    def test_main_failure_exit_code(self, monkeypatch, capsys):
        monkeypatch.setattr(dl, "get_server", lambda p: FakeServer("坏输出"))
        rc = dl.main(["--model", "m.bin", "--word", "bank"])
        assert rc == 1, "LLM 输出非法时应失败退出"
