/**
 * views/library/status.js —— 书状态徽章/分段筛选/阶段文案 (K2-3 拆分, 2026-08-13)
 * 从 library_view.js 拆出: 状态分类是独立于"卡片怎么画"的纯映射逻辑, 与
 * views/library/cover.js(展示)同级——两者都不碰这个文件的书 CRUD/导入职责。
 */
(function (global) {
  'use strict';

  /** 阶段名 → 中文 (与 prep_view 一致) */
  const STAGE_LABEL = {
    parse: '识别', nlp: '分词', translate: '翻译', explain: '讲解',
    tts: '语音', align: '对齐', pack: '排版', spawn_error: '启动失败',
  };

  /** 书状态 → { label, badgeClass } (苹果级: 状态可视) */
  function bookStatus(book) {
    const map = {
      ready: { label: '就绪', cls: 'badge-ok' },
      // mark_original_done 把源书标成 done: 已生成译本, 展示为"已就绪"
      done: { label: '已就绪', cls: 'badge-ok' },
      partial: { label: '部分失败', cls: 'badge-warn' },
      processing: { label: '处理中', cls: 'badge-busy' },
      // G6 (2026-08-11): 措辞统一 —— 卡片徽章与筛选条都叫「未处理」(设计稿用词)
      pending: { label: '未处理', cls: 'badge-idle' },
      failed: { label: '未处理', cls: 'badge-idle' },
    };
    return map[book.status] || { label: book.status, cls: 'badge-idle' };
  }

  /** AUTOSTANDARDIZE (2026-08-19): standardize_status → 独立于 status 的第二档展示.
   *  none/缺省 = 不显示(绝大多数书, 零视觉噪音); done = 转完就是正常书, 只留一个
   *  小点 + 悬浮 title 可查证的痕迹; pending/running = 复用现有处理中样式;
   *  failed = 复用现有失败样式, 文案直接用 standardize_note。
   *  @returns {null|{label: string, cls: string, title?: string}} */
  function standardizeBadge(book) {
    const s = book && book.standardize_status;
    const note = (book && book.standardize_note) || '';
    if (s === 'pending' || s === 'running') {
      return { label: '自动转换中…', cls: 'badge-busy', title: note || '格式自动转换中' };
    }
    if (s === 'done') {
      // 不打扰: 无常驻文字, 悬浮 title 显示标准化痕迹 (这本书跟正常书没区别)
      return { label: '', cls: 'badge-ok badge-dot', title: note || '格式已自动转换完成' };
    }
    if (s === 'failed') {
      const label = note || '格式自动转换失败';
      return { label, cls: 'badge-err', title: note || label };
    }
    return null; // 'none' / 缺省
  }

  /** 阶段6 设计交付 §01: 状态分段映射 —— 未处理 = pending/failed; 已就绪 = ready/done/partial */
  function inStatusBucket(book, bucket) {
    switch (bucket) {
      case 'ready': return ['ready', 'done', 'partial'].includes(book.status);
      case 'processing': return book.status === 'processing';
      case 'pending': return ['pending', 'failed'].includes(book.status);
      default: return true;
    }
  }

  /** 阶段6 设计交付 §01: 分段计数 (苹果级: 数量可见, 空分段不误导) */
  function updateSegCounts(books, segBar) {
    if (!segBar) return;
    segBar.querySelectorAll('.lib-seg').forEach((seg) => {
      const bucket = seg.dataset.bucket;
      const n = bucket === 'all' ? (books || []).length
        : (books || []).filter((b) => inStatusBucket(b, bucket)).length;
      seg.dataset.count = String(n);
      const countEl = seg.querySelector('.lib-seg-count');
      if (countEl) countEl.textContent = String(n);
    });
  }

  global.AiduLibraryStatus = { STAGE_LABEL, bookStatus, standardizeBadge, inStatusBucket, updateSegCounts };
})(window);
