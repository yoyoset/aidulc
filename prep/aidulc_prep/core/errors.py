"""
core/errors.py —— AidulcError 层次 (对标 comic-gen core/errors.py)

每类同时携带人话摘要 (给用户) 和技术细节 (进 run.log)。
format_job_failure 供 Rust UI 和 Python CLI 共用一份措辞。
"""
from __future__ import annotations


class AidulcError(Exception):
    """基类。所有错误都同时携带 human (人话) 与 detail (技术细节)。"""

    def __init__(self, human: str, detail: str = "", *, cause: Exception | None = None):
        super().__init__(detail or human)
        self.human = human
        self.detail = detail
        self.cause = cause

    def __str__(self) -> str:
        return self.human


class ModelError(AidulcError):
    """权重缺失 / 大小不符 / 加载失败"""


class InputError(AidulcError):
    """书解析失败 / 加密 EPUB / 格式不支持"""


class EngineError(AidulcError):
    """llama-server 起不来 / 端口占用 / 推理失败"""


class OutputError(AidulcError):
    """磁盘满 / 路径被占 / 写书包失败"""


class SyncError(AidulcError):
    """CF 推拉失败"""


def format_job_failure(err: AidulcError) -> str:
    """Rust UI 与 Python CLI 共用的一份人话摘要。"""
    if isinstance(err, ModelError):
        return f"模型问题: {err.human}"
    if isinstance(err, InputError):
        return f"书有问题: {err.human}"
    if isinstance(err, EngineError):
        return f"引擎问题: {err.human}"
    if isinstance(err, OutputError):
        return f"输出问题: {err.human}"
    return f"任务失败: {err.human}"
