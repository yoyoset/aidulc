"""
pipeline/llm/server.py —— llama_cpp_python 生命周期

Phase 0 实测修正 (见提案 5.1): 原方案是 llama-server 子进程 + 动态端口, 实测发现
subgen 自带的 llama-server.exe 是 CPU build (17 t/s), 而 llama_cpp_python 是 CUDA
build (68-80 t/s) → 改用进程内库。这同时消掉了孙进程治理 (R11 风险降低)。

单例常驻: 一批句子处理完不卸载模型 (卸载+重载 ~3s 不值得), 任务级生命周期由 runner 管理。
"""
from __future__ import annotations

import os
import threading

from aidulc_prep.core.errors import EngineError, ModelError

_lock = threading.Lock()
_instance = None

# llama_cpp 模块 import 时就会尝试加载 llama.dll (依赖 ggml-cuda.dll 的 CUDA runtime),
# 所以必须先注册 DLL 目录再 import —— 实测顺序错误会 FileNotFoundError (Phase 0-A 踩过)。
# CUDA runtime 来源优先级 (Phase 8 实测): 打包后是 _internal/cuda_runtime; 开发期借用
# comic-gen venv 的 torch/lib。
_CUDA_DLL_CANDIDATES = [
    # PyInstaller 打包环境: _internal/cuda_runtime (相对此文件的 _internal 目录)
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "cuda_runtime"),
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "..", "site-packages", "torch", "lib"),
    r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib",
]


def _ensure_cuda_dll_paths() -> None:
    """llama_cpp_python 的 ggml-cuda.dll 需要 CUDA runtime (torch/lib 里有)。
    实测 (Phase 0-A): 不加这两行会 FileNotFoundError。
    PyInstaller 修复: 冻结后 __file__ 定位 lib 会失败 → 显式设 LLAMA_CPP_LIB_PATH。"""
    # llama_cpp 用 __file__/lib 找 llama.dll, 冻结环境会失败 (实测 dict-lookup 报
    # "dynlib not found when frozen") → 用 LLAMA_CPP_LIB_PATH 覆盖
    try:
        import llama_cpp
        lib = os.path.join(os.path.dirname(llama_cpp.__file__), "lib")
        if os.path.isdir(lib):
            os.environ.setdefault("LLAMA_CPP_LIB_PATH", lib)
            os.add_dll_directory(lib)
    except Exception:
        pass
    for c in _CUDA_DLL_CANDIDATES:
        if os.path.isdir(c):
            os.add_dll_directory(c)


_ensure_cuda_dll_paths()


def _sanitize_messages(messages: list[dict]) -> list[dict]:
    """2026-08-20 (用户报"bring 词义查询失败: 'utf-8' codec can't encode character
    '\\udc9d' ... surrogates not allowed"): messages 里的 content 来自书里的原文
    (word_lookup 的 context / explain 的 original_text), 书源(EPUB 解析/早前的编解码
    修复)偶尔会把一个残缺的 UTF-16 代理对留成孤立代理字符——这种字符在 Python str
    里合法存在(不会在读书流程任何一步报错), 但 llama_cpp 把 prompt 编码成 UTF-8
    字节喂给 C 库时才第一次触发 UnicodeEncodeError, 报错信息和"哪本书哪句话"完全
    脱节, 用户只看到一句词典查询失败。修法: 在唯一的 LLM 调用出口(所有 explain/
    translate/词典查询都过这里)兜底清洗, 不追到底是哪本书哪句话产生的坏字符——
    那是解析器的事, 这里只保证"不管上游给什么, 喂给 LLM 的一定是合法 UTF-8"。"""
    return [
        {**m, "content": m["content"].encode("utf-8", "replace").decode("utf-8")}
        if isinstance(m.get("content"), str) else m
        for m in messages
    ]


class LlmServer:
    """llama_cpp_python 进程内推理。openai 兼容的 create_chat_completion 接口。"""

    def __init__(self, model_path: str, n_ctx: int = 16384, n_gpu_layers: int = 99, verbose: bool = False):
        if not os.path.exists(model_path):
            raise ModelError(f"LLM 模型文件不存在: {model_path}")
        import llama_cpp
        # flash_attn 默认是 False (2026-08-18 实测): 打开之后 explain 单次中位从
        # 0.811s/0.879s 降到 0.747s/0.794s —— 两次独立测量(换随机种子 + 反转 A/B 顺序
        # 消除热身偏置)分别快 12.4% / 7.5%, 方向一致, 20/20 解析成功率不变。
        # explain 占整条流水线 68.4% 的时间(10 本书实测 8.24h/12.03h), 这 ~10% 相当于
        # 每跑一遍全书库省约 50 分钟。
        # 带回退: 不是所有 llama.cpp 构建/显卡都支持 FA, 为了一个性能开关让模型整个
        # 加载不了是不划算的交换。
        try:
            self.llm = self._load(llama_cpp, model_path, n_gpu_layers, n_ctx, verbose, True)
        except Exception:
            try:
                self.llm = self._load(llama_cpp, model_path, n_gpu_layers, n_ctx, verbose, False)
            except Exception as e:
                raise EngineError(f"LLM 加载失败: {e}", detail=str(e)) from e
        self.model_path = model_path

    @staticmethod
    def _load(llama_cpp, model_path: str, n_gpu_layers: int, n_ctx: int, verbose: bool, flash_attn: bool):
        return llama_cpp.Llama(
            model_path=model_path,
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            flash_attn=flash_attn,
            verbose=verbose,
        )

    def complete(self, messages: list[dict], temperature: float = 0.3, max_tokens: int = 400) -> str:
        """返回模型输出文本。异常包装为 EngineError。"""
        try:
            r = self.llm.create_chat_completion(
                messages=_sanitize_messages(messages),
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except Exception as e:
            raise EngineError(f"LLM 推理失败: {e}", detail=str(e)) from e
        content = r["choices"][0]["message"]["content"]
        if not content:
            raise EngineError("LLM 返回空内容")
        return content


def get_server(model_path: str) -> LlmServer:
    """单例: 同一任务内复用。"""
    global _instance
    with _lock:
        if _instance is None or _instance.model_path != model_path:
            _instance = LlmServer(model_path)
        return _instance


def stop_server() -> None:
    """释放模型 (显存)。阶段切换时由 runner 调用。"""
    global _instance
    with _lock:
        _instance = None
