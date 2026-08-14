/**
 * views/reader/highlights.js —— 摘录标注 (M7 R16/R17, 2026-08-08)
 * 精读划句留痕: 选中文字 → 浮动"摘录"按钮 → 保存 (sentence_index + selected_text) →
 * 句块加标记; 命令面板里可打开摘录列表回看/跳转/删除。
 *
 * 本轮范围: 句级标记 + 文字展示。精确到词范围的 span 高亮是后续工作 (登记 ROADMAP)。
 */
(function (global) {
  'use strict';

  /** K4 (2026-08-14): 之前 load()/_save()/remove() 全都没传 userId, IPC 里这个键
   *  值恒为 undefined、JSON.stringify 会丢掉——后端 user_id 是必填非 Option 字段,
   *  缺字段应报错, load() 拿到失败结果后静默把 items 置空, 面板打得开却看不到
   *  任何东西。镜像 reading_service.js 已有的 currentUser() 写法接上。 */
  function currentUser() {
    return global.AiduUserService ? AiduUserService.currentId() : 'me';
  }

  class ReaderHighlights {
    /**
     * @param {object} deps
     *   bookKey(): 当前书
     *   getChapterIndex(): 当前章
     *   getSentences(): 当前章句子
     *   onJump(sentenceIndex): 跳转到某句
     *   onChanged(): 摘录变化后重渲染标记
     */
    constructor(deps) {
      this.deps = deps;
      this.items = []; // 全书摘录 [{id, book_key, chapter, sentence_index, selected_text}]
      this._btn = null;
      this._panel = null;
      this._onMouseUp = (e) => this._onSelection(e);
      this._onScroll = () => this._hideButton();
    }

    async load(bookKey) {
      this.bookKey = bookKey;
      const res = await AiduBridge.highlights.list(bookKey, currentUser());
      this.items = (res.ok && Array.isArray(res.data)) ? res.data : [];
      return this.items;
    }

    /** 当前章的摘录 (渲染标记用: 句级 + seg 区间) */
    itemsForChapter(chapterIndex) {
      return this.items.filter((h) => h.chapter === chapterIndex);
    }

    attach() {
      document.addEventListener('mouseup', this._onMouseUp);
      document.addEventListener('scroll', this._onScroll, { passive: true });
    }

    detach() {
      document.removeEventListener('mouseup', this._onMouseUp);
      document.removeEventListener('scroll', this._onScroll);
      this._hideButton();
    }

    /** 选中正文文字 → 弹出"摘录"按钮 */
    _onSelection(e) {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { this._hideButton(); return; }
      const block = this._blockFromSelection(sel);
      if (!block) { this._hideButton(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      // R21: 选区覆盖的 seg 区间 (精确到词的 span 高亮)
      let segs = [];
      block.querySelectorAll('.bubble[data-seg-idx]').forEach((t) => {
        const idx = parseInt(t.dataset.segIdx, 10);
        if (!Number.isNaN(idx) && range.intersectsNode(t)) segs.push(idx);
      });
      const segRange = segs.length ? { start: Math.min(...segs), end: Math.max(...segs) } : null;
      this._showButton(rect, block, sel.toString().trim(), segRange);
    }

    _blockFromSelection(sel) {
      const node = sel.anchorNode && sel.anchorNode.parentElement;
      return node ? node.closest('.atomic-block') : null;
    }

    _showButton(rect, block, text, segRange) {
      this._hideButton();
      const btn = document.createElement('button');
      btn.className = 'hl-tool';
      btn.textContent = '摘录';
      btn.style.top = (rect.bottom + 6) + 'px';
      btn.style.left = rect.left + 'px';
      btn.onclick = (e) => {
        e.stopPropagation();
        this._save(block, text, segRange);
      };
      document.body.appendChild(btn);
      this._btn = btn;
    }

    _hideButton() {
      if (this._btn && this._btn.parentNode) this._btn.parentNode.removeChild(this._btn);
      this._btn = null;
    }

    _save(block, text, segRange) {
      const index = parseInt(block.dataset.index, 10);
      if (Number.isNaN(index)) return;
      const now = Date.now();
      const h = {
        id: 'hl-' + now + '-' + Math.random().toString(36).slice(2, 6),
        user_id: currentUser(),
        book_key: this.deps.bookKey(),
        chapter: this.deps.getChapterIndex(),
        sentence_index: index,
        selected_text: text.slice(0, 500),
        note: '',
        start_seg: segRange ? segRange.start : null,
        end_seg: segRange ? segRange.end : null,
        created_at: now,
        updated_at: now,
      };
      AiduBridge.highlights.save(h).then((r) => {
        this._hideButton();
        if (!r.ok) { AiduToast.show('摘录失败: ' + r.error, 'error'); return; }
        this.items.push(h);
        this._markBlock(block, h);
        this.deps.onChanged && this.deps.onChanged();
        AiduToast.show('已摘录', 'success');
      });
    }

    /** 立即给刚摘录的句块加标记 (不用等重渲染) */
    _markBlock(block, h) {
      block.classList.add('highlighted');
      if (h.start_seg != null && h.end_seg != null) {
        for (let i = h.start_seg; i <= h.end_seg; i++) {
          const t = block.querySelector(`.bubble[data-seg-idx="${i}"]`);
          if (t) t.classList.add('hl-span');
        }
      }
    }

    /** 摘录面板 (命令面板入口): 列表/跳转/删除 */
    togglePanel() {
      if (this._panel && this._panel.parentNode) { this._panel.parentNode.removeChild(this._panel); this._panel = null; return; }
      const panel = document.createElement('div');
      panel.className = 'hl-panel';
      const head = document.createElement('div');
      head.className = 'hl-panel-head';
      const title = document.createElement('span');
      title.textContent = '摘录 (' + this.items.length + ')';
      // K18 (2026-08-14): 唯一导出通道之前是整本 .aidu-data JSON 备份, 不是人可读笔记——
      // "精读"这个产品定位下摘录笔记恰恰是最该能导出复习/分享的产出物。
      const exportBtn = document.createElement('button');
      exportBtn.className = 'btn-small';
      exportBtn.textContent = '导出 Markdown';
      exportBtn.title = '把当前书的全部摘录+备注导出成一份 Markdown 文件';
      exportBtn.onclick = (e) => { e.stopPropagation(); this._exportMarkdown(); };
      const close = document.createElement('button');
      close.className = 'btn-small';
      close.textContent = '✕';
      close.onclick = () => panel.remove();
      head.append(title, exportBtn, close);
      const list = document.createElement('div');
      list.className = 'hl-panel-list';
      if (!this.items.length) {
        list.appendChild(Object.assign(document.createElement('div'), {
          className: 'hl-panel-empty', textContent: '这里列出全部笔记。阅读时选中一段文字, 点"摘录"保存, 会出现在这里。',
        }));
      }
      // 全书按 章/句序 排
      const sorted = this.items.slice().sort((a, b) => (a.chapter - b.chapter) || (a.sentence_index - b.sentence_index));
      sorted.forEach((h) => {
        const row = document.createElement('div');
        row.className = 'hl-row';
        const meta = document.createElement('div');
        meta.className = 'hl-row-meta';
        meta.textContent = `第 ${h.chapter + 1} 章 · 句 ${h.sentence_index + 1}`;
        const txt = document.createElement('div');
        txt.className = 'hl-row-text';
        txt.textContent = h.selected_text;
        row.append(meta, txt);

        // R22: 批注展示 + 编辑 (note 字段 R16 已建)
        if (h.note) {
          const noteEl = document.createElement('div');
          noteEl.className = 'hl-row-note';
          noteEl.textContent = '✎ ' + h.note;
          row.appendChild(noteEl);
        }
        const noteBtn = document.createElement('button');
        noteBtn.className = 'btn-small hl-note-btn';
        noteBtn.textContent = h.note ? '改备注' : '加备注';
        noteBtn.onclick = (e) => {
          e.stopPropagation();
          this._editNote(h, noteBtn, () => {
            panel.remove();
            this.togglePanel();
          });
        };
        row.appendChild(noteBtn);

        row.onclick = () => {
          this.deps.onJump(h.chapter, h.sentence_index);
          panel.remove();
        };
        const del = document.createElement('button');
        del.className = 'btn-small btn-danger';
        del.textContent = '删除';
        del.onclick = (e) => {
          e.stopPropagation();
          AiduBridge.highlights.remove(h.id, currentUser()).then((r) => {
            if (!r.ok) { AiduToast.show('删除失败: ' + r.error, 'error'); return; }
            this.items = this.items.filter((x) => x.id !== h.id);
            panel.remove();
            this.deps.onChanged && this.deps.onChanged();
            AiduToast.show('已删除摘录', 'info');
          });
        };
        row.appendChild(del);
        list.appendChild(row);
      });
      panel.append(head, list);
      document.body.appendChild(panel);
      this._panel = panel;

    }

    /** K18 (2026-08-14): 全书摘录导出成 Markdown —— 按 章/句序 排, 每条带引用块+备注,
     *  与 vocab_view.js::_export 同一套 Blob+<a download> 客户端下载模式, 不新起后端命令。 */
    _exportMarkdown() {
      const bookKey = this.deps.bookKey();
      const sorted = this.items.slice().sort((a, b) => (a.chapter - b.chapter) || (a.sentence_index - b.sentence_index));
      const lines = [`# ${bookKey} —— 摘录笔记`, ''];
      let lastChapter = null;
      sorted.forEach((h) => {
        if (h.chapter !== lastChapter) {
          lines.push(`## 第 ${h.chapter + 1} 章`, '');
          lastChapter = h.chapter;
        }
        lines.push(`> ${h.selected_text}`);
        if (h.note) lines.push('', h.note);
        lines.push('');
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bookKey}-摘录.md`;
      a.click();
      URL.revokeObjectURL(url);
      AiduToast.show(`已导出 ${sorted.length} 条摘录`, 'success');
    }

    /** R22: 备注编辑 (内联 textarea, 保存即 upsert) */
    _editNote(h, btn, onSaved) {
      const textarea = document.createElement('textarea');
      textarea.className = 'hl-note-input';
      textarea.value = h.note || '';
      textarea.placeholder = '写下你为什么摘录这段…';
      const save = document.createElement('button');
      save.className = 'btn-small btn-primary';
      save.textContent = '保存';
      const wrap = document.createElement('div');
      wrap.className = 'hl-note-edit';
      wrap.append(textarea, save);
      btn.parentNode.insertBefore(wrap, btn);
      btn.style.display = 'none';
      textarea.focus();
      save.onclick = (e) => {
        e.stopPropagation();
        const note = textarea.value.trim();
        const updated = { ...h, note, updated_at: Date.now() };
        AiduBridge.highlights.save(updated).then((r) => {
          if (!r.ok) { AiduToast.show('备注保存失败: ' + r.error, 'error'); return; }
          const idx = this.items.findIndex((x) => x.id === h.id);
          if (idx >= 0) this.items[idx] = updated;
          AiduToast.show('备注已保存', 'success');
          onSaved && onSaved();
        });
      };
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { wrap.remove(); btn.style.display = ''; }
      });
    }
  }

  global.ReaderHighlights = ReaderHighlights;
})(window);
