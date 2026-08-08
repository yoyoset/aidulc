"""
application/dict_server.py —— 常驻词典守护 (F21, 2026-08-08)

消灭"每次查词重载 2.4GB LLM 模型"的 5-8s 冷启动: 侧车加载模型一次,
通过 stdin/stdout 服务多次查词, 直到 stdin EOF (Rust 侧空闲超时或任务启动时杀进程)。

协议 (与 Rust infrastructure/dict_daemon.rs 配对):
    每行 stdin   一个 JSON 请求 {"word": ..., "context": ...}
    每行 stdout  一个 JSON 响应 {"ok": true, "result": {...}} 或 {"ok": false, "error": ...}

模型懒加载: 第一个请求才调 LlmServer 单例加载, 不查词不占显存。
"""
from __future__ import annotations

import argparse
import json
import sys

from aidulc_prep.application.dict_lookup import lookup_word


def serve(model_path: str) -> int:
    sys.stdout.write(json.dumps({"ok": True, "ready": True}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            word = req.get("word") or ""
            ctx = req.get("context") or ""
            if not word:
                raise ValueError("缺少 word")
            result = lookup_word(model_path, word, ctx)
            sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:  # noqa: BLE001 —— 守护必须对单次失败继续服务, 不能整个进程崩
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aidulc-dict-server")
    parser.add_argument("--model", required=True, help="LLM 模型路径")
    args = parser.parse_args(argv)
    try:
        return serve(args.model)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"dict server failed: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
