"""pack.py::_chapter_opus_ok —— "该章 opus 可否跳过重编码"的判据。

2026-08-31 用户报 Because of Winn-Dixie "跟读错位且无法修正", 实测追出根因就在这里:
旧判据"opus 文件大小 >= 预期 * 0.9"放行了**陈旧 opus**(上一轮跑的、和当前 wav 对不上
的那份), 于是重跑备料永远不重编那一章。全库扫描 10 本书共 137 章 opus 陈旧。

判据的**职责边界**要说清楚(实测厘清的, 别再混):
  这个函数只回答一件事 —— **opus 和当前磁盘上的 wav 是否吻合**。
  实测 Winn-Dixie 里两类不同的错位:
    - ch005/007/016: opus−wav = −3944/−9694/−13544, 时间轴−wav = 0
      → opus 陈旧, **归本函数管**, 必须重编。
    - ch025:         opus−wav = +6,                时间轴−wav = −1675
      → opus 是对的, 错的是**时间轴**(有 wav 却没写 audio checkpoint 的句子,
        时间轴不认账)。**不归本函数管**, 判"可跳过"才是正确的; 那是 tts/bookpack
        侧的独立缺陷。

用例不真的调 ffmpeg 编码 —— 打桩 ffprobe 的时长返回值, 测的是**判据逻辑**本身,
不依赖外部可变状态/真实硬件。wav 全部用真文件(有 WAV 头), 因为新判据读头算时长。
"""
import os
import wave

import pytest

from aidulc_prep.pipeline import pack


SR = 24000


