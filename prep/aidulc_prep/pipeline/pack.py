"""
pipeline/pack.py —— ffmpeg 合并编码 + 写书包 + 写 quality.json

- 每章一条 Opus 流 (11h WAV=1.9GB → Opus 32k ≈ 160MB, 必须编码)
- 只编码成功的句 (partial/failed 句的音频段留静音占位, 保证时间轴连续)
- 写 bookpack.json (schemaVersion=1, 契约冻结)
"""
from __future__ import annotations

import json
import os
import subprocess

from aidulc_prep.core.errors import OutputError
from aidulc_prep.core.models import Book
from aidulc_prep.core.quality import QualityReport

FFMPEG = "ffmpeg"  # 运行时依赖 (Phase 8 打包时绑定绝对路径)


def _atomic_write_json(path: str, obj) -> None:
    """原子写 JSON (tmp + rename) — Bug fix 审查确认: 旧实现直接写, 崩溃留半截 JSON"""
    import tempfile
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def find_ffmpeg(explicit: str | None = None) -> str:
    if explicit and os.path.exists(explicit):
        return explicit
    # Bug fix (审查确认): 优先环境变量/任务快照里的 ffmpeg, 再 PATH; 最后才用开发机兜底
    env = os.environ.get("AIDULC_FFMPEG")
    if env and os.path.exists(env):
        return env
    from shutil import which
    found = which("ffmpeg")
    if found:
        return found
    if os.path.exists(r"F:\my_ai\subgen\dist\ffmpeg\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe"):
        return r"F:\my_ai\subgen\dist\ffmpeg\ffmpeg-8.1.2-essentials_build\bin\ffmpeg.exe"
    raise OutputError("找不到 ffmpeg", detail="设置 ffmpeg_path 或加入 PATH")


def pack_book(
    book: Book,
    out_dir: str,
    job: dict,
    quality: QualityReport,
    ffmpeg: str | None = None,
    emit=None,
    cancel=None,
) -> str:
    """产出 <out_dir>/bookpack.json + audio/. 返回 bookpack.json 路径。"""
    ff = find_ffmpeg(ffmpeg)
    # out_dir 就是书包根 (Phase 8 端到端踩过: 之前用 out_dir/.. 把书包写到父目录,
    # 污染了开发目录的 bookpack.json —— out_dir 本身就是书包目录)
    bookpack_dir = os.path.normpath(out_dir)

    audio_dir = os.path.join(bookpack_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)

    total_chapters = len(book.chapters)
    for ch in book.chapters:
        if cancel and cancel():
            from aidulc_prep.core.errors import EngineError
            raise EngineError("已取消", "pack")
        _encode_chapter(ff, ch, out_dir, audio_dir, bookpack_dir, emit, total_chapters)

    # R4 (2026-08-08): 原书插图拷进书包 images/, chapter.images[].file 改写成书包内路径
    images_dir = os.path.join(bookpack_dir, "images")
    os.makedirs(images_dir, exist_ok=True)
    for ch in book.chapters:
        _copy_chapter_images(ch, images_dir, job.get("book_path", ""))

    # K2-2 (2026-08-13): 封面拷进书包根 (同 _copy_chapter_images 的读字节套路, 单文件版)
    cover_file = _copy_cover(book, bookpack_dir, job.get("book_path", ""))

    # 组装 bookpack.json
    profile = job.get("profile") or {}
    bp = {
        "schemaVersion": 1,
        "title": book.title,
        "profile": {
            "id": profile.get("id", "default"),
            "name": profile.get("name", profile.get("id", "default")),
            "explainStrategy": profile.get("explain_strategy", "brief"),
            "voice": profile.get("voice", "af_heart"),
            "speed": profile.get("speed", 1.0),
        },
        "generatedAt": int(__import__("time").time() * 1000),
        "prepVersion": "0.1.0",
        "cover": cover_file,
        "chapters": [
            {
                "index": ch.index,
                "title": ch.title,
                "audioFile": f"audio/ch_{ch.index:03d}.opus",
                "images": [
                    {"file": img.file, "at": img.at}
                    for img in ch.images
                ] if ch.images else [],
                "sentences": [
                    {
                        "original_text": s.original_text,
                        "translation": s.translation,
                        "explanation": s.explanation,
                        "segments": [seg.to_list() for seg in s.segments],
                        "phrasal_verbs": [
                            {"text": pv.text, "indices": pv.indices, "lemma": pv.lemma, "translation": pv.translation}
                            for pv in s.phrasal_verbs
                        ],
                        "audio": None if not s.audio else {
                            "chapter": s.audio.chapter, "start_ms": s.audio.start_ms, "end_ms": s.audio.end_ms,
                        },
                        "words": [{"seg_idx": w.seg_idx, "start_ms": w.start_ms, "end_ms": w.end_ms} for w in s.words],
                        "status": s.status,
                        "failedStages": s.failed_stages,
                    }
                    for s in ch.sentences
                ],
            }
            for ch in book.chapters
        ],
        "quality": quality.to_dict(),
        "models": job.get("models", {}),
    }

    from aidulc_prep.core.schema import validate_bookpack
    errs = validate_bookpack(bp)
    if errs:
        raise OutputError("书包校验失败", detail="; ".join(errs))

    bp_path = os.path.join(bookpack_dir, "bookpack.json")
    _atomic_write_json(bp_path, bp)

    # quality.json 独立一份 (备料台/阅读器数据源)
    _atomic_write_json(os.path.join(bookpack_dir, "quality.json"), quality.to_dict())

    if emit:
        emit({"type": "stage_done", "ts": int(__import__("time").time() * 1000), "stage": "pack", "current": len(book.chapters), "total": len(book.chapters)})
    return bp_path


