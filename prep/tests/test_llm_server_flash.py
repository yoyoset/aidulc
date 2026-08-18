"""LLM 加载参数: flash_attn 打开 + 不支持时回退 (2026-08-18)。

实测(RTX 3060, Qwen3-4B-Instruct-2507-Q4_K_M): flash_attn 默认 False, 打开后 explain
单次中位 0.811s→0.747s / 0.879s→0.794s, 两次独立测量(换种子 + 反转 A/B 顺序)分别快
12.4% / 7.5%, 解析成功率 20/20 不变。explain 占整条流水线 68.4% 的时间, 这 ~10%
相当于跑一遍全书库省约 50 分钟。

这里不测速度(测速要真加载 2.4GB 模型 + 占显存, 不适合放进门禁), 只锁两件事:
默认真的传了 flash_attn=True; 以及 FA 不被支持时会回退而不是让整个模型加载失败。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.errors import EngineError, ModelError
from aidulc_prep.pipeline.llm.server import LlmServer


class FakeLlamaModule:
    """假的 llama_cpp: 记录每次 Llama() 收到的 flash_attn。"""

    def __init__(self, fail_when_flash=False, fail_always=False):
        self.calls = []
        self._fail_when_flash = fail_when_flash
        self._fail_always = fail_always

    def Llama(self, **kw):  # noqa: N802 (照抄 llama_cpp 的类名)
        self.calls.append(kw.get("flash_attn"))
        if self._fail_always:
            raise RuntimeError("模型文件损坏")
        if self._fail_when_flash and kw.get("flash_attn"):
            raise RuntimeError("this build has no flash attention")
        return object()


def make(tmp_path, module, monkeypatch):
    model = tmp_path / "m.gguf"
    model.write_bytes(b"x")
    monkeypatch.setitem(sys.modules, "llama_cpp", module)
    return LlmServer(str(model))


def test_flash_attn_on_by_default(tmp_path, monkeypatch):
    m = FakeLlamaModule()
    make(tmp_path, m, monkeypatch)
    assert m.calls == [True], "默认就该开 FA, 不需要用户配置"


def test_falls_back_when_flash_unsupported(tmp_path, monkeypatch):
    """FA 不被支持时退回普通模式 —— 为一个性能开关让模型整个加载不了是不划算的。"""
    m = FakeLlamaModule(fail_when_flash=True)
    srv = make(tmp_path, m, monkeypatch)
    assert m.calls == [True, False], f"应该先试 FA 再回退, 实得 {m.calls}"
    assert srv.llm is not None


def test_real_load_failure_still_raises(tmp_path, monkeypatch):
    """回退不能把真正的加载失败也吞掉。"""
    m = FakeLlamaModule(fail_always=True)
    with pytest.raises(EngineError):
        make(tmp_path, m, monkeypatch)
    assert m.calls == [True, False], "两条路都试过才判失败"


def test_missing_model_file_is_model_error(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "llama_cpp", FakeLlamaModule())
    with pytest.raises(ModelError):
        LlmServer(str(tmp_path / "not_there.gguf"))
