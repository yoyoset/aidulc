"""pack 阶段回归测试: opus 复用判定 (float32 wav 字节率口径 + 孤儿文件检测)"""
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

    assert _chapter_opus_ok(out, audio_dir, 0, 1), "4000B opus 对应 96000B float32 wav 应判完整可复用"


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

    assert not _chapter_opus_ok(out, audio_dir, 0, 1), "半截 opus 不得判完整"


def test_chapter_opus_ok_rejects_orphan_wav_beyond_current_sentence_count(tmp_path):
    """2026-08-19 (用户报"TTS 错位, 读了章节标题"追出的第二个 bug): 章节被重新解析后
    句数变少(今天的分词修复合并/裁掉了尾部几句), 磁盘上残留旧版本多出来的孤儿 wav。

    实测 Number the Stars: 全书 19 章磁盘上都比当前句数多 3~12 个孤儿文件, 孤儿字节量
    只占该章总量 ~2%, 远低于 10% 容差——纯按字节比例这条判据完全测不出来, opus 停留
    在旧版本, 跟当天已经改过的句子结构和时间戳完全对不上。

    这里构造同样的结构: 当前句数=2(索引 0,1), 磁盘上多一个孤儿 s00002.wav(旧版本
    第 3 句留下的)——孤儿字节量刻意设得很小, 让"总字节比例"这条判据单独看会通过,
    专门验证孤儿检测不依赖字节比例、必须硬性拦截。"""
    out = str(tmp_path)
    wav_dir = os.path.join(out, "audio_raw", "ch000")
    os.makedirs(wav_dir)
    with open(os.path.join(wav_dir, "s00000.wav"), "wb") as f:
        f.write(b"\x00" * 96000)
    with open(os.path.join(wav_dir, "s00001.wav"), "wb") as f:
        f.write(b"\x00" * 96000)
    # 孤儿: 索引 2, 当前句数只有 2(有效索引 0,1)。字节量很小(1000B), 加进总量后
    # 比例仍然接近 100%(远超 90% 门槛)——证明孤儿检测不能靠字节比例侧漏检测到。
    with open(os.path.join(wav_dir, "s00002.wav"), "wb") as f:
        f.write(b"\x00" * 1000)

    audio_dir = os.path.join(out, "audio")
    os.makedirs(audio_dir)
    opus_path = os.path.join(audio_dir, "ch_000.opus")
    # opus 大小是拿"含孤儿"的旧总量算的, 字节比例这条单独看会判"完整"
    with open(opus_path, "wb") as f:
        f.write(b"\x00" * 8125)  # (96000*2+1000)/24 = 8125

    assert not _chapter_opus_ok(out, audio_dir, 0, 2), (
        "存在索引 >= 当前句数(2)的孤儿 wav(s00002), 必须强制重编, "
        "不能因为字节比例侥幸通过就跳过"
    )


def test_chapter_opus_ok_accepts_sil_suffix_orphan(tmp_path):
    """孤儿文件名可能带 _sil 后缀(静音占位句), 索引解析要认得这种命名。"""
    out = str(tmp_path)
    wav_dir = os.path.join(out, "audio_raw", "ch000")
    os.makedirs(wav_dir)
    with open(os.path.join(wav_dir, "s00000.wav"), "wb") as f:
        f.write(b"\x00" * 96000)
    with open(os.path.join(wav_dir, "s00001_sil.wav"), "wb") as f:
        f.write(b"\x00" * 1000)  # 孤儿, 索引 1, 当前句数只有 1(有效索引 0)

    audio_dir = os.path.join(out, "audio")
    os.makedirs(audio_dir)
    opus_path = os.path.join(audio_dir, "ch_000.opus")
    with open(opus_path, "wb") as f:
        f.write(b"\x00" * 4041)

    assert not _chapter_opus_ok(out, audio_dir, 0, 1), "_sil 后缀的孤儿也要被识别拦截"


def test_chapter_opus_ok_no_false_positive_when_wav_set_matches_current(tmp_path):
    """对照组: 磁盘上的 wav 正好等于当前句数(没有孤儿), 不能被新加的孤儿检测误伤。"""
    out = str(tmp_path)
    wav_dir = os.path.join(out, "audio_raw", "ch000")
    os.makedirs(wav_dir)
    with open(os.path.join(wav_dir, "s00000.wav"), "wb") as f:
        f.write(b"\x00" * 96000)
    with open(os.path.join(wav_dir, "s00001.wav"), "wb") as f:
        f.write(b"\x00" * 96000)

    audio_dir = os.path.join(out, "audio")
    os.makedirs(audio_dir)
    opus_path = os.path.join(audio_dir, "ch_000.opus")
    with open(opus_path, "wb") as f:
        f.write(b"\x00" * 8000)  # 96000*2/24 = 8000

    assert _chapter_opus_ok(out, audio_dir, 0, 2), "wav 集合正好匹配当前句数时不该被误伤"
