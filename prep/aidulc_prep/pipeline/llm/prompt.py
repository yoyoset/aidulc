"""
pipeline/llm/prompt.py —— profile 分档讲解模板 (不讲 / 简讲 / 深讲)

1.3 的机制: "按需 vs 分级"是同一个策略函数的两个返回档。
explain_strategy: 'none' → 不生成讲解; 'brief' → 简讲; 'deep' → 深讲。

K33 (2026-08-16, 用户实测反馈"讲解字数是不是有点过分"后拍板"分档不够, 要能调字数和
触发门槛"): 之前 EXPLAIN_DEEP 写的是"讲得啰嗦一点没关系", 模型照做——实测 Wonder
一书讲解中位数 512 字符(原文的 10.7 倍), 逐句人工核对内容构成发现约 93% 是开场白/
复述常识/总结陈词/记忆口诀, 真正解释英语的部分只占约 7%。这次改动两件事:
  1. 提示词本身去掉"啰嗦"这类无约束描述, 换成明确禁止这几类跑题内容。
  2. explain_system_for 新增 max_chars 参数, 由 profile.explain_max_chars 传入,
     动态拼一条字数上限指令(不再是提示词里的固定文案)。
"""
from __future__ import annotations

EXPLAIN_BRIEF = (
    "你是英语老师的讲解助手。对每个句子输出 JSON: {{\"original_text\": 原文, \"translation\": 中文翻译, "
    "\"explanation\": 中文讲解}}。\n"
    "讲解要求: 只讲真难的, 直接点破核心语法点或固定搭配, 直接说语法术语。\n"
    "只解释这句话里查词典查不出来的东西(生词含义/固定搭配/句子结构)——不写开场白、"
    "不复述读者已经知道的常识、不写总结句、不编记忆口诀。\n"
    "输出必须是合法 JSON 数组, 每个输入句对应一个对象。"
)

EXPLAIN_DEEP = (
    "你是小学英语老师的讲解助手。对每个句子输出 JSON: {{\"original_text\": 原文, \"translation\": 中文翻译, "
    "\"explanation\": 中文讲解}}。\n"
    "讲解要求: 生词多就讲, 可以打比方帮孩子理解, 站在小学生能懂的角度——但只解释这句话里"
    "查词典查不出来的东西(生词含义/固定搭配/句子结构)。不写开场白(比如\"好呀我们来想象一下\")、"
    "不解释孩子本来就懂的常识(比如不用解释\"什么是风\")、不写总结句、不编记忆口诀。\n"
    "输出必须是合法 JSON 数组, 每个输入句对应一个对象。"
)

EXPLAIN_NONE = None  # 不生成讲解


def explain_system_for(strategy: str, persona: str = "", max_chars: int | None = None) -> str | None:
    """max_chars: profile.explain_max_chars, 拼进提示词做明确字数约束
    (None/0 = 不额外约束, 兼容旧行为)。"""
    if strategy == "none":
        return None
    base = EXPLAIN_DEEP if strategy == "deep" else EXPLAIN_BRIEF
    if max_chars:
        base = f"{base}\n讲解总字数控制在 {max_chars} 字以内, 只讲最关键的一两点, 不要展开背景或举例说明整个场景。"
    return base