def _rm_quiet(path: str):
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _copy_cover(book, bookpack_dir: str, source_book: str) -> str | None:
    """把封面从源书 (EPUB zip) 拷进书包根, 返回书包内相对路径 (无封面/拷贝失败返回 None,
    不让打包失败 —— 封面是展示性数据, 同 _copy_chapter_images 的"缺了就跳过"原则)。"""
    if not book.cover:
        return None
    if not (source_book and os.path.exists(source_book)):
        return None
    import zipfile
    try:
        with zipfile.ZipFile(source_book) as zf:
            src = book.cover.replace("\\", "/")
            data = zf.read(src)
    except (zipfile.BadZipFile, KeyError):
        return None
    ext = os.path.splitext(src)[1] or ".jpg"
    dest_name = f"cover{ext}"
    dest_path = os.path.join(bookpack_dir, dest_name)
    with open(dest_path, "wb") as f:
        f.write(data)
    # 2026-08-18: 顺手生成缩略图。封面是原始尺寸原样落盘的, 实测 10 本书里最大一张
    # 是 1742x2284 的 PNG / 8.95 MB, 而书库卡片上只占一个两指宽的格子 —— 整张搬去
    # 前端等于每次进书库都过一遍 9 MB 的 base64。缩略图在这里做掉, 前端直接读几十 KB。
    # 失败只是没有缩略图 (前端有 canvas 兜底那条路), 不影响打包。
    from aidulc_prep.core.thumbnail import make_cover_thumb
    make_cover_thumb(dest_path, bookpack_dir)
    return dest_name


