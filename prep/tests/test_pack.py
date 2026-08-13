"""pack 阶段回归测试: opus 复用判定 (float32 wav 字节率口径)"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.pack import _chapter_opus_ok


def test_chapter_opus_ok_float32_ratio(tmp_path):
    """P1-5 修复 (2026-08-13): wav 是 float32 (96000B/s), opus 32kbps(4000B/s) ≈ wav/24。
    旧口径按 16-bit (/12) 算期望值恒偏大 2× → "已编码可跳过"永不成立。"""
    out = str(tmp_path)
    wav_dir = os.path.join(out, "audio_raw", "ch000")
    os.makedirs(wav_dir)
    # 1 秒 float32 单声道 @24k ≈ 96000 字节 (判定只看 size, 不解析 wav 头)
    with open(os.path.join(wav_dir, "s00000.wav"), "wb") as f:
        f.write(b"\x00" * 96000)

    audio_dir = os.path.join(out, "audio")
    os.makedirs(audio_dir)
    opus_path = os.path.join(audio_dir, "ch_000.opus")
    # 32kbps × 1s = 4000 字节; 写完整 (恰好 = 期望值)
    with open(opus_path, "wb") as f:
        f.write(b"\x00" * 4000)

    assert _chapter_opus_ok(out, audio_dir, 0), "4000B opus 对应 96000B float32 wav 应判完整可复用"


def test_chapter_opus_ok_rejects_partial(tmp_path):
    """不完整的 opus (如超时 kill 的部分产物) 必须重新编码, 不能被复用。"""
    out = str(tmp_path)
    wav_dir = os.path.join(out, "audio_raw", "ch000")
    os.makedirs(wav_dir)
    with open(os.path.join(wav_dir, "s00000.wav"), "wb") as f:
        f.write(b"\x00" * 96000)

    audio_dir = os.path.join(out, "audio")
    os.makedirs(audio_dir)
    opus_path = os.path.join(audio_dir, "ch_000.opus")
    # 只有期望值的 50% (< 90% 阈值) → 判不完整
    with open(opus_path, "wb") as f:
        f.write(b"\x00" * 2000)

    assert not _chapter_opus_ok(out, audio_dir, 0), "半截 opus 不得判完整"
