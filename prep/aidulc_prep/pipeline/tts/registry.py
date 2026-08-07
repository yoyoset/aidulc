"""
pipeline/tts/registry.py —— 引擎切换走注册表 (不硬编码 if/elif)

现在只有 Kokoro 一个引擎; 注册表结构让将来加引擎 (如 Azure/edge-tts) 不碰调用方。
M 系列: stage.py 已改走 create_engine (注册表不再名存实亡)。
"""
from __future__ import annotations

from aidulc_prep.core.errors import EngineError
from aidulc_prep.pipeline.tts.engine import KokoroEngine, get_engine

ENGINES = {"kokoro": KokoroEngine}


def create_engine(name: str, model_path: str, language: str = "en"):
    """按名取引擎; kokoro 走单例 get_engine (进程内复用, 带语言)。"""
    if name not in ENGINES:
        raise EngineError(f"未知 TTS 引擎: {name}", detail=f"可用: {sorted(ENGINES)}")
    if name == "kokoro":
        return get_engine(model_path, language=language)
    return ENGINES[name](model_path)
