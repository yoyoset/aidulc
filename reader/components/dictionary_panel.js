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
      if (this.onClose) this.onClose();
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

      // 2026-09-04 (用户: "没有拉起来给我检查或者重置的按钮"): 先强制重置词典守护
      // 进程(杀掉可能挂死/卡住的旧进程)再重新查词——不再是"重试"这种可能原地
      // 撞同一个死进程的模糊语义, 点一下就是"真的重来一次"。
      const retry = document.createElement('button');
      retry.className = 'btn-small';
      retry.textContent = '重置本地模型并重试';
      retry.onclick = () => {
        retry.disabled = true;
        retry.textContent = '重置中…';
        Promise.resolve(AiduDictionaryService.dictDaemonReset()).catch(() => {}).then(() => this._lookup());
      };
      this.body.appendChild(retry);

      // 2026-09-04 (用户: "如果模型占用了应该是可以通过点击修复"): 查词失败时也
      // 顺带查一次显卡占用——最常见的"模型没拉起来"根因是显卡被外部进程(如用户
      // 自己起的 llama-server.exe)占着, 之前这个检测只接在"打开书"流程,
      // 查词失败面板看不到、也点不到"关掉它"。
      this._maybeAppendGpuFix();
      this._maybeAppendOnlineLookup();
    }

    /** 查词失败时顺带检测显卡占用, 命中就给"关闭占用进程并重试"——逻辑抄
     *  reader_view.js::_maybeWarnGpuOccupied, 只是这里不弹确认框(用户已经在
     *  处理一次失败, 面板内联按钮比再弹一层模态更顺手), 点击后立即执行。 */
    _maybeAppendGpuFix() {
      if (typeof AiduMiscService === 'undefined' || !AiduMiscService.gpuStatus) return;
      AiduMiscService.gpuStatus().then((res) => {
        if (!res.ok || !res.data) return;
        const status = res.data;
        const procs = status.foreignProcesses || [];
        if (!status.shouldWarn || !procs.length) return;
        const names = procs.map((p) => p.name.split(/[\\/]/).pop()).join('、');
        const freeGb = (status.freeMb / 1024).toFixed(1);
        const hint = document.createElement('div');
        hint.className = 'dict-error';
        hint.textContent = `检测到显卡剩余显存只有 ${freeGb}GB, ${names} 正占着显卡, 本地模型可能因此拉不起来。`;
        this.body.appendChild(hint);
        const fixBtn = document.createElement('button');
        fixBtn.className = 'btn-small';
        fixBtn.textContent = '关闭占用进程并重试';
        fixBtn.onclick = () => {
          fixBtn.disabled = true;
          fixBtn.textContent = '处理中…';
          Promise.all(procs.map((p) => AiduMiscService.gpuKillProcess(p.pid).catch(() => {})))
            .then(() => AiduDictionaryService.dictDaemonReset().catch(() => {}))
            .then(() => this._lookup());
        };
        this.body.appendChild(fixBtn);
      }).catch(() => { /* 查显卡状态失败 = 不提供这个入口, 不拦其它恢复路径 */ });
    }

    /** L8 (2026-08-11) + 2026-08-21 改: 「用在线 AI 查一次」出口只在用户开启①时
     *  才出现——关闭时不提供在线入口 (发不出去的东西不该有按钮)。之前只有查词
     *  彻底失败才会调这个检查; 现在成功渲染完(不管命中基底还是本地小模型)也
     *  调一次, 让"本地给了答案、我还是不确定"这种情况也能点到在线兜底, 不必
     *  等到彻底查不到才看得见这个入口。 */
    _maybeAppendOnlineLookup() {
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
            // K13 (2026-08-14): source='online' 让 _render 里的置信度徽章显示"在线 AI 生成"
            this._render({ word: this._word, pos: r.data[0], phonetic: r.data[1], meanings: r.data[2], examples: r.data[3], example_zh: r.data[4], usage: r.data[5], phrases: r.data[6], source: 'online' });
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
      // K13 (2026-08-14): 释义来源徽章——之前 confidence/source 字段后端存了、传了,
      // 前端就是没渲染。用户看一条释义分不清是词典查到的还是 AI 现编的, 对英语学习
      // 场景这个区分不是锦上添花(AI 生成偶尔会有错, 该多留一个心眼)。
      const SOURCE_LABEL = { local: '词典', base: '词典基底', llm: 'AI 生成', online: '在线 AI 生成' };
      if (d.source && SOURCE_LABEL[d.source]) {
        const src = document.createElement('span');
        src.className = 'dict-source dict-source-' + d.source;
        src.textContent = SOURCE_LABEL[d.source];
        src.title = d.source === 'local' ? '本地词典查到的释义'
          : d.source === 'base' ? '词典基底(种子词典 + 大家查词积累), 瞬时且不占显卡'
          : '本地/在线 AI 生成的释义, 偶尔可能有误';
        wordRow.appendChild(src);
      }
      if (d.phonetic) {
        const ph = document.createElement('span');
        ph.className = 'dict-phonetic';
        ph.textContent = d.phonetic;
        wordRow.appendChild(ph);
      }
      const speak = document.createElement('button');
      // 2026-08-18 (用户): "发音去掉文字。直接喇叭就可以了。" —— 喇叭图标本身已经
      // 说清楚了, "发音"两个字在这一行里只是占地方 (那行还要放词/来源徽章/音标)。
      // 图标按钮必须补 aria-label + title, 否则读屏和悬停提示都没了。
      speak.className = 'btn-small dict-speak';
      speak.textContent = '🔊';
      speak.setAttribute('aria-label', '发音');
      speak.title = '发音';
      // K7 (2026-08-14): 之前直接调 speechSynthesis.speak() 没做可用性检测, 也没监听
      // error 事件——系统没装英文语音包或运行环境不支持时点击静默无反应, 用户分不清
      // 是没配置好还是点击没生效(CLAUDE.md 明确要优先排除的"后台失败但用户以为成功")。
      if (!global.speechSynthesis) {
        speak.disabled = true;
        speak.title = '当前环境不支持语音朗读';
        speak.setAttribute('aria-label', '发音 (当前环境不支持)');
      } else {
        speak.onclick = () => {
          const u = new SpeechSynthesisUtterance(d.word);
          u.lang = 'en-US';
          u.onerror = () => AiduToast.show('发音失败: 系统可能没有安装英文语音包', 'error');
          speechSynthesis.speak(u);
        };
      }
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

      // 2026-09-04 (用户: "不管它显示什么, 你都可以本地 AI 再点一下, 因为模型会有
      // 更新"): 不再只在基底命中(source==='base')时才出现——不管当前显示的是
      // 哪一层的结果, 都留一个常驻入口重新跑一次本地 LLM, 不置灰、不因为"已经有
      // 结果了"就收起来, 换了新模型也能拿这个按钮重查。
      const enrichBtn = document.createElement('button');
      enrichBtn.className = 'btn-small';
      enrichBtn.textContent = '用本地 AI 再查一次';
      enrichBtn.title = '结合当前这句话, 用本地模型重新生成一次释义/例句/用法(比如换了新模型之后)';
      enrichBtn.onclick = () => {
        enrichBtn.disabled = true;
        enrichBtn.textContent = '生成中…';
        AiduDictionaryService.lookup(this._word, this._profileId, this._context, true).then((res) => {
          if (!res.ok) {
            enrichBtn.disabled = false;
            enrichBtn.textContent = '用本地 AI 再查一次';
            AiduToast.show(res.error || '生成失败', 'error');
            return;
          }
          this._render(res.data);
        });
      };
      parts.push(enrichBtn);

      // 2026-09-04 (用户: "查完的...确认，然后返回给词典里"): 在线查词只展示不落库
      // (word_lookup_online 头注释), 这里给一个显式确认动作——只写这个人自己的
      // 词典缓存, 不碰共享的词典基底(设计决定见 dictionary_service::persist_online)。
      if (d.source === 'online') {
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-small';
        saveBtn.textContent = '存入我的词典';
        saveBtn.title = '把这次在线 AI 的结果存进你自己的词典缓存(不影响其他人/其他档案看到的默认答案)';
        saveBtn.onclick = () => {
          saveBtn.disabled = true;
          saveBtn.textContent = '存入中…';
          AiduDictionaryService.confirmOnlineSave(this._word, this._profileId, d).then((res) => {
            if (!res.ok) {
              saveBtn.disabled = false;
              saveBtn.textContent = '存入我的词典';
              AiduToast.show(res.error || '存入失败', 'error');
              return;
            }
            saveBtn.textContent = '✓ 已存入我的词典';
          });
        };
        parts.push(saveBtn);
      }

      // UX6 #4: 底部讲清楚 —— 这不是查询历史, 是这个词的来源说明 + 加词动作。
      const src = document.createElement('div');
      src.className = 'dict-source';
      src.textContent = d.source === 'llm'
        ? '以上为本词详情: 释义/例句/用法/搭配 (不是查询历史)。已存入本地词典, 不会自动加入生词本。'
        : d.source === 'base'
        ? '以上为本词详情 (不是查询历史)。来源: 词典基底(种子词典 + 大家查词积累)。'
        : d.source === 'online'
        ? '以上为本词详情 (不是查询历史)。来源: 在线 AI, 尚未存入词典——点上面「存入我的词典」才会留下。'
        : '以上为本词详情: 释义/例句/用法/搭配 (不是查询历史)。来源: 本地词典。';
      parts.push(src);

      const addBtn = document.createElement('button');
      addBtn.className = 'btn-primary';
      addBtn.textContent = d.in_vocab ? '✓ 已在生词本' : '+ 加入生词本';
      addBtn.disabled = !!d.in_vocab;
      addBtn.onclick = () => {
        // 阶段6 设计交付 §04: 记录来源句上下文 (this._context = 原文句)
        // V4: 带来源定位 (edition/chapter/sentence)
        // K21 (2026-08-14): profileId 这里仍传"这本书挂的讲解档案"(add_to_vocab 后端要用它
        // 查词典缓存, 不同档案讲解深浅不同); 生词本本身该不该跟着档案分裂是后端内部关注点,
        // dictionary_service.rs::add_to_vocab 已经改成只对 VocabRepo 调用强制用固定的
        // VOCAB_PROFILE_ID, 这层不用管。
        AiduDictionaryService.addToVocab(d.word, this._profileId, this._context, this._source).then((r) => {
          if (r.ok) {
            addBtn.textContent = '✓ 已加入生词本';
            addBtn.disabled = true;
            this.onVocabAdded && this.onVocabAdded(d.word);
            // K32 (2026-08-15): fire-and-forget 后台预生成发音缓存, 不 await 不阻塞加词流程
            AiduDictionaryService.ttsCacheWord(d.word).catch(() => {});
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
      // 2026-08-21: 成功渲染完也检查一次在线入口(见 _maybeAppendOnlineLookup 注释)。
      this._maybeAppendOnlineLookup();
    }
  }

  global.DictionaryPanel = DictionaryPanel;
})(window);
