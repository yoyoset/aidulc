"""
cli.py —— 唯一入口: 读 job_request.json → 跑 → 写书包 → 退出码

用法: python -m aidulc_prep.cli --job <job_request.json> --out <out_dir>
stdout 输出 NDJSON 进度行 (给 Rust 解析), run.log 记录日志。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# PyInstaller 修复 (dict-lookup 实测): 冻结环境 __file__ 定位 llama_cpp/lib 失败,
# 且 os.add_dll_directory 在冻结子进程不生效 → 把 lib + cuda_runtime 加进 PATH
# (Windows 加载 DLL 依赖时查 PATH, llama.dll → ggml-cuda.dll → cudart 链)。
if getattr(sys, "frozen", False):
    _meipass = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for _sub in ("llama_cpp", "lib"), ("cuda_runtime",):
        _p = os.path.join(_meipass, *_sub)
        if os.path.isdir(_p):
            os.environ["PATH"] = _p + os.pathsep + os.environ.get("PATH", "")
            try:
                os.add_dll_directory(_p)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    # 编码修复 (真实书含 © 等字符, Windows GBK stdout 会崩): 一律 UTF-8 输出
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    parser = argparse.ArgumentParser(prog="aidulc-prep")
    parser.add_argument("--job", help="job_request.json 路径")
    parser.add_argument("--out", help="书包输出目录")
    # 词典 LLM 补全模式 (打包 exe 单入口: 无 --job 时走 lookup)
    parser.add_argument("--lookup-model", help="LLM 模型路径 (词典补全)")
    parser.add_argument("--lookup-word", help="查询单词 (词典补全)")
    parser.add_argument("--lookup-context", default="", help="句子上下文 (词典补全, 可选)")
    # 常驻词典守护 (F21, 2026-08-08): 加载模型一次, stdin/stdout 服务多次查词
    parser.add_argument("--lookup-server", action="store_true", help="常驻词典守护模式")
    # 常驻语音守护 (K29, 2026-08-14): 生词本发音跟正文朗读同一引擎 + 预热, 不再每次冷启动
    parser.add_argument("--tts-server", action="store_true", help="常驻语音合成守护模式")
    parser.add_argument("--tts-model", help="TTS 模型路径 (配合 --tts-server)")
    parser.add_argument("--tts-language", default="en", help="TTS 语言 (配合 --tts-server)")
    # 原版书预览模式 (书库"查看原文")
    parser.add_argument("--preview-book", help="原版书路径 (EPUB/TXT/PDF → 纯文本预览)")
    # 源书体检 (STDIMPORT, 2026-08-16): 导入时把关 + 手动体检脚本共用, 输出 JSON 到 stdout
    parser.add_argument("--audit-book", help="源书路径 (EPUB), 输出 S1-S6 体检结果 JSON")

    parser.add_argument(
        "--standardize-book",
        help="源书路径 (EPUB), 原生解析判 block 后的自动标准化转换: pymupdf 兜底重解析, "
        "配合 --out 写报告 JSON (含判定结果 + 转换后的章节/句子, 供 --out 存档路径复用)",
    )
    # 组件健康探测 (R3.4): 输出 PyMuPDF 版本号或 "none", Rust components_health 解析
    parser.add_argument("--pymupdf-version", action="store_true", help="探测 PyMuPDF 是否可用")
    # K12 (2026-08-14): 只补封面, 不重跑整条流水线 (老 edition 没有封面时的轻量入口,
    # 见 docs/ROADMAP.md 成熟度审计"书库/封面"域记录的缺口)。
    parser.add_argument("--backfill-cover-book", help="源书路径 (EPUB), 配合 --backfill-cover-pack 用")
    parser.add_argument("--backfill-cover-pack", help="已存在的书包目录 (含 bookpack.json)")
    args = parser.parse_args(argv)

    # 词典补全模式 (M 系列: 实现归位 application/dict_lookup)
    if args.lookup_word:
        from aidulc_prep.application.dict_lookup import main as lookup_main
        return lookup_main(["--model", args.lookup_model or "", "--word", args.lookup_word, "--context", args.lookup_context])

    # 常驻词典守护 (F21, 2026-08-08): 一次加载, stdin/stdout 多次查询
    if args.lookup_server:
        from aidulc_prep.application.dict_server import main as dict_server_main
        return dict_server_main(["--model", args.lookup_model or ""])

    # 常驻语音守护 (K29, 2026-08-14): 一次加载, stdin/stdout 多次合成
    if args.tts_server:
        from aidulc_prep.application.tts_server import main as tts_server_main
        return tts_server_main(["--model", args.tts_model or "", "--language", args.tts_language])

    # PyMuPDF 探测 (R3.4): 只输出版本号或 "none", 供 Rust 组件健康检查
    if args.pymupdf_version:
        try:
            import pymupdf
            ver = getattr(pymupdf, "__version__", "") or ""
            sys.stdout.write(ver.strip() + "\n")
        except ImportError:
            sys.stdout.write("none\n")
        return 0

    # 源书体检 (STDIMPORT, 2026-08-16): 导入时把关 + 手动体检脚本共用, 输出 JSON 到 stdout
    if args.audit_book:
        from aidulc_prep.application.book_audit import evaluate_book
        sys.stdout.write(json.dumps(evaluate_book(args.audit_book), ensure_ascii=False) + "\n")
        return 0

    # 自动标准化转换 (2026-08-19, 用户拍板"不符合标准的自动转换, 不用设置, 能看结果"):
    # 只在原生解析(--audit-book)判 block 之后, Rust 后台任务才会调这个模式。
    # 写文件而不是像 --audit-book 那样只吐 stdout —— 结果要作为缓存被
    # runner.py::_parse() 复用(备料阶段直接读, 不重新解析一遍), 需要落盘存档。
    if args.standardize_book:
        if not args.out:
            sys.stderr.write("--standardize-book 需要配合 --out 指定报告输出路径\n")
            return 2
        from aidulc_prep.application.book_audit import _judge_book
        from aidulc_prep.pipeline.loader.epub_fallback import load_epub_fallback

        book, uncovered = load_epub_fallback(args.standardize_book)
        result = _judge_book(args.standardize_book, book, uncovered)
        # verdict=block 时不塞一份"反正也不达标"的半成品章节结构进去——那样容易让
        # 下游误以为有可用缓存。book 字段只在 ok/warn 时非空。
        result["book"] = (
            {
                "title": book.title,
                "chapters": [
                    {"title": c.title, "sentences": [s.original_text for s in c.sentences]}
                    for c in book.chapters
                ],
            }
            if result["verdict"] != "block"
            else None
        )
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        return 0

    # 原版书预览模式 (书库"查看原文" + 处理前体检 R3.3: 格式/目录来源/章节异常信号)
    if args.preview_book:
        from aidulc_prep.pipeline.loader import load_book
        from aidulc_prep.pipeline.loader.epub import (
            load_epub_with_spine_health,
            probe_toc_source,
        )
        from aidulc_prep.core.health import detect_anomalies
        import os as _os
        path = args.preview_book
        ext = _os.path.splitext(path)[1].lower()
        try:
            if ext == ".epub":
                # F39: 体检需要 spine 覆盖率 (有文件没被任何章节覆盖 → F38 类问题),
                # load_book 拿不到 → 走带覆盖信息的入口
                book, uncovered = load_epub_with_spine_health(path)
                toc_source = probe_toc_source(path)
            else:
                book = load_book(path)
                uncovered = []
                toc_source = "n/a"
        except Exception as e:
            sys.stderr.write(f"preview failed: {e}\n")
            return 1
        # 处理前体检: 格式 + 目录来源 + 每章句数分布 + 异常信号
        # (F39 2026-08-10: 异常检测抽成纯函数 detect_anomalies, 新增 spine 覆盖率 +
        # 句数离群两条, 0/1/>1000 保留)
        health: dict = {
            "format": ext,
            "chapter_count": len(book.chapters),
            "sentence_counts": [len(ch.sentences) for ch in book.chapters],
            "toc_source": toc_source,
            "uncovered_files": uncovered,
            "anomalies": detect_anomalies(
                [len(ch.sentences) for ch in book.chapters], uncovered
            ),
        }
        out = {
            "title": book.title,
            "health": health,
            "chapters": [
                {"index": ch.index, "title": ch.title,
                 "sentences": [s.original_text for s in ch.sentences]}
                for ch in book.chapters
            ],
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        return 0

    # K12 (2026-08-14): 补封面模式——只跑"从源 EPUB 抽封面 → 拷进已有书包根 →
    # 回写 bookpack.json 顶层 cover 字段", 不碰其它已生成资产(译文/音频/讲解)。
    if args.backfill_cover_book and args.backfill_cover_pack:
        from aidulc_prep.pipeline.loader.epub import load_epub
        from aidulc_prep.pipeline.pack import _copy_cover
        bp_path = os.path.join(args.backfill_cover_pack, "bookpack.json")
        try:
            with open(bp_path, encoding="utf-8") as f:
                bp = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            sys.stderr.write(f"读书包失败: {e}\n")
            return 1
        try:
            book = load_epub(args.backfill_cover_book)
        except Exception as e:
            sys.stderr.write(f"解析源书失败: {e}\n")
            return 1
        cover_file = _copy_cover(book, args.backfill_cover_pack, args.backfill_cover_book)
        if not cover_file:
            sys.stdout.write(json.dumps({"cover": None}, ensure_ascii=False) + "\n")
            return 0
        bp["cover"] = cover_file
        from aidulc_prep.pipeline.pack import _atomic_write_json
        _atomic_write_json(bp_path, bp)
        sys.stdout.write(json.dumps({"cover": cover_file}, ensure_ascii=False) + "\n")
        return 0

    if not args.job or not args.out:
        parser.error("需要 --job + --out (或 --lookup-word 走词典补全)")

    with open(args.job, encoding="utf-8") as f:
        job = json.load(f)

    # NDJSON 进度 → stdout (Rust 解析); 日志 → run.log
    def emit(event: dict):
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    from aidulc_prep.core.schema import validate_job_request
    errs = validate_job_request(job)
    if errs:
        emit({"type": "error", "ts": 0, "message": "任务快照不合法", "detail": "; ".join(errs)})
        return 2

    from aidulc_prep.pipeline.runner import Runner
    runner = Runner(job, args.out, emit=emit)
    try:
        runner.run()
        return 0
    except Exception as e:
        emit({"type": "error", "ts": 0, "message": str(e), "detail": repr(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
