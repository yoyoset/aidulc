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
      // E (2026-08-11): 今日队列渲染上限 + 超出折叠 —— 队列是"今天要背的", 到期复习
      // 不封顶时可能上千行, 不该一次全铺开。默认折叠到 50 行, 点「还有 N 词」展开全部。
      this._queueExpanded = false;
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
      // H4 (2026-08-11): 今日队列可见的每日上限 + 「剩余 N 词顺延到明天」。
      // 存量打散后 dueCount ≤ 每日上限; 若仍超限 (还没打散 / 新到期积累), 明确说
      // 有多少词会顺延, 而不是让用户面对 1291 词 323 分钟一头雾水。
      this.queueCol.innerHTML = '';
      this.queueCol.append(head, progress, chips, estEl);
      if (q.dueCount > this.dailyCap()) {
        const deferred = q.dueCount - this.dailyCap();
        const warn = el('div', 'review-cap-warn', `到期 ${q.dueCount} 词, 超过每日上限 ${this.dailyCap()} —— ${deferred} 词将顺延到后续日期。可在生词本「打散存量到期」摊开。`);
        this.queueCol.appendChild(warn);
      }
      this._queueList = el('div', 'review-queue-list');
      this.queueCol.appendChild(this._queueList);
    }

    /** H4: 每日可承受量 (与生词本打散按钮的 daily_cap 一致, 单一数字来源) */
    dailyCap() { return 40; }

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
      const meta = el('div', 'review-source-meta', entry.context ? '来源句' : '未记录来源');
      head.appendChild(meta);
      this.sourceCol.appendChild(head);

      // V4 (2026-08-09): 来源定位 —— edition_id 命中译本 → 《书名》·第 N 章 · M 处出现 + 跳转
      const hasLoc = entry.edition_id && entry.chapter_index != null && entry.sentence_index != null;
      if (hasLoc) {
        const locEl = el('div', 'review-source-loc', '');
        const titleEl = el('span', 'review-source-book', '《…》');
        locEl.appendChild(titleEl);
        const line2 = el('div', 'review-source-meta', '');
        line2.textContent = `第 ${entry.chapter_index + 1} 章 · 第 ${entry.sentence_index + 1} 处出现`;
        locEl.appendChild(line2);
        const openBtn = el('button', 'btn-small', '在阅读器中打开');
        openBtn.onclick = () => this._openInReader(entry);
        locEl.appendChild(openBtn);
        this.sourceCol.appendChild(locEl);
        // 异步补书名 (查不到 → 降级显示 id)
        if (global.AiduLibraryService) {
          AiduLibraryService.editionLookup(entry.edition_id).then((r) => {
            if (r.ok && r.data && r.data.title) titleEl.textContent = `《${r.data.title}》`;
            else titleEl.textContent = `《${entry.edition_id}》`;
          });
        }
      }
      if (entry.context) {
        const s = el('div', 'review-source-sentence', String(entry.context));
        this.sourceCol.appendChild(s);
      } else {
        this.sourceCol.appendChild(el('div', 'review-source-empty', '这个词加入时没有记录原文句。'));
      }
    }

    /** V4: 在阅读器中打开 —— 回书库路由读这本书, 跳到记录的位置 */
    _openInReader(entry) {
      if (this.onOpenInReader) {
        this.onOpenInReader(entry);
        return;
      }
      // 兜底: 直接走 store + 路由 (main.js 会绑定 onOpenInReader 更完整)
      if (global.AiduStore && global.AiduRouter) {
        AiduStore.set({ currentBook: { id: entry.edition_id, title: entry.edition_id } });
        AiduStore.set({ readerBackRoute: 'review' });
        // 让阅读器打开后跳到 chapter/sentence
        AiduStore.set({ vocabJump: {
          chapter: entry.chapter_index,
          sentence: entry.sentence_index,
        } });
        // 触发路由
        window.location.hash = '#/reader';
      }
    }

    _renderQueueList() {
      if (!this._queueList) return;
      this._queueList.innerHTML = '';
      const total = this.queue.length;
      const CAP = 50;
      const show = this._queueExpanded ? total : Math.min(CAP, total);
      for (let i = 0; i < show; i++) {
        const e = this.queue[i];
        const row = el('div', 'review-qrow' + (i === this.index ? ' current' : '') + (i < this.index ? ' done' : ''));
        row.appendChild(el('span', 'review-qword', e.word));
        row.appendChild(el('span', 'review-qstage', STAGE_LABEL[e.stage] || e.stage));
        if (i < this.index) row.appendChild(el('span', 'review-qdone', '✓'));
        this._queueList.appendChild(row);
      }
      // E: 超出上限 → 折叠, 点开才铺全量 (today 队列不该把 1424 行一次铺开)
      if (!this._queueExpanded && total > CAP) {
        const more = el('button', 'review-qmore', `还有 ${total - CAP} 词已折叠 · 点此展开`);
        more.onclick = () => {
          this._queueExpanded = true;
          this._renderQueueList();
        };
        this._queueList.appendChild(more);
      }
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
        this._renderCurrent(); // 先渲染下一张 (会清空 cardCol)
        this._armUndo();       // 再挂撤销条 (3 秒窗口), 否则被 renderCurrent 清掉
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
