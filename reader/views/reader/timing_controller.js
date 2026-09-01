/**
 * views/reader/timing_controller.js —— 跟读时间轴校准的状态与落库编排
 *
 * 从 reader_view 抽出来的原因: reader_view.js 早已超出文件规模基线, 校准这件事有自己
 * 完整的状态(按章分组的锚点)+ 生命周期(开书拉一次 / 切章应用 / 微调落库), 属于独立
 * 职责, 不该继续往组合根里堆。时间计算全在 core/timing_offsets.js(纯函数, 有单测),
 * 本模块只管"锚点存哪、什么时候应用、怎么落库"。
 *
 * 性能约定:
 * - 锚点在**开书时随已有的并行组一次性**拉回(通常 0 行), 之后切章零 IPC。
 * - 偏移在**章节加载时一次性**平移进 sentence.audio(一趟 O(n)), 每帧高亮零额外开销。
 * - 2026-09-01 起是**整章一个偏移**(见 core/timing_offsets.js::shiftWhole), 表结构仍是
 *   分段的(from_sentence 是主键的一部分), 只是现在恒写 0 —— 不动 schema 免一次迁移。
 * - 微调先本地应用(即时反馈, 用户正在听), 再后台落库。
 */
(function (global) {
  'use strict';

  class TimingController {
    /**
     * @param {object} deps {
     *   getBookId(): string,
     *   onStatus(text): void,   // 落库失败的人话提示
     * }
     */
    constructor(deps) {
      this.deps = deps;
      /** { '章下标': [{from, offset}, ...] } */
      this.byChapter = {};
    }

    /** 开书时把后端返回的扁平锚点行按章分组进内存 */
    ingest(rows) {
      this.byChapter = {};
      if (!Array.isArray(rows)) return;
      rows.forEach((a) => {
        const k = String(a.chapter_index);
        (this.byChapter[k] = this.byChapter[k] || []).push({
          from: a.from_sentence,
          offset: a.offset_ms,
        });
      });
    }

    anchorsFor(chapterIndex) {
      return this.byChapter[String(chapterIndex)] || [];
    }

    /** 章节加载后调用一次: 把本章锚点平移进句子时间轴 */
    applyTo(sentences, chapterIndex) {
      return global.AiduTimingOffsets.applyToSentences(sentences, this.anchorsFor(chapterIndex));
    }

    /**
     * 整章平移 delta 毫秒 (在 currentIndex 句现行偏移的基础上叠加)。
     * 落库失败只提示、不回滚本地 —— "这一次阅读能对上"比"存住"更要紧。
     */
    nudge(sentences, chapterIndex, currentIndex, delta) {
      if (!delta) return false;
      const T = global.AiduTimingOffsets;
      const prev = this.anchorsFor(chapterIndex);
      const next = T.shiftWhole(prev, currentIndex, delta);
      // 库里可能留着旧的分段锚点 (from > 0)。整章语义下它们必须先清掉, 否则
      // timingOffsetSet 只 UPSERT from=0 那一行, 旧行还在, 下次开书又被读回来。
      const hasSegmented = prev.some((a) => a.from !== 0);
      this.byChapter[String(chapterIndex)] = next;
      T.applyToSentences(sentences, next);
      const off = next.length ? next[0].offset : 0;
      const bookId = this.deps.getBookId();
      const write = () =>
        AiduLibraryService.timingOffsetSet(bookId, chapterIndex, 0, off)
          .then((r) => { if (!r.ok) this._warn(r.error); })
          .catch((e) => this._warn(e && e.message));
      if (hasSegmented) {
        AiduLibraryService.timingOffsetReset(bookId, chapterIndex).then(write).catch(write);
      } else {
        write();
      }
      return true;
    }

    /** 复位一章 (回到备料给出的原始时间轴) */
    reset(sentences, chapterIndex) {
      this.byChapter[String(chapterIndex)] = [];
      global.AiduTimingOffsets.applyToSentences(sentences, []);
      AiduLibraryService.timingOffsetReset(this.deps.getBookId(), chapterIndex).catch(() => {});
    }

    _warn(detail) {
      const msg = '校准已生效, 但保存失败' + (detail ? ': ' + detail : '');
      if (this.deps.onStatus) this.deps.onStatus(msg);
    }
  }

  global.TimingController = TimingController;
})(window);
