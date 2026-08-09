/**
 * views/review_view.js —— 桌面三栏背单词 (V3, 2026-08-09)
 * 队列 / 卡片 / 原文。SPACE 翻面、1-4 评分、S 跳过、E 编辑。
 * 翻面单向不可逆; 评分区翻面后 250ms 才可点 (FlipLock); 3 秒可撤销 (UndoStack)。
 * 纯逻辑在 core/review.js (零 DOM), 本视图只做 DOM 绑定与 IPC 调用。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const STAGE_LABEL = { new: '新', learning: '学习中', review: '复习', mastered: '已掌握' };

  class ReviewView {
    constructor(store) {
      this.store = store;
      this.profileId = 'default';
      this.queue = [];          // 今日队列 (core 纯逻辑构建)
      this.index = 0;
      this.done = 0;
      this.flipLock = null;     // core.FlipLock
      this.undoStack = null;    // core.UndoStack
      this.gradeBtns = [];
      this._onKey = null;
      this._undoTimer = null;
    }

    render(container) {
      container.innerHTML = '';
      this._container = container;
      const wrap = el('div', 'review-view');
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '背单词'));
      wrap.appendChild(header);
      // 三栏 grid (设计稿 §02: 264px 队列 | 弹性卡片 | 336px 原文)
      const grid = el('div', 'review-grid');
      this.queueCol = el('div', 'review-col review-queue');
      this.cardCol = el('div', 'review-col review-card-wrap');
      this.sourceCol = el('div', 'review-col review-source');
      grid.append(this.queueCol, this.cardCol, this.sourceCol);
      wrap.appendChild(grid);
      container.appendChild(wrap);

      this._load();
    }

    async _load() {
      const res = await AiduDictionaryService.vocabAll(this.profileId);
      if (!res.ok) {
        this._container.innerHTML = '<div class="global-error">加载生词失败: ' + res.error + '</div>';
        return;
      }
      const entries = res.data || [];
      const now = Date.now();
      const q = global.AiduReviewCore.buildQueue(entries, now);
      this.queue = q.order;
      this.index = 0;
      this.done = 0;
      this._lastCounts = q.counts;
      this.flipLock = new global.AiduReviewCore.FlipLock();
      this.undoStack = new global.AiduReviewCore.UndoStack();
      this._renderQueueSummary(q);
      this._renderCurrent();
      this._bindKeys();
    }

    _renderQueueSummary(q) {
      const c = q.counts || {};
      const head = el('div', 'review-queue-head');
      head.appendChild(el('div', 'review-queue-title', '今日队列'));
      const meta = el('div', 'review-queue-meta', '');
      meta.textContent = `${this.done} / ${this.queue.length}`;
      head.appendChild(meta);
      const progress = el('div', 'review-progress');
      const bar = el('div', 'review-progress-bar');
      progress.appendChild(bar);
      const chips = el('div', 'review-chips');
      chips.append(
        el('span', 'review-chip', `复习 ${c.review || 0}`),
        el('span', 'review-chip', `学习中 ${c.learning || 0}`),
        el('span', 'review-chip', `新词 ${c.new}/${c.newTotal || 0}`),
      );
      const est = global.AiduReviewCore.estimateSeconds(this.queue.length);
      const estEl = el('div', 'review-queue-foot', `预计约 ${Math.ceil(est / 60)} 分钟 · 已复习 ${this.done} 词`);
      this.queueCol.innerHTML = '';
      this.queueCol.append(head, progress, chips, estEl);
      this._queueList = el('div', 'review-queue-list');
      this.queueCol.appendChild(this._queueList);
    }

    _renderCurrent() {
      if (this.index >= this.queue.length) {
        this._renderDone();
        return;
      }
      const entry = this.queue[this.index];
      const card = el('div', 'review-card' + (this.flipLock.isFlipped() ? ' flipped' : ''));
      // 正面: 单词 + 音标
      const front = el('div', 'review-card-face front');
      front.appendChild(el('div', 'review-word', entry.word));
      if (entry.phonetic) front.appendChild(el('div', 'review-phonetic', entry.phonetic));
      if (entry.context) {
        const ctx = el('div', 'review-context', String(entry.context));
        front.appendChild(ctx);
      }
      front.appendChild(el('div', 'review-flip-hint', 'SPACE 翻面'));
      card.appendChild(front);
      // 背面: 释义 + 来源
      const back = el('div', 'review-card-face back');
      back.appendChild(el('div', 'review-word', entry.word));
      if (entry.phonetic) back.appendChild(el('div', 'review-phonetic', entry.phonetic));
      const meaning = el('div', 'review-meaning', entry.meaning || '—');
      back.appendChild(meaning);
      if (entry.pos) back.appendChild(el('div', 'review-pos', entry.pos));
      card.appendChild(back);

      // 评分区 (底部): 翻面后可见, 250ms 锁由 core.FlipLock 控制
      const gradeRow = el('div', 'review-grade-row');
      this.gradeBtns = [];
      for (let g = 1; g <= 4; g++) {
        const btn = el('button', 'review-grade-btn g' + g, '');
        btn.appendChild(el('span', 'review-grade-label', ['忘了', '模糊', '记得', '太简单'][g - 1]));
        btn.appendChild(el('span', 'review-grade-time', '…'));
        btn.disabled = true;
        btn.onclick = () => this._grade(g);
        this.gradeBtns.push(btn);
        gradeRow.appendChild(btn);
      }

      this.cardCol.innerHTML = '';
      this.cardCol.append(card, gradeRow);
      this._cardEl = card;

      // 翻面后拉预览时间
      AiduDictionaryService.srsPreview(this.profileId, entry.lemma).then((r) => {
        if (!r.ok || !r.data || !r.data.options) return;
        r.data.options.forEach((o, i) => {
          if (this.gradeBtns[i]) {
            const t = this.gradeBtns[i].querySelector('.review-grade-time');
            if (t) t.textContent = o.human;
          }
        });
      });

      // 原文语境 (右栏): V4 有来源定位后显示书名/章节; 现在降级为上下文单句
      this._renderSource(entry);

      // 更新队列列表高亮
      this._renderQueueList();
    }

    _renderSource(entry) {
      this.sourceCol.innerHTML = '';
      const head = el('div', 'review-source-head');
      head.appendChild(el('div', 'review-source-title', '原文语境'));
      // V4 接线后: 《书名》·第 N 章 · M 处出现; 现在无来源定位, 降级
      head.appendChild(el('div', 'review-source-meta', entry.context ? '来源句' : '未记录来源'));
      this.sourceCol.appendChild(head);
      if (entry.context) {
        const s = el('div', 'review-source-sentence', String(entry.context));
        this.sourceCol.appendChild(s);
      } else {
        this.sourceCol.appendChild(el('div', 'review-source-empty', '这个词加入时没有记录原文句。'));
      }
    }

    _renderQueueList() {
      if (!this._queueList) return;
      this._queueList.innerHTML = '';
      this.queue.forEach((e, i) => {
        const row = el('div', 'review-qrow' + (i === this.index ? ' current' : '') + (i < this.index ? ' done' : ''));
        row.appendChild(el('span', 'review-qword', e.word));
        row.appendChild(el('span', 'review-qstage', STAGE_LABEL[e.stage] || e.stage));
        if (i < this.index) row.appendChild(el('span', 'review-qdone', '✓'));
        this._queueList.appendChild(row);
      });
    }

    _renderDone() {
      this.cardCol.innerHTML = '';
      this.cardCol.appendChild(el('div', 'review-done',
        `今日队列完成 · 复习 ${this.done} 词`));
      this.gradeBtns = [];
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey);
        this._onKey = null;
      }
      if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    }

    _bindKeys() {
      if (this._onKey) document.removeEventListener('keydown', this._onKey);
      this._onKey = (e) => {
        const action = global.AiduReviewCore.keyAction(e);
        if (!action) return;
        if (action === 'flip') { e.preventDefault(); this._flip(); }
        else if (action.startsWith('grade')) { this._grade(Number(action.slice(5))); }
        else if (action === 'skip') { this._skip(); }
        else if (action === 'edit') { this._edit(); }
      };
      document.addEventListener('keydown', this._onKey);
    }

    _flip() {
      if (!this.flipLock || this.flipLock.isFlipped()) return; // 翻面单向不可逆
      const now = Date.now();
      this.flipLock.flip(now);
      if (this._cardEl) this._cardEl.classList.add('flipped');
      // 解锁评分 (250ms): 到点把按钮点亮, 显示四档时间
      setTimeout(() => {
        if (!this.flipLock) return;
        // 用"现在"判锁: 若过了锁定窗口, canGrade 为 true (锁内部用 flipAt 算 delta)
        if (this.flipLock.canGrade(Date.now())) this._enableGrades();
      }, global.AiduReviewCore.GRADE_LOCK_MS);
    }

    _enableGrades() {
      this.gradeBtns.forEach((b) => { b.disabled = false; });
    }

    _grade(grade) {
      if (!this.flipLock || !this.flipLock.canGrade(Date.now())) return; // 未翻面/锁内
      const entry = this.queue[this.index];
      const before = Object.assign({}, entry); // 撤销快照
      this._gradeBtnsDisabled(true);
      AiduDictionaryService.srsGrade(this.profileId, entry.lemma, grade).then((r) => {
        if (!r.ok) {
          AiduToast.show('评分失败: ' + r.error, 'error');
          this._gradeBtnsDisabled(false);
          return;
        }
        // 撤销栈: 3 秒可撤销 (core 判定窗口, 这里用绝对时间)
        this.undoStack.push({ entry, before }, Date.now());
        this.done++;
        this.index++;
        this.flipLock.next();
        this._armUndo();
        this._renderCurrent();
        this._renderQueueSummary({ counts: this._lastCounts });
      });
    }

    _gradeBtnsDisabled(v) {
      this.gradeBtns.forEach((b) => { b.disabled = v; });
    }

    _armUndo() {
      if (this._undoTimer) clearTimeout(this._undoTimer);
      // 3 秒后撤销入口失效 (core.UNDO_WINDOW_MS)
      const bar = el('div', 'review-undo-bar', '撤销评分');
      bar.onclick = () => this._undo();
      this.cardCol.appendChild(bar);
      this._undoBar = bar;
      this._undoTimer = setTimeout(() => {
        if (this._undoBar && this._undoBar.parentNode) this._undoBar.parentNode.removeChild(this._undoBar);
        this._undoTimer = null;
      }, global.AiduReviewCore.UNDO_WINDOW_MS);
    }

    _undo() {
      const top = this.undoStack.undo(Date.now());
      if (!top) return;
      // 恢复评分前快照
      AiduDictionaryService.srsRestore(this.profileId, top.before).then((r) => {
        if (!r.ok) { AiduToast.show('撤销失败: ' + r.error, 'error'); return; }
        if (this.index > 0) this.index--;
        this.done = Math.max(0, this.done - 1);
        // 把原词放回队首 (替换当前位)
        if (this.queue.length > this.index) this.queue[this.index] = top.entry;
        else this.queue.push(top.entry);
        this.flipLock.next();
        if (this._undoBar && this._undoBar.parentNode) this._undoBar.parentNode.removeChild(this._undoBar);
        this._renderCurrent();
      });
    }

    _skip() {
      // S 跳过: 移到队尾, 不进队列计数
      const entry = this.queue[this.index];
      this.queue.splice(this.index, 1);
      this.queue.push(entry);
      this.flipLock.next();
      this._renderCurrent();
    }

    _edit() {
      const entry = this.queue[this.index];
      const input = document.createElement('input');
      input.type = 'text';
      input.value = entry.meaning || '';
      // 极简编辑: 复用 modal (E 编辑释义)
      const m = global.AiduModal.confirm({
        title: `编辑释义: ${entry.word}`,
        message: '输入新的释义 (仅本地生词本, 同步最小集里会带上)',
        confirmText: '保存',
        onConfirm: () => {
          const v = input.value;
          const updated = Object.assign({}, entry, { meaning: v });
          return AiduDictionaryService.srsRestore(this.profileId, updated).then((r) => {
            if (r.ok) {
              this.queue[this.index] = updated;
              this._renderCurrent();
              AiduToast.show('释义已更新', 'success');
            } else {
              AiduToast.show('保存失败: ' + r.error, 'error');
            }
            return r;
          });
        },
      });
      // 把输入框塞进 modal message
      const msg = m.box && m.box.querySelector('.modal-message');
      if (msg) { msg.textContent = ''; msg.appendChild(input); input.focus(); }
    }

    cleanup() {
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey);
        this._onKey = null;
      }
      if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    }
  }

  global.ReviewView = ReviewView;
})(window);