def _copy_chapter_images(ch, images_dir: str, source_book: str) -> None:
    """把一章的插图从源书 (EPUB zip) 拷进书包 images/, 并就地改写 img.file。

    R4 (2026-08-08): ChapterImage.file 在 loader 里是书根相对路径 (如
    OEBPS/images/fig1.jpg)。这里从源 EPUB 读字节写进 images/, 文件名加章节前缀
    防跨章重名 (ch_000_fig1.jpg)。源书不是 zip / 图片缺失 → 记日志跳过, 不中断打包。
    """
    if not ch.images:
        return
    import zipfile
    from aidulc_prep.core.models import ChapterImage

    zf = None
    if source_book and os.path.exists(source_book):
        try:
            zf = zipfile.ZipFile(source_book)
        except zipfile.BadZipFile:
            zf = None
    for img in list(ch.images):
        src = img.file.replace("\\", "/")
        base = os.path.basename(src)
        dest_name = f"ch_{ch.index:03d}_{base}"
        dest = os.path.join(images_dir, dest_name)
        ok = False
        if zf is not None:
            # EPUB 内路径是书根相对; 若打不开就跳过
            try:
                data = zf.read(src)
                with open(dest, "wb") as f:
                    f.write(data)
                ok = True
            except KeyError:
                pass
        if not ok:
            # 源文件不是 zip (txt/pdf) 或图片缺失 → 直接去掉这条, 不让打包失败
            ch.images.remove(img)
            continue
        img.file = f"images/{dest_name}"
    if zf is not None:
        zf.close()


def _chapter_opus_ok(out_dir: str, audio_dir: str, ch_index: int) -> bool:
    """该章 opus 是否已存在且完整。opus(32kbps=4000B/s) ≈ wav 总量/24 —— wav 是 float32
    (24000Hz×4B/s 单声道, tts/stage 用 sf.write float32), 不是 16-bit(48000B/s)。之前按
    /12 (16-bit 口径) 算期望值恒偏大 2× → "已编码可跳过"永远不成立, 重试总是全量重编码。"""
    out_path = os.path.join(audio_dir, f"ch_{ch_index:03d}.opus")
    if not os.path.exists(out_path):
        return False
    wav_dir = os.path.join(out_dir, "audio_raw", f"ch{ch_index:03d}")
    if not os.path.isdir(wav_dir):
        return False
    total_wav = 0
    for name in os.listdir(wav_dir):
        if name.endswith(".wav"):
            total_wav += os.path.getsize(os.path.join(wav_dir, name))
    if total_wav == 0:
        return False
    expected = total_wav / 24
    return os.path.getsize(out_path) >= expected * 0.9


