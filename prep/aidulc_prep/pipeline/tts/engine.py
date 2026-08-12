"""
pipeline/tts/engine.py —— Kokoro PyTorch TTS (Phase 0-A 实测选定)

实测 (5.1):
- GPU realtime x18.1 (8.55s 音频 0.47s), CPU kokoro-onnx 仅 x2.8
- KModel.forward(return_output=True) 返回 pred_dur (音素帧时长)
- KPipeline.join_timestamps 直接给每词 start_ts/end_ts 秒 → 路线 1 时间轴, 对齐成本=0
- 需 espeak (espeakng-loader 自带 dll+data) + spacy en_core_web_sm (misaki en 后端)

本引擎统一接口: synth_sentence(text, voice, speed) -> (samples: np.ndarray, sr: int, word_timings: list[(seg_idx_offset 未知, start_ms, end_ms)])
实现: 单句直接用 KPipeline, 从 Result.tokens 拿每词 (start_ts, end_ts)。
"""
from __future__ import annotations

import os
import threading

import numpy as np

from aidulc_prep.application.language_registry import get_tts_lang_code
from aidulc_prep.core.errors import EngineError

_lock = threading.Lock()
_instance = None

SAMPLE_RATE = 24000


class KokoroEngine:
    def __init__(self, model_path: str, device: str = "cuda", language: str = "en"):
        # 先注册 espeak (misaki 依赖), 再 import misaki/kokoro
        try:
            from phonemizer.backend.espeak.wrapper import EspeakWrapper
            import espeakng_loader
            EspeakWrapper.set_library(espeakng_loader.get_library_path())
            EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        except Exception as e:
            raise EngineError("espeak 初始化失败", str(e)) from e

        import torch
        from kokoro import KPipeline
        from kokoro.model import KModel

        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"

        # config.json 与模型同目录 (HF 缓存 snapshots 布局)
        config_path = os.path.join(os.path.dirname(model_path), "config.json")
        if not os.path.exists(model_path):
            raise EngineError(f"TTS 模型文件不存在: {model_path}")
        if not os.path.exists(config_path):
            raise EngineError(
                f"TTS 模型不完整: {model_path} 同目录缺 config.json。"
                "Kokoro 需要 模型文件+config.json+voices/ 在同一目录 —— 请把推荐 TTS 指向 "
                "HF 缓存里完整的 models--hexgrad--Kokoro-82M/snapshots/<sha>/ 目录内的 kokoro-v1_0.pth"
            )
        if not os.path.exists(os.path.join(os.path.dirname(model_path), "voices")):
            raise EngineError(
                f"TTS 模型不完整: {model_path} 同目录缺 voices/ 目录。"
                "Kokoro 需要 模型文件+config.json+voices/ 在同一目录 —— 请把推荐 TTS 指向 "
                "HF 缓存里完整的 models--hexgrad--Kokoro-82M/snapshots/<sha>/ 目录内的 kokoro-v1_0.pth"
            )

        self.model = KModel(config=config_path, model=model_path)
        self.model.to(device).eval()
        # H5 fix: language 从构造参数来 (旧实现 getattr(self,"language") 在赋值前读取 → 恒 en, 审查确认)
        self.language = language
        lang_code = get_tts_lang_code(language) or "a"
        self.pipe = KPipeline(lang_code=lang_code, model=False, device=device)
        self.device = device

    def synth(self, text: str, voice: str = "af_heart", speed: float = 1.0):
        """合成一句。返回 (audio_24k: np.ndarray, word_timings: list[dict])。
        word_timings: [{word, start_ms, end_ms}] (秒→ms)。"""
        try:
            return self._synth(text, voice, speed)
        except Exception as e:
            raise EngineError(f"TTS 合成失败: {e}", detail=str(e)) from e

    def _synth(self, text: str, voice: str, speed: float):
        import torch

        chunks = []
        timings = []
        offset_ms = 0  # 多 chunk 时后续 chunk 的时间轴必须加累计偏移 (审查确认的坑)
        for res in self.pipe(text, voice=voice, speed=speed, model=self.model):
            if res.output is None or res.output.audio is None:
                continue
            audio = res.output.audio.cpu().numpy() if isinstance(res.output.audio, torch.Tensor) else np.asarray(res.output.audio)
            chunks.append(audio)
            # res.tokens 已由 join_timestamps 填充 start_ts/end_ts (秒, 句内相对)
            for t in res.tokens or []:
                if getattr(t, "start_ts", None) is not None:
                    timings.append({
                        "word": t.text,
                        "start_ms": int(t.start_ts * 1000) + offset_ms,
                        "end_ms": int(t.end_ts * 1000) + offset_ms,
                    })
            offset_ms += int(len(audio) / 24000 * 1000)
        if not chunks:
            raise EngineError(f"TTS 输出为空 (text={text[:50]!r})")
        audio = np.concatenate(chunks)
        return audio, timings


def get_engine(model_path: str, language: str = "en") -> KokoroEngine:
    global _instance
    with _lock:
        if _instance is None or _instance.model_path != model_path or _instance.language != language:
            _instance = KokoroEngine(model_path, language=language)
            _instance.model_path = model_path
        return _instance
