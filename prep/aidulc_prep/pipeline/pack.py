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
import sys

from aidulc_prep.core.errors import OutputError
from aidulc_prep.core.models import Book
from aidulc_prep.core.quality import QualityReport

FFMPEG = "ffmpeg"  # 运行时依赖 (Phase 8 打包时绑定绝对路径)

# 2026-08-20 (用户报"打开书弹一个 CMD 窗口"): 侧车本身被 Rust 那边用
# CREATE_NO_WINDOW 起, 自己没有控制台; Windows 上没控制台的进程再 spawn 子进程
# 若不显式传这个 flag, 会自动新分配一个控制台窗口给子进程——ffmpeg 每次编码/合并
# 都会闪一下 cmd。Rust 侧 11 处 Command::new 早就统一带了这个 flag(参见
# job_orchestrator.rs 等), 这里(prep 这边唯一调 subprocess 的地方)漏掉了。
_SUBPROCESS_KW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

# 缺失句的静音占位时长。_encode_chapter 写占位 wav 与 _chapter_opus_ok 算期望时长
# 必须用同一个值 —— 两边对不上会让"完好的章"被判成陈旧、每次重跑都全量重编。
# 与 tts/stage.py 的 SILENCE_PLACEHOLDER_SECS 是同一语义(那边推进时间轴, 这边补音频)。
SILENCE_PLACEHOLDER_SECS = 0.5


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


def _wav_duration_ms(path: str) -> float:
    """读 wav 头拿时长 (只读头, 不读采样点)。读不出来返回 0。"""
    import wave
    try:
        with wave.open(path) as w:
            return w.getnframes() / float(w.getframerate()) * 1000.0
    except Exception:
        return 0.0


def _find_ffprobe(ff: str | None) -> str | None:
    """ffprobe 通常和 ffmpeg 同目录, 找不到再退 PATH。"""
    if ff:
        cand = os.path.join(os.path.dirname(ff), "ffprobe" + (".exe" if ff.lower().endswith(".exe") else ""))
        if os.path.exists(cand):
            return cand
    from shutil import which
    return which("ffprobe")


def _opus_duration_ms(ff: str | None, path: str) -> float | None:
    """opus 实际时长 (ms)。测不出来返回 None —— 调用方应据此判定"不可信, 重编"。"""
    probe = _find_ffprobe(ff)
    if not probe:
        return None
    try:
        r = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30, **_SUBPROCESS_KW,
        )
        return float(r.stdout.strip()) * 1000.0
    except Exception:
        return None


# 判定 opus 与输入 wav 是否吻合的时长容差。
# 实测 Winn-Dixie 28 章: 真正是本轮编出来的章, 差值**稳定就是 +6ms**(opus 编码前导),
# 没有一个例外; 而输入变过的章最小也差到 32~44ms、往上到 -13544ms。50ms 卡在这条清晰
# 的分界上 —— 比编码噪声大一个量级, 比任何真实偏差小一个量级。
# 不要为了少重编几章把它调大: 这个数字是拿实测分布定的, 不是拍的。
OPUS_DURATION_TOLERANCE_MS = 50.0


# 一个句 wav 的时长与时间轴对不上多少就算"不是这句的音频"。取值同 opus 容差,
# 反正真正的陈旧残留差的是**秒**级 (实测 Hatchet ch000#158: 时间轴 500ms, 磁盘 21800ms)。
WAV_MATCH_TOLERANCE_MS = 50.0


