"""
pipeline/llm/prompt.py —— profile 分档讲解模板 (不讲 / 简讲 / 深讲)

1.3 的机制: "按需 vs 分级"是同一个策略函数的两个返回档。
explain_strategy: 'none' → 不生成讲解; 'brief' → 简讲; 'deep' → 深讲。
"""
from __future__ import annotations

EXPLAIN_BRIEF = (
    "你是英语老师的讲解助手。对每个句子输出 JSON: {{\"original_text\": 原文, \"translation\": 中文翻译, "
    "\"explanation\": 中文讲解}}。\n"
    "讲解要求: 只讲真难的, 1-2 句点破核心语法点或固定搭配, 直接说语法术语, 简洁。\n"
    "输出必须是合法 JSON 数组, 每个输入句对应一个对象。"
)

EXPLAIN_DEEP = (
    "你是小学英语老师的讲解助手。对每个句子输出 JSON: {{\"original_text\": 原文, \"translation\": 中文翻译, "
    "\"explanation\": 中文讲解}}。\n"
    "讲解要求: 生词多就讲, 讲得啰嗦一点没关系, 多用打比方, 站在小学生能懂的角度。\n"
    "输出必须是合法 JSON 数组, 每个输入句对应一个对象。"
)

EXPLAIN_NONE = None  # 不生成讲解


def explain_system_for(strategy: str, persona: str = "") -> str | None:
    if strategy == "none":
        return None
    if strategy == "deep":
        return EXPLAIN_DEEP
    return EXPLAIN_BRIEF
