"""
application/tts_server.py —— 常驻语音合成守护 (K29, 2026-08-14)

用户拍板"生词本发音要跟正文朗读同一套引擎, 且要预热"——消灭"每次点发音都冷启动
Kokoro 模型"的等待: 侧车加载模型一次, 通过 stdin/stdout 服务多次合成, 直到 stdin
EOF (Rust 侧空闲超时或任务启动时杀进程)。跟 dict_server.py 是同一个模式, 协议对称。

协议 (与 Rust infrastructure/tts_daemon.rs 配对):
    每行 stdin   一个 JSON 请求 {"word": ..., "voice": ..., "speed": ...}
    每行 stdout  一个 JSON 响应 {"ok": true, "result": {"wav_base64": "..."}}
                 或 {"ok": false, "error": ...}

模型懒加载: 第一个请求才调 get_engine() 单例加载(内部已是 process 级缓存),
不合成不占显存; 同一进程内重复请求复用同一个已加载的 KokoroEngine。
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys


def _synth_to_wav_base64(model_path: str, language: str, text: str, voice: str, speed: float) -> str:
    from aidulc_prep.pipeline.tts.engine import get_engine, SAMPLE_RATE
    import soundfile as sf

    engine = get_engine(model_path, language=language)
    audio, _timings = engine.synth(text, voice=voice, speed=speed)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def serve(model_path: str, language: str) -> int:
    sys.stdout.write(json.dumps({"ok": True, "ready": True}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            word = req.get("word") or ""
            voice = req.get("voice") or "af_heart"
            speed = float(req.get("speed") or 1.0)
            if not word:
                raise ValueError("缺少 word")
            wav_b64 = _synth_to_wav_base64(model_path, language, word, voice, speed)
            sys.stdout.write(json.dumps({"ok": True, "result": {"wav_base64": wav_b64}}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:  # noqa: BLE001 —— 守护必须对单次失败继续服务, 不能整个进程崩
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aidulc-tts-server")
    parser.add_argument("--model", required=True, help="TTS 模型路径 (Kokoro .pth)")
    parser.add_argument("--language", default="en", help="语言 (决定 misaki 后端)")
    args = parser.parse_args(argv)
    try:
        return serve(args.model, args.language)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"tts server failed: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
