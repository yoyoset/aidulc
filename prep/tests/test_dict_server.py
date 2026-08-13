"""dict_server 常驻守护回归测试 (F21, 2026-08-08): 协议逐行 / 失败不崩 / 模型懒加载"""
import json
import os
import sys
from io import StringIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import aidulc_prep.application.dict_server as ds
import aidulc_prep.application.dict_lookup as dl


class FakeServer:
    def __init__(self, text='{"pos": "NOUN", "meanings": ["银行"], "examples": []}'):
        self._text = text

    def complete(self, messages, temperature=0.3, max_tokens=400):
        return self._text


class TestServe:
    def _serve_lines(self, monkeypatch, lines):
        """把 serve() 的 stdin/stdout 重定向到内存流, 喂多行, 返回 stdout 所有行。"""
        fake = FakeServer()
        monkeypatch.setattr(dl, "get_server", lambda p: fake)
        stdin = StringIO("\n".join(lines) + "\n")
        out = StringIO()
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", out)
        rc = ds.serve("m.bin")
        out.seek(0)
        return rc, [json.loads(l) for l in out.read().splitlines() if l.strip()]

    def test_ready_then_query_ok(self, monkeypatch):
        rc, msgs = self._serve_lines(monkeypatch, ['{"word": "bank", "context": "to the bank"}'])
        assert rc == 0
        assert msgs[0]["ok"] is True and msgs[0]["ready"] is True
        assert msgs[1]["ok"] is True
        assert msgs[1]["result"]["word"] == "bank"
        assert msgs[1]["result"]["meanings"] == ["银行"]

    def test_multiple_queries_same_server(self, monkeypatch):
        # 连续多查: 服务进程不退出, 每个请求都有对应响应 (守护核心语义)
        rc, msgs = self._serve_lines(monkeypatch, [
            '{"word": "a"}',
            '{"word": "b"}',
            '{"word": "c"}',
        ])
        assert rc == 0
        oks = [m for m in msgs if "result" in m]
        assert [m["result"]["word"] for m in oks] == ["a", "b", "c"]

    def test_failure_isolated_and_continue(self, monkeypatch):
        # 单次失败(如非法 JSON)只回 {"ok":false}, 下一个请求仍正常服务
        def bad_then_good(monkeypatch):
            calls = {"n": 0}

            class Flaky:
                def complete(self, *a, **k):
                    calls["n"] += 1
                    if calls["n"] == 1:
                        raise ValueError("bad model output")
                    return '{"pos": "NOUN", "meanings": ["好的"], "examples": []}'

            return Flaky()

        flaky = bad_then_good(monkeypatch)
        monkeypatch.setattr(dl, "get_server", lambda p: flaky)
        stdin = StringIO('{"word": "x"}\n{"word": "y"}\n')
        out = StringIO()
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", out)
        rc = ds.serve("m.bin")
        out.seek(0)
        msgs = [json.loads(l) for l in out.read().splitlines() if l.strip()]
        assert msgs[1]["ok"] is False
        assert msgs[2]["ok"] is True
        assert msgs[2]["result"]["meanings"] == ["好的"]
        assert rc == 0

    def test_eof_exits_zero(self, monkeypatch):
        rc, msgs = self._serve_lines(monkeypatch, [])
        assert rc == 0
        assert len(msgs) == 1 and msgs[0]["ready"] is True, "空输入只回 ready 标记即退出"


class TestCliContract:
    """2026-08-13 实测根因回归: Rust dict_daemon 经打包 exe 调 cli.py, 参数名必须用
    cli.py 的 --lookup-model (不是 dict_server 内部 argparse 的 --model)。此前 Rust 传
    --model → cli.py argparse 秒退 exit 2 → 误报"词典守护启动超时"。本测试锁住
    cli.py 的 --lookup-server 入口契约: 接受 --lookup-model 且正确转发给 dict_server。"""

    def test_lookup_server_accepts_lookup_model(self, monkeypatch):
        import aidulc_prep.cli as cli

        captured = {}

        def fake_dict_server_main(argv):
            captured["argv"] = argv
            return 0

        monkeypatch.setattr(sys, "stdin", StringIO(""))
        monkeypatch.setattr(
            "aidulc_prep.application.dict_server.main", fake_dict_server_main
        )
        rc = cli.main(["--lookup-server", "--lookup-model", "F:/m.gguf"])
        assert rc == 0
        assert captured["argv"] == ["--model", "F:/m.gguf"], (
            "cli.py 应把 --lookup-model 转成 dict_server 的 --model: "
            + str(captured.get("argv"))
        )

    def test_lookup_server_rejects_model_alias(self):
        """--model 不是 cli.py 的参数 (Rust 旧调用传它 → argparse 秒退)。"""
        import aidulc_prep.cli as cli

        try:
            cli.main(["--lookup-server", "--model", "F:/m.gguf"])
        except SystemExit as e:
            assert e.code != 0, "--model 是非法参数, 应报错退出"
            return
        raise AssertionError("--model 是非法参数, 应 SystemExit 报错")
