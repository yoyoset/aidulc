"""
application/dict_lookup.py —— 单词词义 LLM 补全 (M 系列: 从包根目录归位)

独立子命令 (cli.py 转发): --lookup-model <path> --lookup-word <w> --lookup-context <ctx>
stdout 输出一行 JSON: {word, pos, phonetic, meanings, examples}
失败: 退出码非 0 + stderr 可读原因。

设计: 复用 LlmServer 单例 (llama_cpp_python 进程内推理), prompt 简短 (max_tokens 小),
单词查询 ~1-2s。Rust 侧 word_lookup 未命中本地词典时 spawn 此命令, 超时兜底占位。
"""
from __future__ import annotations

import argparse
import json
import sys

from aidulc_prep.pipeline.llm.json_util import clean_json_content

SYSTEM_PROMPT = (
    "你是英语词典。对给定单词输出 JSON(不要任何其它文本), 格式:\n"
    '{"pos": "词性缩写如 NOUN/VERB/ADJ", "phonetic": "IPA音标如 /bæŋk/", '
    '"meanings": ["中文释义1", "中文释义2"], '
    '"examples": ["英文例句1"], '
    '"example_zh": ["例句1的中文翻译"], '
    '"usage": "一句话用法说明(何时用、常用搭配)", '
    '"phrases": ["常见搭配/短语1"]}\n'
    "要求: 释义简洁准确; 例句贴合给出的上下文; "
    "example_zh 与 examples 一一对应; usage 给学习者的实用说明(1 句中文); "
    "phrases 给 1-3 个常见搭配。"
)


def get_server(model_path: str):
    """包装: 延迟 import LlmServer (测试可 monkeypatch 本模块函数)。"""
    from aidulc_prep.pipeline.llm.server import get_server as _gs
    return _gs(model_path)


def lookup_word(model_path: str, word: str, context: str) -> dict:
    ctx = context.strip()[:200]
    user = f"word: {word}"
    if ctx:
        user += f"\ncontext: {ctx}"
    server = get_server(model_path)
    raw = server.complete(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
        temperature=0.1,
        max_tokens=200,
    )
    # M 系列: 围栏剥离单一实现 (llm/json_util)
    data = json.loads(clean_json_content(raw))
    return {
        "word": word,
        "pos": str(data.get("pos", "")),
        "phonetic": str(data.get("phonetic", "")),
        "meanings": [str(m) for m in data.get("meanings", [])],
        "examples": [str(e) for e in data.get("examples", [])],
        "example_zh": [str(e) for e in data.get("example_zh", [])],
        "usage": str(data.get("usage", "")),
        "phrases": [str(p) for p in data.get("phrases", [])],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aidulc-dict-lookup")
    parser.add_argument("--model", required=True, help="LLM 模型路径")
    parser.add_argument("--word", required=True, help="查询单词")
    parser.add_argument("--context", default="", help="句子上下文(可选)")
    args = parser.parse_args(argv)

    try:
        result = lookup_word(args.model, args.word, args.context)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0
    except Exception as e:
        sys.stderr.write(f"dict lookup failed: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
