"""tts_server 常驻守护回归测试 (K29, 2026-08-14): 协议逐行 / 失败不崩 / 模型懒加载。
与 test_dict_server.py 同一套写法(同一个守护模式的两个实现)。"""
import json
import os
import sys
from io import StringIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import aidulc_prep.application.tts_server as ts


class FakeEngine:
    def __init__(self, calls):
        self._calls = calls

    def synth(self, text, voice="af_heart", speed=1.0):
        self._calls.append(text)
        import numpy as np
        # 极短静音, 只测协议不测真实音频
        return np.zeros(240, dtype="float32"), []


class TestServe:
    def _serve_lines(self, monkeypatch, lines, engine=None):
        calls = []
        fake = engine or FakeEngine(calls)
        monkeypatch.setattr(
            "aidulc_prep.pipeline.tts.engine.get_engine", lambda p, language="en": fake
        )
        stdin = StringIO("\n".join(lines) + "\n")
        out = StringIO()
        monkeypatch.setattr(sys, "stdin", stdin)
        monkeypatch.setattr(sys, "stdout", out)
        rc = ts.serve("m.pth", "en")
        out.seek(0)
        return rc, [json.loads(l) for l in out.read().splitlines() if l.strip()], calls

    def test_ready_then_synth_ok(self, monkeypatch):
        rc, msgs, calls = self._serve_lines(monkeypatch, ['{"word": "bank", "voice": "af_heart", "speed": 1.0}'])
        assert rc == 0
        assert msgs[0]["ok"] is True and msgs[0]["ready"] is True
        assert msgs[1]["ok"] is True
        assert "wav_base64" in msgs[1]["result"]
        assert calls == ["bank"], "应把 word 当合成文本传给引擎"

    def test_multiple_queries_same_server(self, monkeypatch):
        rc, msgs, calls = self._serve_lines(monkeypatch, [
            '{"word": "a"}', '{"word": "b"}', '{"word": "c"}',
        ])
        assert rc == 0
        assert calls == ["a", "b", "c"], "守护进程不退出, 同一引擎实例服务多次请求"

    def test_failure_isolated_and_continue(self, monkeypatch):
        class Flaky:
            def __init__(self):
                self.n = 0

            def synth(self, text, voice="af_heart", speed=1.0):
                self.n += 1
                if self.n == 1:
                    raise RuntimeError("boom")
                import numpy as np
                return np.zeros(240, dtype="float32"), []

        rc, msgs, _ = self._serve_lines(monkeypatch, ['{"word": "x"}', '{"word": "y"}'], engine=Flaky())
        assert msgs[1]["ok"] is False
        assert msgs[2]["ok"] is True
        assert rc == 0

    def test_missing_word_rejected(self, monkeypatch):
        rc, msgs, _ = self._serve_lines(monkeypatch, ['{"voice": "af_heart"}'])
        assert msgs[1]["ok"] is False
        assert "word" in msgs[1]["error"]

    def test_eof_exits_zero(self, monkeypatch):
        rc, msgs, _ = self._serve_lines(monkeypatch, [])
        assert rc == 0
        assert len(msgs) == 1 and msgs[0]["ready"] is True


class TestCliContract:
    """与 test_dict_server.py::TestCliContract 同一套契约锁定: Rust tts_daemon 经打包
    exe 调 cli.py, 参数名必须是 cli.py 的 --tts-model(不是 tts_server 内部的 --model)。"""

    def test_tts_server_accepts_tts_model(self, monkeypatch):
        import aidulc_prep.cli as cli

        captured = {}

        def fake_tts_server_main(argv):
            captured["argv"] = argv
            return 0

        monkeypatch.setattr(sys, "stdin", StringIO(""))
        monkeypatch.setattr(
            "aidulc_prep.application.tts_server.main", fake_tts_server_main
        )
        rc = cli.main(["--tts-server", "--tts-model", "F:/kokoro.pth"])
        assert rc == 0
        assert captured["argv"] == ["--model", "F:/kokoro.pth", "--language", "en"]
