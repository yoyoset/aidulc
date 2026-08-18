"""
core/thumbnail.py —— 封面缩略图 (纯函数, 只依赖已有的 pymupdf)

2026-08-18, 用户看完"封面很卡"的实测账之后拍板: "备料的过程加一个生成封面缩略图"。
他的判断是对的 —— 导入只登记原书(不解图), 封面是在 **pack 阶段**从源 EPUB 抽出来
落进书包的, 缩略图理应在同一步顺手做掉, 而不是等前端第一次显示时现缩。

为什么用 pymupdf 而不是 Pillow: pymupdf 已经是本项目的依赖(pdf/mobi 解析走它),
venv 里现成 1.28.2; 为缩个图再引一个图像库不值。实测确认它能直接读 png/jpeg。

为什么只按 2 的幂缩: pymupdf 的 Pixmap.shrink(n) 是"边长各除以 2^n", 没有任意比例
缩放。对缩略图够用 —— 目标是"别再把 8.95 MB / 1742x2284 的原图搬去画一个两指宽的
格子", 不是精确到像素。挑使宽度**不低于**目标宽的最大档, 宁可略大不糊。
"""
from __future__ import annotations

import os

# 与前端 core/cover_cache.js 的 THUMB_MAX_W 对齐 (卡片显示宽度的 2 倍上下, 够高分屏)
THUMB_MAX_W = 480
THUMB_NAME = "cover_thumb.jpg"
THUMB_QUALITY = 82
# 原图小于这个尺寸不值得再生成一份: 省下的传输还不够多存一个文件
SKIP_BELOW_BYTES = 80 * 1024
# 缩完至少要小到这个比例才留下。实测有两类白干的情况:
#   Hatchet   940x1400 / 386.8 KB -> shrink 0 档, 只是重编码, 384.9 KB (省 0.5%)
#   Wonder   1544x2265 / 129.5 KB -> 772 宽 jpeg82, **反而涨到 135.4 KB**
# 源图本来就是压得不错的 jpeg 时, 一次 q82 重编码换不回成本。留个更大的文件是净亏,
# 所以生成完要回头比一眼, 不达标就删掉当没做过。
KEEP_IF_RATIO_BELOW = 0.7


def shrink_factor(width: int, target: int = THUMB_MAX_W) -> int:
    """返回 Pixmap.shrink() 的档位 n (边长各除以 2^n)。

    挑**缩完仍不低于 target** 的最大档, 即 width / 2^n >= target。
    1742 -> n=1 (871); 940 -> n=0 (缩了就 470 < 480, 不缩);
    4000 -> n=3 (500)。宽本来就不到 target 时返回 0 (不缩)。
    """
    if width <= 0 or width < target * 2:
        return 0
    n = 0
    while width // (2 ** (n + 1)) >= target:
        n += 1
    return n


def should_make(path: str, target: int = THUMB_MAX_W) -> bool:
    """值不值得为这张图生成缩略图 —— 只看文件大小, 不解码。"""
    try:
        return os.path.getsize(path) >= SKIP_BELOW_BYTES
    except OSError:
        return False


def make_cover_thumb(src_path: str, out_dir: str) -> str | None:
    """生成 cover_thumb.jpg, 返回文件名; 不需要/失败返回 None。

    **任何失败都只返回 None, 不抛** —— 缩略图是纯展示优化, 不能让一本书因为封面
    缩不出来就打包失败 (同 _copy_cover / _copy_chapter_images 的"缺了就跳过"原则)。
    """
    if not should_make(src_path):
        return None
    try:
        import pymupdf
    except ImportError:
        return None  # 侧车裁剪掉了 pymupdf: 前端还有 canvas 兜底那条路
    try:
        pix = pymupdf.Pixmap(src_path)
        n = shrink_factor(pix.width)
        if n:
            pix.shrink(n)
        if pix.alpha:  # jpeg 不支持 alpha, 先去掉
            pix = pymupdf.Pixmap(pix, 0)
        if pix.colorspace is None or pix.n > 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        out = os.path.join(out_dir, THUMB_NAME)
        pix.save(out, jpg_quality=THUMB_QUALITY)
    except Exception:
        return None
    # 没缩下来就别留 —— 多一个不省事的文件是净亏 (见 KEEP_IF_RATIO_BELOW)
    try:
        if os.path.getsize(out) > os.path.getsize(src_path) * KEEP_IF_RATIO_BELOW:
            os.remove(out)
            return None
    except OSError:
        return None
    return THUMB_NAME
