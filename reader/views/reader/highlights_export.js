/**
 * views/reader/highlights_export.js —— 摘录导出 (Markdown / HTML / 打印存 PDF)
 * 2026-09-05: 从 highlights.js 拆出来——三种导出格式共用"按章分组"这份数据整理
 * 逻辑, 加上 highlights.js 本身已经因为这次自定义标签改造逼近文件行数上限
 * (defaultMaxFileLines: 600), 导出是相对独立的一块(纯函数, 不依赖 DOM 事件/
 * 选区状态), 拆出来更清楚也更好测。全部是纯函数, 不持有状态。
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 摘录列表 → 按章分组, 每条摘录附上标签文案/命中的生词/备注。labelForKind 和
   *  vocabHitsFor 由调用方传入(它们依赖 ReaderHighlights 实例的标签store/生词
   *  缓存, 这个模块本身不碰那些状态)。 */
  function buildGroups(items, { labelForKind, vocabHitsFor }) {
    const sorted = items.slice().sort((a, b) => (a.chapter - b.chapter) || (a.sentence_index - b.sentence_index));
    const groups = [];
    let current = null;
    sorted.forEach((h) => {
      if (!current || current.chapter !== h.chapter) {
        current = { chapter: h.chapter, items: [] };
        groups.push(current);
      }
      current.items.push({
        text: h.selected_text,
        tagLabel: h.kind ? labelForKind(h.kind) : '',
        vocabHits: vocabHitsFor(h.selected_text),
        note: h.note || '',
      });
    });
    return { groups, total: sorted.length };
  }

  function toMarkdown(bookKey, groups) {
    const lines = [`# ${bookKey} —— 摘录笔记`, ''];
    groups.forEach((g) => {
      lines.push(`## 第 ${g.chapter + 1} 章`, '');
      g.items.forEach((it) => {
        lines.push(it.tagLabel ? `> **[${it.tagLabel}]** ${it.text}` : `> ${it.text}`);
        if (it.vocabHits.length) lines.push('', `生词: ${it.vocabHits.join(', ')}`);
        if (it.note) lines.push('', it.note);
        lines.push('');
      });
    });
    return lines.join('\n');
  }

  /** groups → 排版好的 HTML 片段(不含 <html>/<head> 外壳), HTML 导出和打印
   *  导出共用——两者只是"存成文件"还是"喂给 iframe 打印"的差别。 */
  function bodyHtml(groups) {
    return groups.map((g) => {
      const items = g.items.map((it) => `
        <blockquote>
          ${it.tagLabel ? `<span class="tag">${escapeHtml(it.tagLabel)}</span>` : ''}
          <p>${escapeHtml(it.text)}</p>
          ${it.vocabHits.length ? `<p class="vocab">生词: ${escapeHtml(it.vocabHits.join(', '))}</p>` : ''}
          ${it.note ? `<p class="note">${escapeHtml(it.note)}</p>` : ''}
        </blockquote>`).join('\n');
      return `<h2>第 ${g.chapter + 1} 章</h2>\n${items}`;
    }).join('\n');
  }

  /** 拼出一份完整独立的 HTML 文档(内联样式, 不依赖外部资源)——HTML 导出直接
   *  存成文件, 打印导出喂给隐藏 iframe。这是一份独立文件(不引用 tokens.css),
   *  内联写死取值而不是用 CSS 变量。 */
  function toHtmlDocument(bookKey, groups) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(bookKey)} —— 摘录笔记</title>
<style>
  body { font-family: Georgia, "Noto Serif SC", serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #2b2822; background: #faf7f1; line-height: 1.7; }
  h1 { font-size: 1.6em; }
  h2 { font-size: 1.2em; margin-top: 2em; border-bottom: 1px solid #d9d2c4; padding-bottom: 4px; }
  blockquote { margin: 1em 0; padding: 8px 16px; border-left: 3px solid #9c6a4a; background: #f2e3d7; }
  .tag { display: inline-block; font-size: 0.75em; background: #5a7687; color: #fff; border-radius: 999px; padding: 1px 8px; margin-bottom: 4px; }
  .vocab { font-size: 0.85em; color: #5a7687; }
  .note { font-size: 0.9em; color: #6b6559; font-style: italic; }
  @media print { body { background: #fff; margin: 0; max-width: none; } }
</style>
</head>
<body>
<h1>${escapeHtml(bookKey)} —— 摘录笔记</h1>
${bodyHtml(groups)}
</body></html>`;
  }

  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 2026-09-05: "导出 PDF"没有引入 PDF 生成库(会撞上 Tauri CSP 只放行 'self'
   *  脚本源的限制, 也没必要为这一个功能多带一份依赖), 而是借浏览器/系统自带的
   *  打印能力——把排版好的 HTML 喂给一个隐藏 iframe, 调用它的 print(), 用户在
   *  系统打印对话框里选"另存为 PDF"。调用方的按钮文案/提示必须写清楚这是"打印"
   *  不是应用自己生成 PDF 文件, 别让用户以为点了就直接拿到一个 PDF。 */
  function printHtml(html) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:none;';
    document.body.appendChild(iframe);
    iframe.onload = () => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 1000);
    };
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
  }

  global.HighlightsExport = { buildGroups, toMarkdown, toHtmlDocument, downloadBlob, printHtml };
})(window);
