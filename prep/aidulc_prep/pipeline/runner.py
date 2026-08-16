"""
pipeline/runner.py —— 编排 + 逐句 try + 每句落盘 + 协作式取消

阶段序: parse(loader) → nlp → translate → explain → tts → align → pack
中断语义: 取消和意外中断效果相同, 已完成中间产物保留, 重跑自动续上 (靠 checkpoint 文件)。
"""
from __future__ import annotations

import logging
import os
import time

from aidulc_prep.core.errors import AidulcError, EngineError, InputError, OutputError
from aidulc_prep.core.models import Book
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.pipeline.loader import load_book


class Runner:
    def __init__(self, job: dict, out_dir: str, emit=None, cancel=None):
        """
        job: job_request.json 的 dict (不可变快照)
        out_dir: 书包输出目录
        emit: 进度回调 emit(event: dict) (NDJSON 行, 见 progress.schema.json)
        cancel: 返回 True 表示要取消
        """
        self.job = job
        self.out_dir = out_dir
        self.emit = emit or (lambda e: None)
        self.cancel = cancel or (lambda: False)
        self.quality = QualityReport()
        # Bug fix (2026-08-13, 审计): explain 的"首次运行欠账检测"用 `not exists(checkpoints)`
        # 判 first_run, 但 nlp 阶段先跑、已建 checkpoints/ 目录 → 恒 False, 检测是死代码
        # (历史上它抓过 2518 句漏跑的根因场景)。改成在 __init__ 阶段(任何 stage 落盘前)算好。
        self._first_run = not os.path.exists(os.path.join(out_dir, "checkpoints"))
        self._setup_file_logging()

    def _setup_file_logging(self):
        """M7 R26: run.log 兑现 —— 注释承诺"日志→run.log"但从未配置 logging, 实际从不写。
        配 FileHandler 到 out_dir/run.log (挂在 aidulc logger 下, 不污染 root),
        任务失败诊断从此有原始堆栈可查 (Rust job_detail 也读它)。"""
        try:
            os.makedirs(self.out_dir, exist_ok=True)
            log_path = os.path.join(self.out_dir, "run.log")
            handler = logging.FileHandler(log_path, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
            logger = logging.getLogger("aidulc")
            logger.setLevel(logging.INFO)
            # 防重复挂 (同进程多任务复用时不叠 handler)
            if not any(getattr(h, "baseFilename", "") == log_path for h in logger.handlers):
                logger.addHandler(handler)
        except OSError:
            pass

    def run(self) -> Book:
        t0 = time.time()
        self._apply_force_stages()
        try:
            book = self._run_pipeline()
            self._tts_pack(book)
        except AidulcError as e:
            # 覆盖 EngineError/ModelError/InputError/OutputError 全部领域错误 —— 之前只拦
            # EngineError, 模型缺失(ModelError)/书坏(InputError)/ffmpeg 缺(OutputError) 会掉进
            # 裸 Exception, 不写 quality_report → Rust 侧显示"无详情报告" (审查发现)。
            logging.getLogger("aidulc").exception("任务失败: %s", e.human)
            self.emit({"type": "error", "ts": int(time.time() * 1000), "message": e.human, "detail": e.detail})
            # I-C: 失败可读 —— 异常路径也落盘 quality_report (含 error 摘要),
            # Rust 侧 quality_summary 读它填充 jobs.error (否则只显示"无详情报告")
            self._write_quality_report(error=e.human, detail=e.detail)
            raise
        except Exception:
            logging.getLogger("aidulc").exception("任务意外失败")
            raise
        elapsed = time.time() - t0
        # I-C: 失败可读 —— 质量报告落盘, Rust 侧读它填充 jobs.error
        self._write_quality_report()
        self.emit({"type": "job_done", "ts": int(time.time() * 1000), "exit_code": 0, "message": f"完成, 耗时 {elapsed:.0f}s"})
        return book

    def _apply_force_stages(self):
        """手动重跑 (2026-08-13): job_request.force_stages 列出的阶段 → 清 checkpoint 强制重跑。
        前端"重跑…"对话框选了重跑范围后写进 job_request, 这里在跑任何阶段前清掉对应字段,
        使 is_done_sentence 判未完成 → 只重跑这些阶段 (含下游级联), 已完成的其它阶段不动。"""
        stages = self.job.get("force_stages") or []
        if not stages:
            return
        from aidulc_prep.infra.checkpoint import clear_stages
        n = clear_stages(self.out_dir, [str(s) for s in stages])
        if n:
            logging.getLogger("aidulc").info(
                "手动重跑: 清除 %d 句的 %s 阶段 checkpoint, 强制重跑",
                n, ", ".join(str(s) for s in stages),
            )

    def _write_quality_report(self, error: str | None = None, detail: str = ""):
        """把 QualityReport 写成 JSON (Rust 侧 jobs.error 摘要来源)。
        失败时附带 error 字段 (阶段级错误, 不是句级失败)。"""
        import json
        try:
            data = self.quality.to_dict()
            if error:
                data["error"] = f"{error}" + (f": {detail}" if detail else "")
            with open(os.path.join(self.out_dir, "quality_report.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def _tts_pack(self, book: Book):
        """TTS → align → pack。LLM 与 TTS 不同驻 (R5: 12GB 显存装不下), 先停 LLM 再起 TTS。"""
        total_sents = book.sentence_count

        self._emit_stage("tts", 0, total_sents)
        self._tts(book)
        self._emit_stage("tts", total_sents, total_sents, done=True)

        self._emit_stage("align", 0, total_sents)
        self._align(book)
        self._emit_stage("align", total_sents, total_sents, done=True)

        self._emit_stage("pack", 0, len(book.chapters))
        from aidulc_prep.pipeline.pack import pack_book
        pack_book(book, self.out_dir, self.job, self.quality, emit=self.emit, cancel=self.cancel)

    def _tts(self, book: Book):
        # LLM → TTS 阶段切换: 释放 LLM 显存
        from aidulc_prep.pipeline.llm.server import stop_server
        stop_server()
        from aidulc_prep.pipeline.tts.stage import synth_chapter
        model_path = self.job["models"]["tts"]
        voice = self.job["profile"].get("voice", "af_heart")
        speed = self.job["profile"].get("speed", 1.0)
        # H5 fix: 语言驱动 TTS (旧实现恒 en)
        lang = self.job.get("languages", {}).get("source") if isinstance(self.job.get("languages"), dict) \
            else self.job.get("source_language", "en")
        done = 0
        for ch in book.chapters:
            if self.cancel():
                raise EngineError("已取消", "tts")
            synth_chapter(ch, model_path, voice, speed, self.out_dir, self.quality,
                          emit=self.emit, cancel=self.cancel, language=lang,
                          chapter_base=done)  # 进度修复: sentence_index 全局连续
            done += len(ch.sentences)
            self.emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "tts", "current": done, "total": book.sentence_count})

    def _align(self, book: Book):
        # M 系列: 实现提取到 align/stage.py (与 llm/tts/nlp stage 对称)
        from aidulc_prep.pipeline.align.stage import run_align_stage
        run_align_stage(book, self.quality, cancel=self.cancel)

    def _run_pipeline(self) -> Book:
        self._emit_stage("parse", 0, 1)
        book = self._parse()
        self._emit_stage("parse", 1, 1, done=True)

        self._emit_stage("nlp", 0, len(book.chapters))
        self._nlp(book)
        self._emit_stage("nlp", len(book.chapters), len(book.chapters), done=True)

        total_sents = book.sentence_count
        self._emit_stage("translate", 0, total_sents)
        self._translate(book)
        self._emit_stage("translate", total_sents, total_sents, done=True)

        self._emit_stage("explain", 0, total_sents)
        self._explain(book)
        self._emit_stage("explain", total_sents, total_sents, done=True)

        return book

    def _emit_stage(self, stage, current, total, done=False):
        self.emit({
            "type": "stage_done" if done else "stage_start",
            "ts": int(time.time() * 1000),
            "stage": stage,
            "current": current,
            "total": total,
        })
        # 性能探针 (2026-08-15): emit() 走的 NDJSON 进度流只喂前端实时进度条, 不落盘,
        # 事后没法回看"某阶段整体花了多久"。这里额外记一行到 run.log(已有 FileHandler),
        # 跟 llm/stage.py、tts/stage.py 里逐次调用的 TIMING 行放一起, 能互相印证
        # "单次调用耗时总和" 是否能解释 "阶段整体墙钟时间"(差距大说明还有别的开销,
        # 比如 checkpoint I/O、guard 校验、JSON 解析这些非模型调用的部分)。
        logging.getLogger("aidulc").info(
            "STAGE_MARK stage=%s event=%s current=%d total=%d ts=%d",
            stage, "done" if done else "start", current, total, int(time.time() * 1000),
        )

    def _parse(self) -> Book:
        try:
            ext = os.path.splitext(self.job["book_path"])[1].lower()
            if ext == ".epub":
                from aidulc_prep.pipeline.loader.epub import load_epub_with_spine_health
                book, uncovered = load_epub_with_spine_health(self.job["book_path"])
                self._check_epub_health(book, uncovered)
                return book
            return load_book(self.job["book_path"])
        except InputError as e:
            self.quality.record("parse", ok=False)
            raise

    def _check_epub_health(self, book: Book, uncovered: list[str]) -> None:
        """F39 体检本来只在"查看原文"预览路径生效(cli.py --preview-book), 真正备料
        跑的是这里, 没接线——实测 Tuck Everlasting 因此悄悄产出一本只有 5% 正文的书,
        全程无错误无警告(2026-08-16 实测)。

        2026-08-16 补充实测: `uncovered` 里混了两类完全不同的东西——(a) 真的读不到
        的文件(路径解析失败, 数据丢失, 该拦)和 (b) 读到了但本来就没正文的文件
        (纯插图页/手写目录页, epub.py::_build_chapters_from_file 对这类文件本来就会
        返回 []——正常现象, 不该拦)。第一版实现把两者混在一起算比例, 实测在
        Despereaux(9个未覆盖, 全部是插图页, 真实占比应为 0%)和 Wild Robot Boxed Set
        (36个未覆盖, 同样全部是插图/目录页, 真实占比应为 0%)上会分别算出 13.8%/10.7%,
        双双错误触发本该只拦真正数据丢失的 10% 阈值——用 _classify_uncovered_epub_files
        重新分类后两本书的真实缺失都是 0/9 和 0/36, 才是正确结果。"""
        from aidulc_prep.core.health import detect_anomalies
        real_missing = self._classify_uncovered_epub_files(uncovered)
        total = len(book.chapters) + len(uncovered)
        if total and len(real_missing) / total > 0.10:
            sample = ", ".join(real_missing[:5])
            more = f" 等共 {len(real_missing)} 个" if len(real_missing) > 5 else ""
            raise InputError(
                "EPUB 疑似大量正文丢失, 已拒绝处理",
                f"{len(real_missing)}/{total} 个正文文件读取失败({sample}{more})"
                "——多半是路径编码/解析问题, 不是正常现象",
            )
        anomalies = detect_anomalies([len(c.sentences) for c in book.chapters], real_missing)
        if anomalies:
            logging.getLogger("aidulc").warning(
                "EPUB 体检发现 %d 条异常(未达 10%% 阻断阈值, 继续处理): %s",
                len(anomalies), "; ".join(anomalies[:10]),
            )

    def _classify_uncovered_epub_files(self, uncovered: list[str]) -> list[str]:
        """实现已挪到 loader/epub.py::classify_uncovered(导入体检要复用同一份判据,
        不允许两处各写一遍)。这里保留薄封装, 现有测试和调用点不用改。"""
        from aidulc_prep.pipeline.loader.epub import classify_uncovered
        return classify_uncovered(self.job.get("book_path", ""), uncovered)

    def _nlp(self, book: Book):
        # M 系列: 实现提取到 nlp/stage.py (与 llm/tts/align stage 对称)
        from aidulc_prep.pipeline.nlp.stage import run_nlp_stage
        run_nlp_stage(book, self.job, self.out_dir, self.quality, cancel=self.cancel)
        self._hydrate_book(book)

    def _hydrate_book(self, book: Book):
        """把 checkpoint 里已有的 translation/explanation/audio/words 重新载入内存句子,
        保证断点续跑时 TTS/pack 阶段有完整数据 (审查确认: 旧实现只 hydrate translation)。"""
        from aidulc_prep.core.models import SentenceAudio, WordTiming
        from aidulc_prep.infra.checkpoint import FIELD_TO_STAGE, load_sentence
        for ch in book.chapters:
            for i, s in enumerate(ch.sentences):
                data = load_sentence(self.out_dir, ch.index, i)
                if not data:
                    continue
                if data.get("translation"):
                    s.translation = data["translation"]
                if data.get("explanation"):
                    s.explanation = data["explanation"]
                if data.get("failedStages"):
                    # 归一化: 老 checkpoint 存字段名 ("translation"), 统一成阶段名 ("translate")
                    s.failed_stages = [FIELD_TO_STAGE.get(x, x) for x in data["failedStages"]]
                if data.get("status"):
                    s.status = data["status"]
                audio = data.get("audio")
                if audio and audio.get("start_ms") is not None:
                    s.audio = SentenceAudio(
                        chapter=ch.index,
                        start_ms=audio["start_ms"],
                        end_ms=audio["end_ms"],
                    )
                words = data.get("words") or []
                s.words = [WordTiming(**w) for w in words if w is not None]

    def _translate(self, book: Book):
        from aidulc_prep.pipeline.llm.server import get_server
        from aidulc_prep.pipeline.llm.stage import translate_sentences
        server = get_server(self.job["models"]["llm"])
        done = 0
        for ch in book.chapters:
            if self.cancel():
                raise EngineError("已取消", "translate")
            # 进度优化: 每批回调一次 (UI 实时动, 不再卡到章尾)
            translate_sentences(
                ch, server.complete, self.out_dir, self.quality,
                cancel=self.cancel,
                on_batch=lambda n: self.emit({
                    "type": "stage_progress",
                    "ts": int(time.time() * 1000),
                    "stage": "translate",
                    "current": done + n,
                    "total": book.sentence_count,
                }),
            )
            done += len(ch.sentences)
            self.emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "translate", "current": done, "total": book.sentence_count})

    def _explain(self, book: Book):
        strategy = self.job["profile"].get("explain_strategy", "brief")
        if strategy == "none":
            return
        # K33 (2026-08-16): profile 可调的讲解字数上限/触发门槛, 缺省时用
        # profile_repo.rs::Profile::default() 同款默认值(150/0), 兼容旧 job_request
        # (没带这两个字段的历史快照/测试 fixture)。
        max_chars = self.job["profile"].get("explain_max_chars", 150)
        min_sentence_chars = self.job["profile"].get("explain_min_sentence_chars", 0)
        from aidulc_prep.pipeline.llm.server import get_server
        from aidulc_prep.pipeline.llm.stage import explain_sentences
        server = get_server(self.job["models"]["llm"])
        done = 0
        first_run = self._first_run
        processed_total = 0
        skipped_fatal = 0
        for ch in book.chapters:
            if self.cancel():
                raise EngineError("已取消", "explain")
            # 无翻译/fatal 失败的句子 explain 必然跳过 (没翻译无法讲解), 原文太短
            # 不达 min_sentence_chars 门槛的句子也是主动跳过(K33)——两类都要从完整性
            # 校验的分母里排除, 否则"跳过"会被误判成"循环漏跑"(判据要跟
            # explain_sentences 的跳过条件逐条对齐, 不能只对齐一半)。
            skipped_fatal += sum(
                1 for s in ch.sentences
                if "nlp" in s.failed_stages or "translate" in s.failed_stages or not s.translation
                or (min_sentence_chars and len(s.original_text.strip()) < min_sentence_chars)
            )
            # 进度优化: 每 10 句回调一次 (UI 实时动)
            processed = explain_sentences(
                ch, server.complete, self.out_dir, self.quality, strategy,
                cancel=self.cancel,
                on_batch=lambda n: self.emit({
                    "type": "stage_progress",
                    "ts": int(time.time() * 1000),
                    "stage": "explain",
                    "current": done + n,
                    "total": book.sentence_count,
                }),
                max_chars=max_chars,
                min_sentence_chars=min_sentence_chars,
            )
            done += len(ch.sentences)
            processed_total += processed
            self.emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "explain", "current": done, "total": book.sentence_count})
        # 完整性校验 (I-C 2: 欠账检测): 首次全量跑时除 fatal 失败句/门槛跳过句外每句都应被处理。
        # 缺口 > 5% 说明有句子被循环漏跑 (Breath 早期 2518 句欠账的根因场景) → 显式报错, 不静默。
        expected = book.sentence_count - skipped_fatal
        if first_run and expected and processed_total < expected * 0.95:
            raise EngineError(
                "explain 阶段不完整",
                f"首次运行仅处理 {processed_total}/{expected} 句 (另有 {skipped_fatal} 句因无翻译/未达讲解门槛跳过) — 循环漏跑, 请重新任务",
            )
