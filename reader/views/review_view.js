/**
 * views/review_view.js —— 专注模式: 单卡复习 (UX5 #2, 2026-08-13)
 * 去三栏 grid, 改一张独立卡片: 正面 = 词 + 音标 + 原文语境入卡; 背面 = 释义 + 来源定位。
 * 背景遮罩 + 卡片悬浮 (backdrop-filter 模糊); 两个语音按钮: 正常速度 / 慢速
 * (桌面: 词条带来源 → 走阅读器音频管线读原句, 慢速 playbackRate 0.75;
 *  无音频/加载失败 → 降级 speechSynthesis (系统级, 慢速 rate 0.6))。
 * SPACE 翻面、1-4 评分、S 跳过、E 编辑; 翻面单向; 评分 3 秒可撤销。
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
  // 慢速档位: 桌面音频 playbackRate 0.75; speechSynthesis (系统级) 0.6
  const DESKTOP_SLOW_RATE = 0.75;
  const MOBILE_SLOW_RATE = 0.6;

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
      // UX5 #2: 语音
      this._voiceBtns = [];
      this._audioEl = null;
      this._audioUrl = null;
      this._audioGen = 0;
      this._playingBtn = null;
    }

    render(container) {
      container.innerHTML = '';
      this._container = container;
      const wrap = el('div', 'review-view');
      // UX5 #2: 背景遮罩 + 模糊层 (卡片悬浮感)
      const backdrop = el('div', 'review-backdrop');
      wrap.appendChild(backdrop);
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '今日复习'));
      // H1 (2026-08-11): 专注模式退出 —— Esc 退出且进度保留。
      const exitBtn = el('button', 'btn-small', '退出复习');
      exitBtn.title = 'Esc 退出 (进度保留, 今天背过的不会重排)';
      exitBtn.onclick = () => this._exit();
      header.appendChild(exitBtn);
      wrap.appendChild(header);
      // UX5 #2: 单卡舞台 (取代三栏 grid)
      const stage = el('div', 'review-stage');
      this.stage = stage;
      wrap.appendChild(stage);
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
      this._renderSummary(q);
      this._renderCurrent();
      this._bindKeys();
    }

    /** UX5 #2: 紧凑进度行 (去三栏后的队列信息收进一行) */
    _renderSummary(q) {
      if (!this.stage) return;
      const c = (q && q.counts) || this._lastCounts || {};
      if (q && q.dueCount != null) this._dueCount = q.dueCount;
      const sum = el('div', 'review-summary');
      const meta = el('span', 'review-summary-meta',
        `${this.done} / ${this.queue.length} · 复习 ${c.review || 0} · 学习中 ${c.learning || 0} · 新词 ${c.new || 0}`);
      sum.appendChild(meta);
      this._summaryEl = sum;
      // 每日上限顺延提示 (H4 语义保留)
      if ((this._dueCount || 0) > this.dailyCap()) {
        const deferred = this._dueCount - this.dailyCap();
        sum.appendChild(el('span', 'review-cap-warn',
          `到期 ${this._dueCount} 词, 超每日上限 ${this.dailyCap()} —— ${deferred} 词顺延到后续日期`));
      }
    }

    /** H4: 每日可承受量 (与生词本打散按钮的 daily_cap 一致, 单一数字来源) */
    dailyCap() { return 40; }

    _renderCurrent() {
      if (this.index >= this.queue.length) {
        this._renderDone();
        return;
      }
      const entry = this.queue[this.index];
      if (this.stage) this.stage.innerHTML = '';
      const card = el('div', 'review-card' + (this.flipLock.isFlipped() ? ' flipped' : ''));
      // 正面: 词 + 音标 + 原文语境入卡
      const front = el('div', 'review-card-face front');
      front.appendChild(el('div', 'review-word', entry.word));
      if (entry.phonetic) front.appendChild(el('div', 'review-phonetic', entry.phonetic));
      const ctxBlock = el('div', 'review-context-block');
      if (entry.context) {
        ctxBlock.appendChild(el('div', 'review-context-title', '原文语境'));
        ctxBlock.appendChild(el('div', 'review-context', String(entry.context)));
      } else {
        ctxBlock.appendChild(el('div', 'review-context-empty', '这个词加入时没有记录原文句。'));
      }
      front.appendChild(ctxBlock);
      front.appendChild(el('div', 'review-flip-hint', 'SPACE 翻面'));
      card.appendChild(front);
      // 背面: 释义 + 来源定位
      const back = el('div', 'review-card-face back');
      back.appendChild(el('div', 'review-word', entry.word));
      if (entry.phonetic) back.appendChild(el('div', 'review-phonetic', entry.phonetic));
      const meaning = el('div', 'review-meaning', entry.meaning || '—');
      back.appendChild(meaning);
      if (entry.pos) back.appendChild(el('div', 'review-pos', entry.pos));
      const locEl = this._buildSourceLoc(entry);
      if (locEl) back.appendChild(locEl);
      card.appendChild(back);

      // 撤销条占位常驻 (H2: 不位移, 只切 opacity)
      const undoSlot = el('div', 'review-undo-slot');
      const undoBar = el('div', 'review-undo-bar', '撤销评分 (Ctrl+Z / Backspace)');
      undoBar.onclick = () => this._undo();
      undoSlot.appendChild(undoBar);
      this._undoBar = undoBar;

      // UX5 #2: 两个语音按钮 (正常速度 / 慢速)
      const voiceRow = el('div', 'review-voice-row');
      this._voiceBtns = [];
      [['正常速度', false], ['慢速', true]].forEach(([label, slow]) => {
        const vb = el('button', 'review-voice-btn', label);
        vb.title = slow ? '慢速朗读 (0.75×)' : '正常速度朗读';
        vb.onclick = () => this._playVoice(slow, vb);
        this._voiceBtns.push(vb);
        voiceRow.appendChild(vb);
      });

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

      if (this.stage) {
        this._renderSummary();
        this.stage.append(card, undoSlot, voiceRow, gradeRow);
      }
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
    }

    /** UX5 #2: 来源定位块 (并入卡片背面) —— 《书名》·第 N 章 · 第 M 处 + 跳转。 */
    _buildSourceLoc(entry) {
      const hasLoc = entry.edition_id && entry.chapter_index != null && entry.sentence_index != null;
      if (!hasLoc) return null;
      const locEl = el('div', 'review-source-loc');
      const titleEl = el('span', 'review-source-book', '《…》');
      locEl.appendChild(titleEl);
      locEl.appendChild(el('div', 'review-source-meta',
        `第 ${entry.chapter_index + 1} 章 · 第 ${entry.sentence_index + 1} 处出现`));
      const openBtn = el('button', 'btn-small', '在阅读器中打开');
      openBtn.onclick = () => this._openInReader(entry);
      locEl.appendChild(openBtn);
      if (global.AiduLibraryService) {
        AiduLibraryService.editionLookup(entry.edition_id).then((r) => {
          if (r.ok && r.data && r.data.title) titleEl.textContent = `《${r.data.title}》`;
          else titleEl.textContent = `《${entry.edition_id}》`;
        });
      }
      return locEl;
    }

    /** UX5 #2: 语音播放 —— 桌面词条带来源 → 走阅读器音频管线读原句; 否则降级 speechSynthesis。 */
    async _playVoice(slow, btn) {
      const entry = this.queue[this.index];
      if (!entry) return;
      this._stopVoice();
      this._voiceBtns.forEach((b) => b.classList.remove('playing'));
      const hasLoc = entry.edition_id && entry.chapter_index != null && entry.sentence_index != null;
      if (hasLoc && global.AiduLibraryService) {
        try {
          const loaded = await this._loadSentenceAudio(entry);
          if (loaded) {
            btn.classList.add('playing');
            this._playingBtn = btn;
            const audio = loaded.audio;
            audio.playbackRate = slow ? DESKTOP_SLOW_RATE : 1.0;
            const done = () => {
              btn.classList.remove('playing');
              if (this._playingBtn === btn) this._playingBtn = null;
            };
            audio.onended = done;
            audio.onerror = done;
            audio.play().catch(done);
            return;
          }
        } catch (e) { /* 音频管线失败 → 降级 speechSynthesis */ }
      }
      this._speakWord(entry.word, slow ? MOBILE_SLOW_RATE : 1.0, btn);
    }

    /** 走阅读器音频管线: loadBookpack(basePath) + loadBookpackChapter + readAudioRange 分块读。 */
    async _loadSentenceAudio(entry) {
      this._audioGen++;
      const gen = this._audioGen;
      if (this._audioEl) { this._audioEl.pause(); this._audioEl.src = ''; this._audioEl = null; }
      if (this._audioUrl) { URL.revokeObjectURL(this._audioUrl); this._audioUrl = null; }
      const bp = await AiduLibraryService.loadBookpack(entry.edition_id);
      if (gen !== this._audioGen) return null;
      if (!bp.ok || !bp.data) return null;
      const basePath = bp.data.basePath;
      const ch = await AiduLibraryService.loadBookpackChapter(entry.edition_id, entry.chapter_index);
      if (gen !== this._audioGen) return null;
      if (!ch.ok || !ch.data) return null;
      const chapter = ch.data;
      const s = (chapter.sentences || [])[entry.sentence_index];
      if (!s || !s.audio || !chapter.audioFile) return null;
      const parts = [];
      let offset = 0;
      const CHUNK = 2 * 1024 * 1024;
      for (;;) {
        if (gen !== this._audioGen) return null;
        const r = await AiduLibraryService.readAudioRange(basePath, chapter.audioFile, offset, CHUNK);
        if (!r.ok) return null;
        const b64 = r.data && r.data.data_b64;
        if (!b64) return null;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        offset += r.data.read;
        if (r.data.end || r.data.read === 0) break;
      }
      const blob = new Blob(parts, { type: 'audio/ogg; codecs=opus' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.src = url;
      audio.load();
      await new Promise((res) => {
        audio.addEventListener('loadedmetadata', res, { once: true });
        audio.addEventListener('error', res, { once: true });
      });
      if (gen !== this._audioGen) { URL.revokeObjectURL(url); return null; }
      audio.currentTime = s.audio.start_ms / 1000;
      this._audioEl = audio;
      this._audioUrl = url;
      return { audio, url };
    }

    /** K29 (2026-08-14, 用户拍板): 没有来源句音频时的降级路径, 三级: ① 本地 TTS 常驻
     *  守护(与正文朗读同一引擎, 之前这里直接跳到③浏览器机械音)② 失败/未配置时退到
     *  speechSynthesis(手机/无 Tauri 环境的降级, 保留原样)。 */
    _speakWord(word, rate, btn) {
      btn.classList.add('playing');
      this._playingBtn = btn;
      const done = () => {
        btn.classList.remove('playing');
        if (this._playingBtn === btn) this._playingBtn = null;
      };
      const playB64 = (b64) => {
        const audio = new Audio('data:audio/wav;base64,' + b64);
        audio.playbackRate = rate;
        audio.onended = done;
        audio.onerror = () => this._speakWordFallback(word, rate, done);
        audio.play().catch(() => this._speakWordFallback(word, rate, done));
      };
      const trySynth = () => {
        if (global.AiduDictionaryService && AiduDictionaryService.ttsSynthWord) {
          AiduDictionaryService.ttsSynthWord(word).then((r) => {
            if (r.ok) playB64(r.data);
            else this._speakWordFallback(word, rate, done);
          });
        } else {
          this._speakWordFallback(word, rate, done);
        }
      };
      // K30 (2026-08-15): 来源句原声(更上层已优先) → 本地预生成缓存 → 现场合成 → 系统机械音。
      if (global.AiduDictionaryService && AiduDictionaryService.vocabReadCachedAudio) {
        AiduDictionaryService.vocabReadCachedAudio(word).then((r) => {
          if (r.ok && r.data) { playB64(r.data); return; }
          trySynth();
        });
        return;
      }
      trySynth();
    }

    /** 系统级 speechSynthesis, 只在本地 TTS 不可用时才走这里(手机/无 Tauri 环境)。 */
    _speakWordFallback(word, rate, done) {
      if (!('speechSynthesis' in window) || !window.speechSynthesis) { done(); return; }
      try {
        const u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-US';
        u.rate = rate;
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
      } catch (e) { done(); /* 无语音引擎静默 */ }
    }

    _stopVoice() {
      if (this._audioEl) {
        this._audioEl.onended = null;
        this._audioEl.onerror = null;
        this._audioEl.pause();
        this._audioEl.src = '';
        this._audioEl = null;
      }
      if (this._audioUrl) { URL.revokeObjectURL(this._audioUrl); this._audioUrl = null; }
      if ('speechSynthesis' in window && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
      }
      if (this._voiceBtns) this._voiceBtns.forEach((b) => b.classList.remove('playing'));
      this._playingBtn = null;
    }

    /** V4: 在阅读器中打开 —— 回书库路由读这本书, 跳到记录的位置 */
    _openInReader(entry) {
      if (this.onOpenInReader) {
        this.onOpenInReader(entry);
        return;
      }
      // 兜底: 直接走 store + 路由 (main.js 会绑定 onOpenInReader 更完整)
      // M2 (2026-08-12): 用 store 实例 (this.store) 而非 global.AiduStore (那是类, 没有 set)
      if (this.store) {
        this.store.set({ currentBook: { id: entry.edition_id, title: entry.edition_id } });
        this.store.set({ readerBackRoute: 'review' });
        // 让阅读器打开后跳到 chapter/sentence
        this.store.set({ vocabJump: {
          chapter: entry.chapter_index,
          sentence: entry.sentence_index,
        } });
        // 触发路由
        window.location.hash = '#/reader';
      }
    }

    _renderDone() {
      if (this.stage) this.stage.innerHTML = '';
      if (this.stage) {
        this.stage.appendChild(el('div', 'review-done',
          `今日队列完成 · 复习 ${this.done} 词`));
      }
      this.gradeBtns = [];
      this._stopVoice();
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey);
        this._onKey = null;
      }
      if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    }

    _bindKeys() {
      if (this._onKey) document.removeEventListener('keydown', this._onKey);
      this._onKey = (e) => {
        // H1: Esc 退出专注模式 (进度保留)
        if (e.key === 'Escape') { e.preventDefault(); this._exit(); return; }
        // H2: Ctrl+Z / Backspace 撤销 (不用鼠标的人根本不用看撤销条)
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); this._undo(); return; }
        if (e.key === 'Backspace') { e.preventDefault(); this._undo(); return; }
        const action = global.AiduReviewCore.keyAction(e);
        if (!action) return;
        if (action === 'flip') { e.preventDefault(); this._flip(); }
        else if (action.startsWith('grade')) { this._grade(Number(action.slice(5))); }
        else if (action === 'skip') { this._skip(); }
        else if (action === 'edit') { this._edit(); }
      };
      document.addEventListener('keydown', this._onKey);
    }

    /** H1: 退出专注模式 —— 进度保留 (今天背过的词 next_review 已推进, 重进不会重排) */
    _exit() {
      this.cleanup();
      if (this.onExit) this.onExit();
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
        this._renderCurrent(); // 先渲染下一张 (会清空 stage)
        this._armUndo();       // 再挂撤销条 (3 秒窗口), 否则被 renderCurrent 清掉
        this._renderSummary({ counts: this._lastCounts });
      });
    }

    _gradeBtnsDisabled(v) {
      this.gradeBtns.forEach((b) => { b.disabled = v; });
    }

    _armUndo() {
      if (this._undoTimer) clearTimeout(this._undoTimer);
      // H2: 撤销条占位常驻在卡片正上方 —— 不出现/不消失/不位移; 只切 opacity。
      // 3 秒窗口内 active (可点), 之后转灰 expired (失效)。键盘 Ctrl+Z/Backspace 直接撤。
      if (this._undoBar) {
        this._undoBar.classList.remove('expired');
        this._undoBar.classList.add('active');
      }
      this._undoTimer = setTimeout(() => {
        if (this._undoBar) {
          this._undoBar.classList.remove('active');
          this._undoBar.classList.add('expired');
        }
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
        if (this._undoBar) {
          this._undoBar.classList.remove('active', 'expired');
        }
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
      this._stopVoice();
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey);
        this._onKey = null;
      }
      if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = null; }
    }
  }

  global.ReviewView = ReviewView;
})(window);
