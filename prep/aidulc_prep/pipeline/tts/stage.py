"""
pipeline/tts/stage.py —— 逐句合成 + 时间轴 + 校验

- 逐句合成让故障半径 = 一句 (3.5)
- 每句校验 时长/字符数 比值, 超出区间重试一次并记 run.log
- 词级时间轴: 路线 1 (Kokoro 自吐时长, Phase 0-A 实测可行), 对齐成本=0
"""
from __future__ import annotations

import os
import time

from aidulc_prep.core.errors import EngineError
from aidulc_prep.core.models import Chapter, SentenceAudio, WordTiming
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.core.word_alignment import align_tts_words_to_segments
from aidulc_prep.infra.checkpoint import is_done_sentence, save_stage_result
from aidulc_prep.pipeline.tts.engine import SAMPLE_RATE

# 时长/字符数 正常区间 (秒/字符)。实测 Kokoro: 约 0.08-0.15 s/字符
DUR_PER_CHAR_MIN = 0.03
DUR_PER_CHAR_MAX = 0.3

# 失败句静音占位时长 (秒), 保证章节时间轴连续 (pack 阶段与 pack.py 的 _write_silence 一致)
SILENCE_PLACEHOLDER_SECS = 0.5


def _map_timings_to_segments(timings: list[dict], segments) -> tuple[list[WordTiming], list[int]]:
    """把 Kokoro 的 (word, start_ms, end_ms) 映射到 segments 下标。

    用 core/word_alignment 的顺序贪心拼接匹配 (审查确认的坑: 旧实现精确匹配失败
    直接 break, 导致 daisy-chain 之后所有词丢失)。返回 (WordTiming 列表, 未覆盖的
    非标点 segment 下标)。
    """
    ordered, uncovered = align_tts_words_to_segments(timings, segments)
    word_timings = [
        WordTiming(seg_idx=t["seg_idx"], start_ms=t["start_ms"], end_ms=t["end_ms"])
        for t in ordered
    ]
    return word_timings, uncovered


def _write_silence_wav(path: str, seconds: float = SILENCE_PLACEHOLDER_SECS) -> None:
    import numpy as np
    import soundfile as sf
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32), SAMPLE_RATE)