def _sentence_plan(out_dir: str, ch) -> list[tuple[str | None, float]]:
    """这一章每句实际要拼进 opus 的 (wav 路径 | None 表示静音, 时长 ms)。

    2026-09-01 新增, 修的是与"陈旧 opus"同族、但更隐蔽的一个缺陷:
    **同一句的时长有两个来源, 而且会打架**。原来 _encode_chapter 是"磁盘上有
    s{i:05d}.wav 就拼它, 没有就补 0.5s 静音", 完全不看时间轴怎么说。于是:

      Hatchet ch000 句158 = "Bad." —— checkpoint 里 audio=null / failedStages=[tts,align],
      时间轴按占位给了 500ms, 磁盘上却同时躺着两个文件:
        s00158_sil.wav   500ms  (2026-08-18 这一轮写的占位)
        s00158.wav     21800ms  (2026-08-13 上一轮留下的, 那轮句子切分不同,
                                 158 号指的是**另一句话**)
      concat 挑了 s00158.wav, 于是章节音轨里凭空多出 21.8 秒不相干的朗读,
      **从这句起后面每一句都错位 -21.3s, 恒定到章尾**。

    这类残留全库 40 章 (Wonder 14 / Wild Robot 11 / Hatchet 7 / Despereaux 6 /
    Winn-Dixie 1 / First State 1), 且**重跑修不好** —— tts 阶段命中 checkpoint 就
    只从 checkpoint 借时长, 从来不看磁盘上那个 wav 多长; pack 又只看磁盘不看时间轴。
    两边各信各的, 谁也发现不了。

    修法是定一个唯一权威: **时间轴说了算**。句 wav 只有时长对得上才用, 对不上就当它
    不是这句的音频, 按时间轴的时长补静音。这样拼出来的 opus 与时间轴逐句吻合是
    **构造保证**的, 不再依赖"磁盘是干净的"这个假设。
    """
    wav_dir = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}")
    plan: list[tuple[str | None, float]] = []
    for i, s in enumerate(ch.sentences):
        a = getattr(s, "audio", None)
        want_ms = float(a.end_ms - a.start_ms) if a else SILENCE_PLACEHOLDER_SECS * 1000.0
        wav = os.path.join(wav_dir, f"s{i:05d}.wav")
        if os.path.exists(wav):
            got = _wav_duration_ms(wav)
            if got > 0 and abs(got - want_ms) <= WAV_MATCH_TOLERANCE_MS:
                plan.append((wav, got))
                continue
        plan.append((None, want_ms))
    return plan


def _chapter_opus_ok(out_dir: str, audio_dir: str, ch, ff: str | None = None) -> bool:
    """该章 opus 是否已存在且**与当前输入吻合**, 可以跳过重编码。

    2026-08-31 重写判据 (用户报 Because of Winn-Dixie "跟读错位且无法修正", 实测追因)。

    旧判据是"opus 文件大小 >= 预期 * 0.9", 预期按 `total_wav / 24` 算。两个问题:

    1. **字节率口径本身是错的**。注释断言"wav 是 float32(96000B/s)", 但 tts/stage.py
       走 `sf.write(path, float32数组, SR)` —— soundfile 的 WAV 默认 subtype 是 PCM_16,
       **数组是 float32 不代表文件是 float32**。实测 wav 头: audioFormat=1(PCM)、
       位深=16、字节率=48000。所以真实期望应该是 total/12, 用 /24 让期望值只有真值
       的一半 → 实际容差是 **55%** 而不是以为的 10%。
    2. **就算口径对了, 用文件大小当缓存失效判据也是错的**。它只能看出"产物被截断",
       看不出"产物是上一轮跑的、和现在的句子对不上"。

    后果: 陈旧 opus 被判"完好"永远跳过重编码, 重跑备料也修不好 —— 这正是用户说的
    "无法修正"。实测 Winn-Dixie 28 章里 4 章真坏(ch005 -3944ms / ch007 -9694ms /
    ch016 -13544ms / ch025 +1682ms), 旧判据**一个都没抓到**; 全库扫描 10 本书共
    137 章 opus 陈旧。

    新判据直接比**时长** —— 这不是启发式, 它就是判定"坏"的那把尺子本身:
    - 期望时长 = `_sentence_plan` 逐句时长之和。用**同一份计划**而不是"照着同一条规则
      各算一遍" —— 后者是 2026-09-01 那个缺陷的形状(拼接看磁盘、时间轴看 checkpoint,
      两边各信各的)。与字节率/位深无关, 绕开上面第 1 类错误。
    - 测不出实际时长(没有 ffprobe / 文件损坏) → 判定不可信, 重编。宁可多花几秒, 不留错位。

    **为什么不用 mtime**(第一版写过, 拿真实数据验完删掉的): "opus 比输入 wav 旧就判陈旧"
    看着很合理, 实测却把 28 章里的 24 章判成陈旧 —— 因为 Kokoro 是确定性的, **同样的
    文本重新合成得到同样的音频**, wav 被重写不代表内容变了(ch001~ch004 的 wav 都比
    opus 新, 时长却只差 -118/-68/-94/+82ms)。硬否决会让"重试不全量重编"这个优化基本
    失效。它也提供不了加速: ch025 是 mtime 说完好、时长说坏, 所以 ffprobe 每章都得跑,
    mtime 省不掉任何一次。既不安全也不省事, 整条删掉。

    **为什么删掉了孤儿文件检查**(2026-08-19 加的那条: 磁盘上存在索引 >= 当前句数的 sN
    文件就强制重编): 它是**代理指标**, 而时长是**直接测量**, 前者已被后者完全覆盖。
    孤儿 wav 只是磁盘残留, 并不证明 opus 是拿它们编的 —— `_encode_chapter` 只遍历
    `range(len(ch.sentences))`, 本来就不会把孤儿拼进去。真要是拿旧的、更大的句集编的,
    多出来的句子是**以秒计**的时长差, 50ms 容差一定抓得到。留着它的代价是实测把 28 章
    里的 21 个好章判成坏的(章节重新解析后普遍留 2~12 个孤儿), "重试不全量重编"这个
    优化基本失效。它当初能立功, 是因为当时唯一的另一条判据(比文件大小)本身是坏的。
    """
    ch_index = ch.index
    out_path = os.path.join(audio_dir, f"ch_{ch_index:03d}.opus")
    if not os.path.exists(out_path):
        return False
    wav_dir = os.path.join(out_dir, "audio_raw", f"ch{ch_index:03d}")
    if not os.path.isdir(wav_dir):
        return False

    # 期望时长 = _sentence_plan 的逐句时长之和 —— 与 _encode_chapter 拼的是**同一份计划**,
    # 不是"照着规则各算一遍"。两边各写一份规则正是 2026-09-01 那个缺陷的形状。
    expected_ms = sum(d for _, d in _sentence_plan(out_dir, ch))
    if expected_ms <= 0:
        return False

    actual_ms = _opus_duration_ms(ff, out_path)
    if actual_ms is None:
        return False  # 测不出来 = 不可信, 重编
    return abs(actual_ms - expected_ms) <= OPUS_DURATION_TOLERANCE_MS


