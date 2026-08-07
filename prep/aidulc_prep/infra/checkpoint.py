"""
infra/checkpoint.py —— 中间产物读写 + 断点判定 (3.2 中断语义)

G2 修复 (审查确认):
1. 失败结果不再写入阶段字段 (旧实现: 翻译失败存原文/讲解失败存空串/静音占位存 audio,
   被 is_done_sentence 误判为完成 → 重试失败句失效)。
2. 原子写入: 先写临时文件再 rename, 崩溃不产生半截 JSON。
3. 阶段完成判定 = 该 stage 字段存在且 status 不是 failed/partial。
"""
from __future__ import annotations

import json
import os
import tempfile


def sentence_path(out_dir: str, chapter: int, index: int) -> str:
    return os.path.join(out_dir, "checkpoints", f"ch{chapter:03d}", f"s{index:05d}.json")


def load_sentence(out_dir: str, chapter: int, index: int) -> dict | None:
    p = sentence_path(out_dir, chapter, index)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None  # 损坏 checkpoint 视为未完成 (重跑)


def _atomic_write_json(out_dir: str, chapter: int, index: int, data: dict) -> None:
    """把 data 原样(不合并)原子写入该句 checkpoint。save_sentence/overwrite_sentence 共用。"""
    p = sentence_path(out_dir, chapter, index)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)  # 原子替换
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_sentence(out_dir: str, chapter: int, index: int, data: dict) -> None:
    """把 data 合并进该句 checkpoint (原子写入: tmp + rename)。

    合并语义: 只更新 data 里出现的键, 不出现的键保留磁盘原值——translate/explain/tts/align
    各阶段各自只关心自己的字段, 都依赖这个语义互不覆盖对方已写的结果。
    **想整体替换(丢弃磁盘上未出现在 data 里的旧字段)用 overwrite_sentence, 不要指望
    "先清空调用方内存里的 dict 再传进来"能生效——这里的 update() 是和磁盘上的旧内容合并,
    不是和调用方清空后的字典合并, 2026-08-07 写位置对齐修复时踩过这个坑, 已用真实
    roundtrip 测试复现确认。**
    """
    existing = load_sentence(out_dir, chapter, index) or {}
    existing.update(data)
    _atomic_write_json(out_dir, chapter, index, existing)


def overwrite_sentence(out_dir: str, chapter: int, index: int, data: dict) -> None:
    """整句 checkpoint 整体替换(不与磁盘旧内容合并), 原子写入。

    用于"确认磁盘上这个位置的旧数据不再有效, 必须整体丢弃"的场景(如 nlp 阶段的位置
    对齐冲突修复, 见 pipeline/nlp/stage.py::reconcile_position_checkpoint)——不能用
    save_sentence, 它的合并语义会让调用方"清空"的意图落空。
    """
    _atomic_write_json(out_dir, chapter, index, data)


def is_done_sentence(out_dir: str, chapter: int, index: int, stage: str) -> bool:
    """该句该阶段是否已完成。
    语义 (审查确认后统一):
    - 阶段字段存在且值非空 → 该阶段完成 (不管整句 partial)
    - partial 句: translation 完成则翻译不重跑, 但 tts/align 未完成仍会重跑
    - 只有该阶段显式失败 (字段为 None) 才判未完成
    """
    data = load_sentence(out_dir, chapter, index)
    if not data:
        return False
    val = data.get(stage)
    if val is None:
        return False
    if isinstance(val, str):
        return val.strip() != ""
    if isinstance(val, dict):
        return bool(val)
    return True


def save_stage_result(out_dir: str, chapter: int, index: int, stage: str, value, status: str = "ok") -> None:
    """把某阶段结果写进句 checkpoint (原子)。

    失败语义 (审查确认后统一, 与 core/models.py 一致):
    - translate/nlp 失败 → status=failed (句子无可用内容)
    - explain/tts/align 失败 → status=partial (句子仍有译文可读), 可重试
    - 失败阶段字段写 None → is_done_sentence 判未完成 → 重跑不跳过
    """
    # M 系列: 规则来自 core.models.FATAL_STAGES (单一事实源)
    from aidulc_prep.core.models import FATAL_STAGES
    data = load_sentence(out_dir, chapter, index) or {}
    if status == "ok":
        data[stage] = value
        # 只有 fatal 阶段失败才粘 failed; 其它失败后成功可恢复为 ok
        if data.get("status") != "failed":
            data["status"] = "ok"
    else:
        data[stage] = None
        if stage in FATAL_STAGES:
            data["status"] = "failed"
        else:
            data["status"] = "partial"
        data.setdefault("failedStages", [])
        if stage not in data["failedStages"]:
            data["failedStages"].append(stage)
    save_sentence(out_dir, chapter, index, data)