def synth_chapter(
    chapter: Chapter,
    model_path: str,
    voice: str,
    speed: float,
    out_dir: str,
    quality: QualityReport,
    emit=None,
    cancel=None,
    language: str = "en",
    chapter_base: int = 0,
) -> None:
    """合成一章: 逐句 TTS, 时间轴写入句子.words, checkpoint 存音频路径+时间轴。"""
    # M 系列: 走注册表 (create_engine), 不再绕过
    from aidulc_prep.pipeline.tts.registry import create_engine
    engine = create_engine("kokoro", model_path, language=language)
    chapter_start_ms = 0
    # 计算章节起点: 重跑时从已有 checkpoint 恢复累计时间
    # Bug fix: 用 enumerate 而非 .index(s) (重复句会取错 checkpoint — 审查确认)
    for i, s in enumerate(chapter.sentences):
        data = _load_ckpt(out_dir, chapter.index, i)
        if data and data.get("audio"):
            chapter_start_ms = max(chapter_start_ms, data["audio"]["end_ms"])

    for i, s in enumerate(chapter.sentences):
        if cancel and cancel():
            raise EngineError("已取消", "tts")
        if s.status == "failed" and "translate" in s.failed_stages:
            # 跳过句也必须推进时间轴 (pack 会给缺失 wav 插 0.5s 静音,
            # 不推进会导致后续句时间轴整体偏早 — 审查确认 B2)
            chapter_start_ms += int(SILENCE_PLACEHOLDER_SECS * 1000)
            continue
        text = s.original_text
        if not text.strip():
            # 空文本句: 同样写静音占位 + 推进时间轴 (pack 会给缺失 wav 插 0.5s 静音,
            # 不推进会导致后续句时间轴整体偏早 0.5s — 审查发现 B3)
            s.mark_failed("tts")
            wav_path = os.path.join(out_dir, "audio_raw", f"ch{chapter.index:03d}", f"s{i:05d}_sil.wav")
            _write_silence_wav(wav_path)
            start_ms = chapter_start_ms
            end_ms = start_ms + int(SILENCE_PLACEHOLDER_SECS * 1000)
            s.audio = SentenceAudio(chapter=chapter.index, start_ms=start_ms, end_ms=end_ms)
            s.words = []
            chapter_start_ms = end_ms
            save_stage_result(out_dir, chapter.index, i, "audio", None, status="failed")
            save_stage_result(out_dir, chapter.index, i, "words", [], status="failed")
            quality.record("tts", ok=False)
            quality.add_failure(chapter.index, i, ["tts"], "空文本句")
            continue

        data = _load_ckpt(out_dir, chapter.index, i)
        if data and data.get("audio"):
            # 已合成: 恢复时间轴
            s.audio = SentenceAudio(chapter=chapter.index, start_ms=data["audio"]["start_ms"], end_ms=data["audio"]["end_ms"])
            s.words = [WordTiming(**w) for w in data.get("words", [])]
            chapter_start_ms = data["audio"]["end_ms"]
            quality.record("tts", ok=True)
            if emit:
                emit({"type": "sentence_done", "ts": int(time.time() * 1000), "sentence_index": chapter_base + i, "status": "ok"})
            continue

        # 合成 (重试一次)
        audio, timings, ok = None, [], False
        for attempt in (1, 2):
            try:
                audio, timings = engine.synth(text, voice, speed)
                ok = True
                break
            except EngineError:
                if emit:
                    emit({"type": "error", "ts": int(time.time() * 1000), "message": f"第 {i} 句 TTS 失败 (重试 {attempt})", "stage": "tts"})
                time.sleep(1)

        if not ok or audio is None:
            s.mark_failed("tts")
            # 失败句: 不写 audio 完成态 (G2: 失败结果不得被 is_done_sentence 误判为完成),
            # 但推进章节时间轴保证连续 (pack 阶段静音占位)
            wav_path = os.path.join(out_dir, "audio_raw", f"ch{chapter.index:03d}", f"s{i:05d}_sil.wav")
            _write_silence_wav(wav_path)
            start_ms = chapter_start_ms
            end_ms = start_ms + int(SILENCE_PLACEHOLDER_SECS * 1000)
            s.audio = SentenceAudio(chapter=chapter.index, start_ms=start_ms, end_ms=end_ms)
            s.words = []
            chapter_start_ms = end_ms
            save_stage_result(out_dir, chapter.index, i, "audio", None, status="failed")
            save_stage_result(out_dir, chapter.index, i, "words", [], status="failed")
            quality.record("tts", ok=False)
            quality.add_failure(chapter.index, i, ["tts"], "TTS 合成失败")
            continue

        # 校验 时长/字符数
        dur_s = len(audio) / SAMPLE_RATE
        per_char = dur_s / max(len(text), 1)
        if per_char < DUR_PER_CHAR_MIN or per_char > DUR_PER_CHAR_MAX:
            s.mark_failed("tts")
            wav_path = os.path.join(out_dir, "audio_raw", f"ch{chapter.index:03d}", f"s{i:05d}_sil.wav")
            _write_silence_wav(wav_path)
            start_ms = chapter_start_ms
            end_ms = start_ms + int(SILENCE_PLACEHOLDER_SECS * 1000)
            s.audio = SentenceAudio(chapter=chapter.index, start_ms=start_ms, end_ms=end_ms)
            s.words = []
            chapter_start_ms = end_ms
            save_stage_result(out_dir, chapter.index, i, "audio", None, status="failed")
            save_stage_result(out_dir, chapter.index, i, "words", [], status="failed")
            quality.record("tts", ok=False)
            quality.add_failure(chapter.index, i, ["tts"], f"时长/字符比异常: {per_char:.3f}s/char")
            continue

        words, uncovered = _map_timings_to_segments(timings, s.segments)
        start_ms = chapter_start_ms
        end_ms = start_ms + int(dur_s * 1000)
        s.audio = SentenceAudio(chapter=chapter.index, start_ms=start_ms, end_ms=end_ms)
        # 词级时间轴存句内相对 ms (Kokoro 输出即相对), 阅读器用 sentence.audio.start_ms + word.start_ms 定位
        s.words = words
        chapter_start_ms = end_ms

        # 对齐覆盖率: 有未覆盖的非标点 segment → 标记 align 失败 (审查确认: 旧实现不查覆盖率,
        # 倒数第二句半句无高亮却 quality 全绿)
        if uncovered:
            s.mark_failed("align")
            quality.record("align", ok=False)
            quality.add_failure(
                chapter.index, i, ["align"],
                f"{len(uncovered)} 个词无时间轴: " + ", ".join(
                    s.segments[u].word for u in uncovered[:10]
                ),
            )

        # 存每句 wav (pack 阶段合并编码)
        import numpy as np
        import soundfile as sf
        wav_path = os.path.join(out_dir, "audio_raw", f"ch{chapter.index:03d}", f"s{i:05d}.wav")
        os.makedirs(os.path.dirname(wav_path), exist_ok=True)
        audio_float = np.asarray(audio, dtype=np.float32)
        sf.write(wav_path, audio_float, SAMPLE_RATE)

        save_stage_result(out_dir, chapter.index, i, "audio", {
            "chapter": chapter.index, "start_ms": start_ms, "end_ms": end_ms, "wav": wav_path,
        })
        save_stage_result(out_dir, chapter.index, i, "words", [w.__dict__ for w in words])
        quality.record("tts", ok=True)
        if emit:
            emit({"type": "sentence_done", "ts": int(time.time() * 1000), "sentence_index": chapter_base + i, "status": "ok"})

    # 整章音频暂存 (pack 阶段再合并编码)


def _load_ckpt(out_dir: str, chapter: int, index: int) -> dict | None:
    from aidulc_prep.infra.checkpoint import load_sentence
    return load_sentence(out_dir, chapter, index)
