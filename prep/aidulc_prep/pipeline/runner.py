"""
pipeline/runner.py —— 编排 + 逐句 try + 每句落盘 + 协作式取消

阶段序: parse(loader) → nlp → translate → explain → tts → align → pack
中断语义: 取消和意外中断效果相同, 已完成中间产物保留, 重跑自动续上 (靠 checkpoint 文件)。
"""
from __future__ import annotations

import os
import time

from aidulc_prep.core.errors import EngineError, InputError, OutputError
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

    def run(self) -> Book:
        t0 = time.time()
        try:
            book = self._run_pipeline()
            self._tts_pack(book)
        except EngineError as e:
            self.emit({"type": "error", "ts": int(time.time() * 1000), "message": e.human, "detail": e.detail})
            # I-C: 失败可读 —— 异常路径也落盘 quality_report (含 error 摘要),
            # Rust 侧 quality_summary 读它填充 jobs.error (否则只显示"无详情报告")
            self._write_quality_report(error=e.human, detail=e.detail)
            raise
        elapsed = time.time() - t0
        # I-C: 失败可读 —— 质量报告落盘, Rust 侧读它填充 jobs.error
        self._write_quality_report()
        self.emit({"type": "job_done", "ts": int(time.time() * 1000), "exit_code": 0, "message": f"完成, 耗时 {elapsed:.0f}s"})
        return book

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

    def _parse(self) -> Book:
        try:
            return load_book(self.job["book_path"])
        except InputError as e:
            self.quality.record("parse", ok=False)
            raise

    def _nlp(self, book: Book):
        # M 系列: 实现提取到 nlp/stage.py (与 llm/tts/align stage 对称)
        from aidulc_prep.pipeline.nlp.stage import run_nlp_stage
        run_nlp_stage(book, self.job, self.out_dir, self.quality, cancel=self.cancel)
        self._hydrate_book(book)

    def _hydrate_book(self, book: Book):
        """把 checkpoint 里已有的 translation/explanation/audio/words 重新载入内存句子,
        保证断点续跑时 TTS/pack 阶段有完整数据 (审查确认: 旧实现只 hydrate translation)。"""
        from aidulc_prep.core.models import SentenceAudio, WordTiming
        from aidulc_prep.infra.checkpoint import load_sentence
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
                    s.failed_stages = list(data["failedStages"])
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
        from aidulc_prep.pipeline.llm.server import get_server
        from aidulc_prep.pipeline.llm.stage import explain_sentences
        server = get_server(self.job["models"]["llm"])
        done = 0
        first_run = not os.path.exists(os.path.join(self.out_dir, "checkpoints"))
        processed_total = 0
        skipped_fatal = 0
        for ch in book.chapters:
            if self.cancel():
                raise EngineError("已取消", "explain")
            # 无翻译/fatal 失败的句子 explain 必然跳过 (没翻译无法讲解) — 完整性校验需排除
            skipped_fatal += sum(1 for s in ch.sentences
                                 if s.status == "failed" or not s.translation or "translate" in s.failed_stages)
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
            )
            done += len(ch.sentences)
            processed_total += processed
            self.emit({"type": "stage_progress", "ts": int(time.time() * 1000), "stage": "explain", "current": done, "total": book.sentence_count})
        # 完整性校验 (I-C 2: 欠账检测): 首次全量跑时除 fatal 失败句外每句都应被处理。
        # 缺口 > 5% 说明有句子被循环漏跑 (Breath 早期 2518 句欠账的根因场景) → 显式报错, 不静默。
        expected = book.sentence_count - skipped_fatal
        if first_run and expected and processed_total < expected * 0.95:
            raise EngineError(
                "explain 阶段不完整",
                f"首次运行仅处理 {processed_total}/{expected} 句 (另有 {skipped_fatal} 句因无翻译跳过) — 循环漏跑, 请重新任务",
            )
