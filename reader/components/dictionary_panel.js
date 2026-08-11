/**
 * components/dictionary_panel.js —— 词典面板 (I-A)
 * 右侧滑出: 词/词性/音标/释义/例句/上下文 + 发音 + 加入生词本
 */
(function (global) {
  'use strict';

  class DictionaryPanel {
    constructor() {
      this.el = null;
      this.onClose = null;
      this.onVocabAdded = null;
    }

    show(word, profileId, context, source) {
      if (!this.el) this._build();
      document.body.appendChild(this.el);
      this._setLoading(word);
      this._word = word;
      this._profileId = profileId;
      this._context = context;
      this._source = source || null; // V4: { editionId, chapterIndex, sentenceIndex }
      requestAnimationFrame(() => this.el.classList.add('open'));
      this._lookup();
    }

    /** 查词 (苹果级: 失败可重试, 加载中禁用操作) */
    _lookup() {
      this._setLoading(this._word);
      AiduDictionaryService.lookup(this._word, this._profileId, this._context).then((res) => {
        if (!res.ok) { this._setError(res.error); return; }
        this._render(res.data);
      });
    }

    hide() {
      if (this.el) {
        this.el.classList.remove('open');
        setTimeout(() => this.el.remove(), 200);
      }
    }

    _build() {
      const el = document.createElement('div');
      el.className = 'dict-panel';
      el.innerHTML = `
        <div class="dict-header">
          <button class="btn-small dict-close">✕</button>
        </div>
        <div class="dict-body"></div>
      `;
      el.querySelector('.dict-close').onclick = () => this.hide();
      el.addEventListener('click', (e) => { if (e.target === el) this.hide(); });
      this.el = el;
      this.body = el.querySelector('.dict-body');
    }

    _setLoading(word) {
      this.body.innerHTML = `<div class="dict-word">${word}</div><div class="dict-loading">查词中…</div>`;
    }

    _setError(msg) {
      // 苹果级: 失败可恢复 (重试按钮)
      this.body.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'dict-error';
      err.textContent = msg || '查词失败, 本地与 AI 均未找到释义';
      const retry = document.createElement('button');
      retry.className = 'btn-small';
      retry.textContent = '重试';
      retry.onclick = () => this._lookup();
      this.body.append(err, retry);
    }

    _render(d) {
      const parts = [];
      const wordRow = document.createElement('div');
      wordRow.className = 'dict-word';
      wordRow.textContent = d.word;
      if (d.phonetic) {
        const ph = document.createElement('span');
        ph.className = 'dict-phonetic';
        ph.textContent = d.phonetic;
        wordRow.appendChild(ph);
      }
      const speak = document.createElement('button');
      speak.className = 'btn-small';
      speak.textContent = '🔊 发音';
      speak.onclick = () => {
        const u = new SpeechSynthesisUtterance(d.word);
        u.lang = 'en-US';
        speechSynthesis.speak(u);
      };
      wordRow.appendChild(speak);
      parts.push(wordRow);

      const pos = document.createElement('div');
      pos.className = 'dict-pos';
      pos.textContent = d.pos || '—';
      parts.push(pos);

      const meanings = document.createElement('ul');
      meanings.className = 'dict-meanings';
      (d.meanings || []).forEach(m => {
        const li = document.createElement('li');
        li.textContent = m;
        meanings.appendChild(li);
      });
      parts.push(meanings);

      // 详细解释 (本地 LLM): 例句 + 翻译 + 用法 + 搭配
      if (d.examples && d.examples.length) {
        const ex = document.createElement('div');
        ex.className = 'dict-examples';
        ex.textContent = '例句: ' + d.examples[0];
        if (d.example_zh && d.example_zh[0]) {
          const zh = document.createElement('div');
          zh.className = 'dict-example-zh';
          zh.textContent = d.example_zh[0];
          ex.appendChild(zh);
        }
        parts.push(ex);
      }
      if (d.usage) {
        const usage = document.createElement('div');
        usage.className = 'dict-usage';
        usage.textContent = '用法: ' + d.usage;
        parts.push(usage);
      }
      if (d.phrases && d.phrases.length) {
        const ph = document.createElement('div');
        ph.className = 'dict-phrases';
        ph.textContent = '搭配: ' + d.phrases.join(' · ');
        parts.push(ph);
      }

      const src = document.createElement('div');
      src.className = 'dict-source';
      src.textContent = d.source === 'llm' ? '本地 AI 解释 (已存入本地词典, 不会自动加入生词本)' : '本地词典';
      parts.push(src);

      const addBtn = document.createElement('button');
      addBtn.className = 'btn-primary';
      addBtn.textContent = d.in_vocab ? '✓ 已在生词本' : '+ 加入生词本';
      addBtn.disabled = !!d.in_vocab;
      addBtn.onclick = () => {
        // 阶段6 设计交付 §04: 记录来源句上下文 (this._context = 原文句)
        // V4: 带来源定位 (edition/chapter/sentence)
        AiduDictionaryService.addToVocab(d.word, this._profileId, this._context, this._source).then((r) => {
          if (r.ok) {
            addBtn.textContent = '✓ 已加入生词本';
            addBtn.disabled = true;
            this.onVocabAdded && this.onVocabAdded(d.word);
            // H5 (2026-08-11): 入库侧词频门槛 —— 默认不拦、只提示 (把孩子真想学的词
            // 悄悄吃掉是更糟的; 成人自读档案用 top3000, 见后端 ADULT_COMMON_TOP_N)。
            if (r.data && r.data.common_word) {
              AiduToast.show('「' + d.word + '」是很常见的词, 确认要背它吗?', 'info');
            }
          } else {
            addBtn.textContent = '加入失败: ' + r.error;
          }
        });
      };
      parts.push(addBtn);

      this.body.innerHTML = '';
      parts.forEach(p => this.body.appendChild(p));
    }
  }

  global.DictionaryPanel = DictionaryPanel;
})(window);
