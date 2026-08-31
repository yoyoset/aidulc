/**
 * views/library/preview_modal.js —— 原文预览模态 (S4)
 *
 * 治理 (2026-08-31, 同 settings_view.js 的先例): 从 library_view.js 拆出。
 * library_view 曾在一个类里同时装着书卡渲染、任务进度、三个巨型模态、导入导出、
 * 备料启动、在线整书 —— 和当初 settings_view "一个 render 塞 5 个 tab" 是同一种病。
 *
 * 本模块零依赖注入: 预览只读后端数据, 不回写任何视图状态。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 打开原文预览 (书库里打开的是原始书籍, 不是译本) */
  function showPreviewModal(book) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box preview-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('h2', 'modal-title', `原文预览 — ${book.title || book.id}`);
    const body = el('div', 'preview-body');
    body.textContent = '加载中…';
    const actions = el('div', 'modal-actions');
    const closeBtn = el('button', 'btn-small', '关闭');
    actions.appendChild(closeBtn);
    box.append(title, body, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    closeBtn.onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    closeBtn.focus();

    AiduLibraryService.preview(book.id).then((res) => {
      if (!res.ok) { body.textContent = '预览失败: ' + res.error; return; }
      const d = res.data || {};
      body.innerHTML = '';
      const h = d.health || {};
      const meta = el('div', 'preview-meta',
        `${d.chapters ? d.chapters.length : 0} 章 · ${d.format || ''}${h.toc_source && h.toc_source !== 'n/a' ? ' · 目录: ' + h.toc_source : ''}`);
      body.appendChild(meta);
      // R3.3: 处理前体检异常信号 (碎片章/巨章/无正文) 红字提示
      const anomalies = h.anomalies || [];
      if (anomalies.length) {
        const warn = el('div', 'preview-anomalies', '⚠ ' + anomalies.join('; '));
        body.appendChild(warn);
      }
      (d.chapters || []).slice(0, 20).forEach((ch) => {
        const sec = el('div', 'preview-chapter');
        sec.appendChild(el('div', 'preview-ch-title', ch.title || ('Chapter ' + (ch.index + 1))));
        (ch.sentences || []).slice(0, 10).forEach((s) => {
          sec.appendChild(el('div', 'preview-sentence', s));
        });
        if ((ch.sentences || []).length > 10) {
          sec.appendChild(el('div', 'preview-more', `…共 ${ch.sentences.length} 段`));
        }
        body.appendChild(sec);
      });
    });
  }

  global.AiduLibraryPreviewModal = { showPreviewModal };
})(window);
