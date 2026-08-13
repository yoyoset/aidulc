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
      this._bindDocClick();
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
      this._unbindDocClick();
    }

    /** UX6 #4 (2026-08-13): 点正文 (面板外) 自动收起 —— document 级 click 监听。
     * 点 `dict-panel` 之内 (发音/加词/在线按钮) 不收起; 点正文的**词** (`.bubble`)
     * 不收起 (那是查词入口, 由 `_onWordClick` 刷新面板内容); 点正文空白/非词处收起。
     */
    _bindDocClick() {
      if (this._docClickBound) return;
      this._docClickBound = true;
      this._onDocClick = (e) => {
        const t = e.target;
        if (!this.el || !this.el.isConnected && !this.el.parentNode) return;
        if (!this.el.classList.contains('open')) return;
        if (this.el.contains(t)) return; // 面板内按钮/内容 → 不收起
        // 点正文的词 → 是查词入口, 不收起 (面板已由 _onWordClick 刷新)
        if (t && t.closest && t.closest('.bubble')) return;
        this.hide();
      };
      document.addEventListener('click', this._onDocClick);
    }

    _unbindDocClick() {
      if (this._docClickBound && this._onDocClick) {
        document.removeEventListener('click', this._onDocClick);
        this._docClickBound = false;
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
      this.body.append(err);

      const retry = document.createElement('button');
      retry.className = 'btn-small';
      retry.textContent = '重试本地';
      retry.onclick = () => this._lookup();
      this.body.appendChild(retry);

      // L8 (2026-08-11): 「用在线 AI 查一次」出口只在用户开启①时才出现 ——
      // 关闭时查词失败面板不提供在线入口 (发不出去的东西不该有按钮)。
      // 先查在线引擎配置, 再决定是否挂这个按钮。
      if (global.AiduMiscService && AiduMiscService.onlineConfigGet) {
        AiduMiscService.onlineConfigGet().then((res) => {
          const enabled = res && res.ok && res.data && res.data.lookup_enabled;
          if (enabled) this._appendOnlineLookup();
        }).catch(() => { /* 查配置失败 = 不提供在线入口 */ });
      }
    }

    /** K3: 查词失败 → 就地「用在线 AI 查一次」(仅 L8 开关①开启时被调用)。
     *  发前明确显示"将发送: word + 该句" (外发内容可见, 不做一揽子授权)。 */
    _appendOnlineLookup() {
      const onlineBtn = document.createElement('button');
      onlineBtn.className = 'btn-small';
      onlineBtn.textContent = '用在线 AI 查一次';
      onlineBtn.onclick = () => {
        const before = this.body.querySelector('.dict-online-send');
        const confirm = document.createElement('div');
        confirm.className = 'dict-online-send';
        confirm.textContent = '将发送: ' + this._word + (this._context ? ' + 「' + String(this._context).slice(0, 60) + '」' : '') + ' 到在线引擎 (你配置的 endpoint)';
        const go = document.createElement('button');
        go.className = 'btn-small';
        go.textContent = '确认发送';
        go.onclick = () => {
          this.body.innerHTML = `<div class="dict-word">${this._word}</div><div class="dict-loading">在线查词中…</div>`;
          AiduDictionaryService.lookupOnline(this._word, this._context).then((r) => {
            if (!r.ok) { this._setOnlineError(r.error); return; }
            this._render({ word: this._word, pos: r.data[0], phonetic: r.data[1], meanings: r.data[2], examples: r.data[3], example_zh: r.data[4], usage: r.data[5], phrases: r.data[6] });
          });
        };
        if (before) before.remove();
        confirm.appendChild(go);
        this.body.appendChild(confirm);
      };
      this.body.appendChild(onlineBtn);
    }

    /** K3: 在线查词也失败 → 区分"没配置"与"配置了但失败" */
    _setOnlineError(msg) {
      this.body.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'dict-error';
      err.textContent = msg || '在线查词失败';
      this.body.appendChild(err);
      const isUnconfigured = /未配置/.test(msg || '');
      const btn = document.createElement('button');
      btn.className = 'btn-small';
      btn.textContent = isUnconfigured ? '去设置配置在线引擎' : '再试一次';
      btn.onclick = () => {
        if (isUnconfigured) {
          // 设置页"在线引擎"区块 (K3 配置入口)
          window.location.hash = '#/settings';
        } else {
          this._lookup();
        }
      };
      this.body.appendChild(btn);
    }

    _render(d) {
      // K3 (2026-08-11): 本地查词失败 → 面板就地给出「用在线 AI 查一次」出口。
      // 失败特征: meanings 第一条以"词义查询失败"或"词义待补充"开头 (K1 上屏的真实原因)。
      // 绝不自动回退 —— 必须用户点一下才外发。
      const failed = (d.meanings || []).some((m) =>
        /词义查询失败|词义待补充/.test(m));
      if (failed) {
        this._setError((d.meanings || [])[0] || '查词失败');
        return;
      }
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

      // UX6 #4 (2026-08-13): 长面板治理 —— 释义/例句/用法/搭配分段, 每段带标题 + 可折叠。
      // 段首给中文标签 (用户之前看到一长串不知道该是什么), 过长段落点击标题可收。
      const sec = (label, contentEl) => {
        const wrap = document.createElement('div');
        wrap.className = 'dict-sec';
        const head = document.createElement('button');
        head.className = 'dict-sec-head';
        head.textContent = label;
        head.setAttribute('aria-expanded', 'true');
        const body = document.createElement('div');
        body.className = 'dict-sec-body';
        body.appendChild(contentEl);
        head.onclick = () => {
          const collapsed = body.classList.toggle('dict-sec-collapsed');
          head.setAttribute('aria-expanded', String(!collapsed));
          head.classList.toggle('dict-sec-closed', collapsed);
        };
        wrap.append(head, body);
        return wrap;
      };

      const meanings = document.createElement('ul');
      meanings.className = 'dict-meanings';
      (d.meanings || []).forEach(m => {
        const li = document.createElement('li');
        li.textContent = m;
        meanings.appendChild(li);
      });
      parts.push(sec('释义', meanings));

      // 详细解释 (本地 LLM): 例句 + 翻译 + 用法 + 搭配
      if (d.examples && d.examples.length) {
        const ex = document.createElement('div');
        ex.className = 'dict-examples';
        ex.textContent = d.examples[0];
        if (d.example_zh && d.example_zh[0]) {
          const zh = document.createElement('div');
          zh.className = 'dict-example-zh';
          zh.textContent = d.example_zh[0];
          ex.appendChild(zh);
        }
        parts.push(sec('例句', ex));
      }
      if (d.usage) {
        const usage = document.createElement('div');
        usage.className = 'dict-usage';
        usage.textContent = d.usage;
        parts.push(sec('用法', usage));
      }
      if (d.phrases && d.phrases.length) {
        const ph = document.createElement('div');
        ph.className = 'dict-phrases';
        ph.textContent = d.phrases.join(' · ');
        parts.push(sec('搭配', ph));
      }

      // UX6 #4: 底部讲清楚 —— 这不是查询历史, 是这个词的来源说明 + 加词动作。
      const src = document.createElement('div');
      src.className = 'dict-source';
      src.textContent = d.source === 'llm'
        ? '以上为本词详情: 释义/例句/用法/搭配 (不是查询历史)。已存入本地词典, 不会自动加入生词本。'
        : '以上为本词详情: 释义/例句/用法/搭配 (不是查询历史)。来源: 本地词典。';
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