def _write_wav(path: str, seconds: float) -> None:
    """写一个真 wav (16-bit PCM 24k 单声道 —— 与 tts/stage.py 经 soundfile 落盘的格式一致)"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x00\x00" * int(SR * seconds))


def _mk_chapter(tmp_path, n_sentences: int, sec_each: float = 2.0):
    """造一章: n 句真 wav + 一个占位 opus 文件。返回 (out_dir, audio_dir, 期望总时长ms)"""
    out_dir = str(tmp_path)
    audio_dir = os.path.join(out_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    for i in range(n_sentences):
        _write_wav(os.path.join(out_dir, "audio_raw", "ch000", f"s{i:05d}.wav"), sec_each)
    with open(os.path.join(audio_dir, "ch_000.opus"), "wb") as f:
        f.write(b"OggS" + b"\x00" * 4096)
    return out_dir, audio_dir, n_sentences * sec_each * 1000.0


@pytest.fixture
def stub_probe(monkeypatch):
    """打桩 opus 实际时长, 免去真的调 ffprobe"""
    def _set(ms):
        monkeypatch.setattr(pack, "_opus_duration_ms", lambda ff, path: ms)
    return _set


class TestChapterOpusOk:
    def test_exact_match_skips_reencode(self, tmp_path, stub_probe):
        """时长吻合 → 跳过重编码 (保住"重试不全量重编"这个既有优化, 它存在的理由是
        全量重编一本书要 2-3 小时)。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is True

    def test_encoder_preskip_within_tolerance(self, tmp_path, stub_probe):
        """opus 编码前导实测**稳定就是 +6ms**(28 章无一例外), 不能因此判陈旧、每次重编。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected + 6)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is True

    def test_opus_2s_short_forces_reencode(self, tmp_path, stub_probe):
        """opus 比输入短 2 秒 → 强制重编。

        这正是 Winn-Dixie ch005 的形状(-3944ms), 旧的"文件大小 >= 90%"判据放行了它,
        用户因此读到"错位且无法修正"。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected - 2000)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_opus_longer_than_inputs_forces_reencode(self, tmp_path, stub_probe):
        """opus 比输入**长**同样是不吻合 —— 判据必须取绝对值, 不能只防"被截断"。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected + 3000)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_just_beyond_tolerance_forces_reencode(self, tmp_path, stub_probe):
        """容差是 50ms: 实测分界非常干净 —— 本轮编的章差值恒为 +6ms, 输入变过的章
        最小也差到 32~44ms 往上。刚过线就要重编。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected - (pack.OPUS_DURATION_TOLERANCE_MS + 1))
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_opus_built_from_larger_old_sentence_set_is_caught(self, tmp_path, stub_probe):
        """章节被重新解析、句数变少后, 旧 opus 是拿更大的句集编的 → 时长会多出以秒计
        的量, 必被抓到。

        2026-08-19 曾为这个场景加过一条"磁盘上存在索引 >= 当前句数的孤儿 wav 就重编"
        的检查, 2026-08-31 删掉了: 它是**代理指标**(孤儿只是磁盘残留, 并不证明 opus
        是拿它们编的 —— _encode_chapter 只遍历当前句列表), 有大量假阳性; 实测它把
        28 章里 21 个好章判成坏的。时长是**直接测量**, 已完全覆盖这个场景。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        # 磁盘残留 2 个旧句 wav; 当前句数 10。旧 opus 是拿 12 句编的。
        for i in (10, 11):
            _write_wav(os.path.join(out_dir, "audio_raw", "ch000", f"s{i:05d}.wav"), 2.0)
        stub_probe(expected + 4000)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_leftover_orphan_files_alone_do_not_force_reencode(self, tmp_path, stub_probe):
        """对照组: 磁盘上有孤儿残留, 但 opus 时长与**当前**句集吻合 → 说明 opus 已经是
        重新编过的, 不该被误伤。这正是删掉孤儿检查所要修的假阳性。"""
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        for i in (10, 11):
            _write_wav(os.path.join(out_dir, "audio_raw", "ch000", f"s{i:05d}.wav"), 2.0)
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is True

    def test_unprobeable_opus_forces_reencode(self, tmp_path, stub_probe):
        """测不出时长(没装 ffprobe / 文件损坏) → 判不可信, 重编。
        宁可多花几秒重编, 也不要留一个错位的章节。"""
        out_dir, audio_dir, _ = _mk_chapter(tmp_path, 10)
        stub_probe(None)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_missing_wav_counted_as_silence_placeholder(self, tmp_path, stub_probe):
        """缺失句按 0.5s 静音算期望 —— 必须与 _encode_chapter 的拼接规则严格一致,
        两边对不上会让完好的章被判陈旧、每次重跑都全量重编。"""
        out_dir, audio_dir, _ = _mk_chapter(tmp_path, 10)
        os.remove(os.path.join(out_dir, "audio_raw", "ch000", "s00003.wav"))
        expected = 9 * 2000.0 + pack.SILENCE_PLACEHOLDER_SECS * 1000.0
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is True

    def test_sil_placeholder_not_double_counted(self, tmp_path, stub_probe):
        """缺失句既写了 `sNNNNN_sil.wav` 占位、又被算作"缺失 += 0.5s", 不能数两遍。
        判据只认精确的 s{i:05d}.wav。"""
        out_dir, audio_dir, _ = _mk_chapter(tmp_path, 10)
        os.remove(os.path.join(out_dir, "audio_raw", "ch000", "s00003.wav"))
        _write_wav(os.path.join(out_dir, "audio_raw", "ch000", "s00003_sil.wav"),
                   pack.SILENCE_PLACEHOLDER_SECS)
        expected = 9 * 2000.0 + pack.SILENCE_PLACEHOLDER_SECS * 1000.0
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is True

    def test_missing_opus_forces_encode(self, tmp_path, stub_probe):
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        os.remove(os.path.join(audio_dir, "ch_000.opus"))
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 0, 10) is False

    def test_no_wav_dir_forces_encode(self, tmp_path, stub_probe):
        out_dir, audio_dir, expected = _mk_chapter(tmp_path, 10)
        stub_probe(expected)
        assert pack._chapter_opus_ok(out_dir, audio_dir, 7, 10) is False


class TestOldSizeCriterionWouldHaveMissedIt:
    """把"旧判据为什么失效"钉成测试, 免得以后有人觉得比大小更便宜又改回去。

    旧判据: opus_size >= (total_wav_bytes / 24) * 0.9
    但 tts/stage.py 走 sf.write(float32数组) 落盘的其实是 **16-bit PCM**(soundfile 的
    WAV 默认 subtype 是 PCM_16, 数组 dtype 不决定文件位深), 真实字节率 48000B/s,
    期望应按 /12 算。用 /24 让期望值只有真值的一半 → 实际容差是 **55%** 而不是注释里
    以为的 10%。这就是陈旧 opus 得以长期存活的机制。
    """

    def test_wav_written_by_soundfile_is_16bit_not_float32(self, tmp_path):
        """锁死这个前提: 若哪天真改成 float32 落盘, 这条会红, 提醒回来复核判据。"""
        sf = pytest.importorskip("soundfile")
        import numpy as np
        p = str(tmp_path / "a.wav")
        sf.write(p, np.zeros(SR, dtype=np.float32), SR)
        with wave.open(p) as w:
            assert w.getsampwidth() == 2, "soundfile 默认写 16-bit; 旧判据的字节率口径依赖这一点"

    def test_old_size_criterion_would_pass_a_4s_short_opus(self, tmp_path):
        """复现旧判据的失效: 一个短了 4 秒(20%)的 opus, 按旧公式仍被判"完好"。"""
        out_dir, _audio_dir, _expected = _mk_chapter(tmp_path, 10, sec_each=2.0)
        wav_dir = os.path.join(out_dir, "audio_raw", "ch000")
        total = sum(os.path.getsize(os.path.join(wav_dir, n)) for n in os.listdir(wav_dir))
        short_opus_size = int(16 * 4000)  # 只有 16s 内容 (真实 20s), 32kbps
        assert short_opus_size >= (total / 24) * 0.9, (
            "旧判据本该在这里放行 —— 这正是陈旧 opus 长期存活的机制"
        )
