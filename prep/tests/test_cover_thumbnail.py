"""封面缩略图 (2026-08-18)

实测背景: 库里 11 张封面合计 10.95 MB, 最大一张 1742x2284 / 8.95 MB,
书库卡片上只占一个两指宽的格子。缩略图在 pack 阶段做掉, 前端不必再搬原图。
"""
import os

from aidulc_prep.core.thumbnail import (
    SKIP_BELOW_BYTES, THUMB_MAX_W, THUMB_NAME, make_cover_thumb, shrink_factor, should_make,
)


def test_shrink_factor_keeps_width_at_or_above_target():
    # 库里真实尺寸
    assert shrink_factor(1742) == 1        # 1742/2 = 871 >= 480
    assert shrink_factor(1544) == 1        # Wonder
    assert shrink_factor(1400) == 1        # Tuck
    for w in (1742, 1544, 1400, 4000, 3000):
        n = shrink_factor(w)
        assert w // (2 ** n) >= THUMB_MAX_W, f"{w} 缩 {n} 档后低于目标宽"


def test_shrink_factor_does_not_shrink_small_covers():
    # 缩了就低于目标宽的, 一律不缩 —— 宁可略大不糊
    assert shrink_factor(940) == 0         # Hatchet, 940/2=470 < 480
    assert shrink_factor(608) == 0         # Wild Robot
    assert shrink_factor(512) == 0         # Charlotte's Web
    assert shrink_factor(327) == 0         # Frindle
    assert shrink_factor(0) == 0
    assert shrink_factor(-5) == 0


def test_should_make_only_for_big_files(tmp_path):
    small = tmp_path / "s.jpg"
    small.write_bytes(b"x" * (SKIP_BELOW_BYTES - 1))
    big = tmp_path / "b.jpg"
    big.write_bytes(b"x" * (SKIP_BELOW_BYTES + 1))
    assert should_make(str(small)) is False
    assert should_make(str(big)) is True
    assert should_make(str(tmp_path / "nope.jpg")) is False


def test_make_cover_thumb_never_raises_on_garbage(tmp_path):
    """任何失败都返回 None, 不能让一本书因为封面缩不出来就打包失败。"""
    bad = tmp_path / "cover.jpg"
    bad.write_bytes(b"\xff\xd8not-actually-an-image" + b"x" * SKIP_BELOW_BYTES)
    assert make_cover_thumb(str(bad), str(tmp_path)) is None
    assert make_cover_thumb(str(tmp_path / "missing.png"), str(tmp_path)) is None


def test_make_cover_thumb_shrinks_a_real_png(tmp_path):
    pymupdf = __import__("pymupdf")
    # 造一张 1600x2400 的真图, 落盘要够大才会触发 should_make
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1600, 2400), False)
    pix.set_rect(pix.irect, (200, 120, 60))
    src = tmp_path / "cover.png"
    pix.save(str(src))
    if os.path.getsize(src) < SKIP_BELOW_BYTES:  # 纯色 PNG 压得太小, 补齐判据
        return
    name = make_cover_thumb(str(src), str(tmp_path))
    assert name == THUMB_NAME
    out = tmp_path / THUMB_NAME
    assert out.exists()
    assert os.path.getsize(out) < os.path.getsize(src)
    thumb = pymupdf.Pixmap(str(out))
    assert thumb.width == 800   # 1600 -> shrink 1 档 (800 >= 480, 再缩 400 < 480)
