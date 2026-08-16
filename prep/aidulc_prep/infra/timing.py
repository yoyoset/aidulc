"""infra/timing.py —— 性能探针: 统一的 TIMING 日志行格式化, 纯函数方便单测。

2026-08-15 用户反馈"太慢了"(实测 Wonder 一书 7357 句跑了约 10.5 小时) —— pipeline
完全没有分阶段计时数据, 只能凭代码结构猜瓶颈(比如 explain 逐句调用 LLM, 而
translate 是 15 句/批, 调用次数差 15 倍)。CLAUDE.md 的规矩是先实测再下结论, 不能
凭直觉先动大手术——这里先加探针拿到每次真实模型调用的耗时, 跑完一本书后
`grep "^TIMING stage=explain" run.log` 之类的命令就能自己算出各阶段的调用次数/
总耗时/平均耗时, 不需要额外写聚合代码(先看数据分布长什么样, 再决定要不要为某个
阶段专门写统计/优化)。
"""
from __future__ import annotations


def format_timing_line(stage: str, elapsed: float, **fields) -> str:
    """构造一行 TIMING 日志。固定 `TIMING stage=<stage> k=v ... elapsed=<n>s` 格式,
    每次真正调用模型(LLM complete_fn / TTS engine.synth)前后各打一个时间戳时用这个
    格式化, 方便事后用 grep/awk 按 stage 分组分析, 不用改代码去解析结构化日志。"""
    parts = [f"stage={stage}"]
    for k, v in fields.items():
        parts.append(f"{k}={v}")
    parts.append(f"elapsed={elapsed:.3f}s")
    return "TIMING " + " ".join(parts)