def _encode_chapter(ff, ch, out_dir, audio_dir, bookpack_dir, emit, total_chapters=1):
    """合并一章的句 wav → 一条 opus。静音占位失败句 (0.3s 静音)。"""
    import time
    out_path = os.path.join(audio_dir, f"ch_{ch.index:03d}.opus")
    # 已完成的章跳过 (重试时不全量重编码)。判据 2026-08-31 重写成"比时长"而不是"比文件
    # 大小", 见 _chapter_opus_ok 说明 —— 旧判据放行陈旧 opus, 是"跟读错位且无法修正"的根因。
    if _chapter_opus_ok(out_dir, audio_dir, ch, ff):
        if emit:
            emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "pack",
                  "current": ch.index + 1, "total": total_chapters})
        return
    # 拼什么由 _sentence_plan 决定 (时间轴说了算), 不再是"磁盘上有什么就拼什么" ——
    # 后者会把上一轮留下的、属于**别的句子**的 wav 拼进来, 见 _sentence_plan 说明。
    wavs = []
    for i, (wav, dur_ms) in enumerate(_sentence_plan(out_dir, ch)):
        if wav is not None:
            wavs.append(wav)
        else:
            sil = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}", f"s{i:05d}_sil.wav")
            _write_silence(sil, dur_ms / 1000.0)
            wavs.append(sil)

    if not wavs:
        # 整章全失败: 用 ffmpeg 生成真实空 opus (soundfile 不支持 .opus 扩展名, 已实测崩溃)
        sil_wav = os.path.join(out_dir, "audio_raw", f"ch{ch.index:03d}_sil.wav")
        _write_silence(sil_wav, 0.1)
        tmp_path = out_path[:-5] + ".tmp.opus"
        cmd = [ff, "-y", "-i", sil_wav, "-c:a", "libopus", "-b:a", "32k", tmp_path]
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True, **_SUBPROCESS_KW)
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
            subprocess.run(cmd, capture_output=True, timeout=120, check=True, **_SUBPROCESS_KW)
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
        subprocess.run(cmd, capture_output=True, timeout=encode_timeout, check=True, **_SUBPROCESS_KW)
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