def _encode_chapter(ff, ch, out_dir, audio_dir, bookpack_dir, emit, total_chapters=1):
    """合并一章的句 wav → 一条 opus。静音占位失败句 (0.3s 静音)。"""
    import time
    out_path = os.path.join(audio_dir, f"ch_{ch.index:03d}.opus")
    # 已完成的章跳过 (重试时不全量重编码)。校验: opus 大小 ≈ wav 总量/12 (32kbps vs 48000B/s pcm),
    # <90% 视为不完整 (超时 kill 的部分产物) → 重新编码
    if _chapter_opus_ok(out_dir, audio_dir, ch.index):
        if emit:
            emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "pack",
                  "current": ch.index + 1, "total": total_chapters})
        return
    wavs = []
    for i, s in enumerate(ch.sentences):
        wav = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}", f"s{i:05d}.wav")
        if os.path.exists(wav):
            wavs.append(wav)
        else:
            # 静音占位 (0.5s 静音 @24k)
            _write_silence(os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}", f"s{i:05d}_sil.wav"), 0.5)
            wavs.append(os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}", f"s{i:05d}_sil.wav"))

    if not wavs:
        # 整章全失败: 用 ffmpeg 生成真实空 opus (soundfile 不支持 .opus 扩展名, 已实测崩溃)
        sil_wav = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_sil.wav")
        _write_silence(sil_wav, 0.1)
        tmp_path = out_path[:-5] + ".tmp.opus"
        cmd = [ff, "-y", "-i", sil_wav, "-c:a", "libopus", "-b:a", "32k", tmp_path]
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True)
        except subprocess.CalledProcessError as e:
            _rm_quiet(tmp_path)
            raise OutputError(f"ffmpeg 生成空章 {ch.index} 失败", detail=e.stderr.decode("utf-8", errors="replace")[:500]) from e
        os.replace(tmp_path, out_path)
        return

    # concat list 文件
    concat_list = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_list.txt")
    with open(concat_list, "w", encoding="utf-8") as f:
        for w in wavs:
            f.write(f"file '{w.replace(chr(39), chr(39) + chr(39))}'\n")

    # 修复: 645+ wav concat 卡死 (实测 ffmpeg 对大量文件 + 参数不一致卡住)
    # → 强制统一采样率/声道 (-ar 24000 -ac 1), 并分块合并 (每 100 个一批, 再合并中间文件)
    mid_parts = []
    for batch_start in range(0, len(wavs), 100):
        batch = wavs[batch_start:batch_start + 100]
        batch_list = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_batch{batch_start//100}.txt")
        with open(batch_list, "w", encoding="utf-8") as f:
            for w in batch:
                f.write(f"file '{w.replace(chr(39), chr(39) + chr(39))}'\n")
        mid_wav = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_mid{batch_start//100}.wav")
        cmd = [ff, "-y", "-f", "concat", "-safe", "0", "-i", batch_list,
               "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", mid_wav]
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True)
        except subprocess.CalledProcessError as e:
            raise OutputError(f"ffmpeg 合并第 {ch.index} 章批次 {batch_start//100} 失败",
                              detail=e.stderr.decode("utf-8", errors="replace")[:500]) from e
        mid_parts.append(mid_wav)
    # 合并中间文件 → 最终 opus
    # 实测 (Hitchhikers ch005): 4.7h 音频 libopus 编码需 ~280s, 180s 超时会杀掉编码中进程
    # → 超时按输入规模动态: 编码速率 ~55x 实时 (4000B/s opus vs 48000B/s pcm), 余量 120s
    # → 临时文件 + rename (失败不留部分产物, 保证"存在即完整"供跳过复用)
    total_wav_bytes = sum(os.path.getsize(w) for w in wavs)
    # Bug fix (2026-08-13, 审计): wav 是 float32 (24000Hz×4B×1ch=96000B/s), 不是 16-bit
    # (48000B/s)。之前按 /48000 算 total_sec 偏大 2× → encode_timeout 也偏大 2× (安全方向,
    # 但口径错误)。按真实字节率算。
    total_sec = total_wav_bytes / 96000.0  # 24000Hz × 4B × 1ch
    encode_timeout = max(300, int(total_sec / 55) + 120)
    tmp_path = out_path[:-5] + ".tmp.opus"
    if len(mid_parts) == 1:
        mid_list = mid_parts[0]
        cmd = [ff, "-y", "-i", mid_list, "-c:a", "libopus", "-b:a", "32k", tmp_path]
    else:
        mid_list = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_mid_list.txt")
        with open(mid_list, "w", encoding="utf-8") as f:
            for m in mid_parts:
                f.write(f"file '{m.replace(chr(39), chr(39) + chr(39))}'\n")
        cmd = [ff, "-y", "-f", "concat", "-safe", "0", "-i", mid_list,
               "-ar", "24000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", tmp_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=encode_timeout, check=True)
    except subprocess.CalledProcessError as e:
        _rm_quiet(tmp_path)
        raise OutputError(f"ffmpeg 编码第 {ch.index} 章失败", detail=e.stderr.decode("utf-8", errors="replace")[:500]) from e
    except subprocess.TimeoutExpired as e:
        _rm_quiet(tmp_path)
        raise OutputError(f"ffmpeg 编码第 {ch.index} 章超时", detail="音频过长或编码器卡住") from e
    os.replace(tmp_path, out_path)
    if emit:
        emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "pack",
              "current": ch.index + 1, "total": total_chapters})


def _write_silence(path: str, seconds: float):
    import numpy as np
    import soundfile as sf
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sr = 24000
    sf.write(path, np.zeros(int(sr * seconds), dtype=np.float32), sr)
