"""pack 阶段回归测试: ffmpeg 子进程不弹控制台窗口。

`_chapter_opus_ok`(该章 opus 可否跳过重编码)的用例 2026-08-31 整体迁到
`test_pack_opus_staleness.py`, 原因不是图省事, 是原来那批用例锁的前提被实测证伪:

- 原 `test_chapter_opus_ok_float32_ratio` 断言"wav 是 float32(96000B/s), opus ≈ wav/24"。
  但 tts/stage.py 走 `sf.write(path, float32数组, SR)` 落盘的其实是 **16-bit PCM**
  (soundfile 的 WAV 默认 subtype 是 PCM_16, 数组 dtype 不决定文件位深), 实测 wav 头
  audioFormat=1、位深=16、字节率=48000。按 /24 算期望值只有真值的一半, 让"文件大小
  >= 期望*0.9"的实际容差变成 **55%** —— 陈旧 opus 因此被长期放行, 这正是用户报的
  "跟读错位且无法修正"的根因。新文件里的
  `test_wav_written_by_soundfile_is_16bit_not_float32` 把这个前提钉死了。
- 其余用例用 全零字节 blob 当 wav(没有 WAV 头), 因为旧判据只看文件大小才写得出来。
  新判据读 wav 头算时长, 假 blob 时长为 0 —— 孤儿检测那两条会"通过"但走的是错分支,
  属于静默假阳性, 比失败更危险。新文件里全部改用真 wav, 意图逐条保留。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.models import Chapter
from aidulc_prep.pipeline.pack import _encode_chapter


def test_encode_chapter_ffmpeg_call_does_not_pop_console_window(tmp_path, monkeypatch):
    """2026-08-20 (用户报"打开书弹一个 CMD 窗口"): 侧车本身用 CREATE_NO_WINDOW 起、
    自己没有控制台; Windows 上没控制台的进程再 spawn 子进程若不显式传这个 flag,
    会自动新分配一个控制台给子进程——每次 ffmpeg 编码都闪一下 cmd。Rust 侧 11 处
    Command::new 早就统一带了这个 flag, prep 这边唯一调 subprocess 的地方漏了。

    这里不真的起 ffmpeg(测试环境未必有), 用 stub 拦截 subprocess.run 记录调用时的
    kwargs, 断言 Windows 上一定带了 creationflags=CREATE_NO_WINDOW。"""
    calls = []

    def _stub_run(cmd, **kwargs):
        calls.append(kwargs)
        # _encode_chapter 后面会 os.replace(tmp_path, out_path), tmp_path 是 cmd 最后一个参数
        with open(cmd[-1], "wb") as f:
            f.write(b"\x00")
        class _Result:
            returncode = 0
        return _Result()

    monkeypatch.setattr(subprocess, "run", _stub_run)

    out_dir = str(tmp_path)
    audio_dir = os.path.join(out_dir, "audio")
    bookpack_dir = os.path.join(out_dir, "bookpack")
    os.makedirs(audio_dir)
    os.makedirs(bookpack_dir)
    # 空章(没有任何句子 wav 落盘)走"整章全失败"分支, 是唯一路径最短能触发
    # subprocess.run 的场景, 不需要真的合成语音。
    ch = Chapter(index=0, title="T", sentences=[])

    _encode_chapter("ffmpeg", ch, out_dir, audio_dir, bookpack_dir, None, total_chapters=1)

    assert len(calls) == 1, f"应该恰好调用一次 ffmpeg, 实得 {len(calls)}"
    if sys.platform == "win32":
        assert calls[0].get("creationflags") == subprocess.CREATE_NO_WINDOW, (
            f"Windows 上 ffmpeg 子进程必须带 CREATE_NO_WINDOW, 实得 kwargs={calls[0]}"
        )
