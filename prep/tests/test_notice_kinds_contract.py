"""
守 "quality notice 的 kind 必须在 bookpack 契约 enum 里"。

2026-11-14 实测事故: 49741f7 给对齐器加了插值兜底, tts/stage 开始写
add_notice(..., "align_interpolated", ...), 但 contracts/bookpack.schema.json 的
notices[].kind enum 没跟着加。插值在验证数据上恰好一次没触发, 所以测试全绿;
真书跑到 pack 阶段才炸 —— TTS 全部跑完(2327 句)之后整本 "书包校验失败"。

这里静态扫描 prep 源码里所有 add_notice 的 kind 字面量, 逐个对 runtime 实际用的
schema 拷贝(aidulc_prep/schemas/)校验; contracts/ 与拷贝的一致性由 sync_schema -Verify 守。
"""
from __future__ import annotations

import json
import os
import re

PKG = os.path.join(os.path.dirname(os.path.dirname(__file__)), "aidulc_prep")

# add_notice(<chapter>, <index>, "<kind>", ...) —— kind 是第三个位置参数, 允许跨行
_CALL = re.compile(r"add_notice\(\s*[^,()]+,\s*[^,()]+,\s*\"([A-Za-z_]+)\"", re.S)


def _notice_kinds_in_source() -> set[str]:
    kinds: set[str] = set()
    for root, _dirs, files in os.walk(PKG):
        for name in files:
            if name.endswith(".py"):
                with open(os.path.join(root, name), encoding="utf-8") as f:
                    kinds.update(_CALL.findall(f.read()))
    return kinds


def _contract_kinds() -> set[str]:
    with open(os.path.join(PKG, "schemas", "bookpack.schema.json"), encoding="utf-8") as f:
        schema = json.load(f)
    notices = schema["properties"]["quality"]["properties"]["notices"]
    return set(notices["items"]["properties"]["kind"]["enum"])


def test_scanner_finds_known_call_sites():
    # 防扫描正则失效后静默变成 "空集 ⊆ 任何集合" 的假绿
    kinds = _notice_kinds_in_source()
    assert {"realign", "untranslatable", "health", "align_interpolated"} <= kinds


def test_every_notice_kind_is_in_bookpack_contract():
    missing = _notice_kinds_in_source() - _contract_kinds()
    assert not missing, (
        f"这些 notice kind 在代码里会写出, 但 bookpack.schema.json 的 enum 没有: {sorted(missing)}"
        " —— 加进 contracts/ 后跑 scripts/sync_schema.ps1"
    )
