"""
pipeline/llm/json_util.py —— LLM 输出 JSON 清理 (M 系列: 单一实现)

历史: llm/stage.py 的 _clean_json_content 与 dict_lookup.py 的围栏剥离重复。
本模块是唯一实现, 两边引用。
"""
from __future__ import annotations

import re


def clean_json_content(content: str) -> str:
    """剥 ```json 围栏, 截断修复 (括号配平, 给 json.loads 用)。"""
    c = content.strip()
    c = re.sub(r"^```(?:json)?\s*", "", c)
    c = re.sub(r"\s*```$", "", c)
    return c
