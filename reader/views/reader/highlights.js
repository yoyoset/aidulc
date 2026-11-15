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

  /** 2026-09-05 摘录关联生词: 从一段摘录原文里抠出英文单词 token(忽略标点/数字),
   *  给生词命中判断用。不做词形还原(lemma) —— 命中判断直接对生词本里 word 和
   *  lemma 两个字段都比对, 简单大小写不敏感包含即可覆盖大部分场景, 没必要在前端
   *  再引入一次词形还原逻辑(后端/prep 侧已经做过一次, 这里只是展示层提示)。 */
  function wordTokens(text) {
    return (text || '').match(/[A-Za-z']+/g) || [];
  }

  class ReaderHighlights {
    /**
     * @param {object} deps
     *   bookKey(): 当前书
     *   getChapterIndex(): 当前章
     *   getSentences(): 当前章句子
     *   onJump(sentenceIndex): 跳转到某句
     *   onChanged(): 摘录变化后重渲染标记
     *   getContainer(): 正文容器 DOM 节点(用于把"选区变化"限定在正文内, 见下方
     *     2026-09-05 交互模型重写的注释); 不传则退化为 document(仍然可用, 只是
     *     退回旧的全局判定范围)
     *   getProfileId(): 当前讲解档案 id(生词本按 profile 隔离, 摘录关联生词提示
     *     要用它去查 vocab_all); 不传则退化为 'default'
     */
    constructor(deps) {
      this.deps = deps;
      this.items = []; // 全书摘录 [{id, book_key, chapter, sentence_index, selected_text}]
      this._btn = null;
      this._panel = null;
      this._vocabSet = null; // 2026-09-05: 生词 word/lemma 小写集合, 摘录面板打开时惰性加载
      // 2026-09-05 自定义标签(取代固定三分类): attach() 时就加载, 而不是等打开
      // 面板才查——划句摘录成功后紧跟着弹出的"选标签"小下拉(见 _save())也要用到
      // 这份列表, 那一刻面板可能压根没开过。
      this._tagStore = new HighlightTagsStore(currentUser());
      this._onMouseUp = (e) => this._onSelection(e);
      this._onMouseDown = (e) => this._onClickAway(e);
      this._onScroll = () => this._hideButton();
    }

    _container() {
      const c = this.deps.getContainer && this.deps.getContainer();
      return c || document;
    }

    /** 2026-09-05: 惰性加载生词本(word+lemma 小写集合), 摘录面板打开时才查一次,
     *  不在每次渲染句子/摘录标记时都查——生词本可能有几百条, 没必要跟着阅读滚动
     *  反复拉取。 */
    async _loadVocabWords() {
      const profileId = this.deps.getProfileId ? this.deps.getProfileId() : 'default';
      const res = await global.AiduDictionaryService.vocabAll(profileId);
      const set = new Set();
      if (res && res.ok && Array.isArray(res.data)) {
        res.data.forEach((v) => {
          if (v.word) set.add(v.word.toLowerCase());
          if (v.lemma) set.add(v.lemma.toLowerCase());
        });
      }
      this._vocabSet = set;
    }

    /** 这段摘录原文里命中了生词本里哪些词(去重, 保留原文大小写用于展示) */
    _vocabHitsFor(selectedText) {
      if (!this._vocabSet || !this._vocabSet.size) return [];
      const seen = new Set();
      const hits = [];
      wordTokens(selectedText).forEach((w) => {
        const lower = w.toLowerCase();
        if (this._vocabSet.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          hits.push(w);
        }
      });
      return hits;
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

    /** 2026-09-05 交互模型重写(当天两次修——第一版有时序 bug, 教训见下): "显示"
     *  和"隐藏"两件事分开监听, 各自绑定在语义正确的事件上, 不再用一个全局
     *  mouseup 硬扛两份职责。两个监听都仍然挂在 document 上(不挂正文容器本身)——
     *  第一版把 mouseup 绑在 getContainer() 返回的节点上, 结果 attach() 是在
     *  render() 里、正文容器 appendChild 进真实 DOM **之前**调用的(见
     *  reader_view.js render() 里 attach() 和 container.appendChild(wrap) 的
     *  先后顺序), 那一刻 document.getElementById('reader-content') 还查不到
     *  节点、返回 null, `_container()` 静默退化成绑在 document 上——等于完全
     *  没生效, 退回最初"点摘录没反应"的 bug, 而且这版连"忽略按钮自身"的判断
     *  都被去掉了, 比修之前还差。教训: 不要在 attach() 那一刻把监听器绑死在某个
     *  具体节点引用上, 节点是否已经在活文档树里是运行时状态, 不是构造时状态；
     *  该在每次事件触发时现查 this._container(), 而不是在绑定时查一次存起来。
     *  - 显示: mouseup 监听器判断 e.target 是否落在当前 _container() 范围内
     *    (每次现查, 不缓存)——"摘录"按钮本体挂在 document.body 上、不在正文
     *    容器内, 点它产生的 mouseup 落在检查之外, 直接跳过, 不会重新判定选区、
     *    更不会把刚点的按钮换掉。
     *  - 隐藏: 另一个 mousedown 监听, 点击目标不在按钮内就隐藏。用 mousedown
     *    而不是 mouseup, 因为点击别处/开始新选区从 mousedown 那一刻起意图就
     *    明确了, 不用等 mouseup。 */
    attach() {
      document.addEventListener('mouseup', this._onMouseUp);
      document.addEventListener('mousedown', this._onMouseDown);
      document.addEventListener('scroll', this._onScroll, { passive: true });
      this._tagStore.load();
    }

    detach() {
      document.removeEventListener('mouseup', this._onMouseUp);
      document.removeEventListener('mousedown', this._onMouseDown);
      document.removeEventListener('scroll', this._onScroll);
      this._hideButton();
    }

    /** 点击目标不在"摘录"按钮内 → 隐藏(点按钮本身不受影响, 让 click 正常派发) */
    _onClickAway(e) {
      if (this._btn && e && e.target && this._btn.contains(e.target)) return;
      this._hideButton();
    }

    /** 选中正文文字 → 弹出"摘录"按钮。现查 _container(), 目标不在正文容器内
     *  (比如落在摘录按钮/面板/词典面板这些挂在 document.body 上的浮层)一律跳过——
     *  不判定选区、不动按钮。 */
    _onSelection(e) {
      const root = this._container();
      if (root !== document && e && e.target && !root.contains(e.target)) return;
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
        this._save(block, text, segRange, rect);
      };
      document.body.appendChild(btn);
      this._btn = btn;
    }

    _hideButton() {
      if (this._btn && this._btn.parentNode) this._btn.parentNode.removeChild(this._btn);
      this._btn = null;
    }

    _save(block, text, segRange, rect) {
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
        // 2026-09-05: 摘录这个动作本身仍然一键完成、不强制选标签(划句时停下来想
        // "这条算哪一类"是额外摩擦)。空串 = 未分类。保存成功后紧接着在原地弹出
        // 一个小标签选择器(_showCaptureTagPicker), 想马上分类的可以顺手选一下,
        // 不想理就点别处它自己收起来, 两种诉求都不挡。
        kind: '',
        created_at: now,
        updated_at: now,
      };
      AiduBridge.highlights.save(h).then((r) => {
        if (!r.ok) { this._hideButton(); AiduToast.show('摘录失败: ' + r.error, 'error'); return; }
        this.items.push(h);
        this._markBlock(block, h);
        this.deps.onChanged && this.deps.onChanged();
        AiduToast.show('已摘录', 'success');
        this._showCaptureTagPicker(rect, h);
      });
    }

    /** 2026-09-05: 摘录成功后原地弹出的小标签选择器——沿用"摘录"按钮同一个位置和
     *  同一套显示/隐藏机制(赋给 this._btn, 点别处/新选区会按原有逻辑自动收起),
     *  不是新开一套浮层管理。选了就存, 不选就是"未分类", 不强制。 */
    _showCaptureTagPicker(rect, h) {
      // 必须先摘掉原来的"摘录"按钮: 下面会把 this._btn 覆盖成 wrap, 不先移除的话
      // 旧按钮失去引用, 之后点别处/滚动/新选区的 _hideButton() 都够不着它,
      // 永远挂在页面上(2026-09-26 用户报"摘录完褐色按钮不消失")。
      this._hideButton();
      const wrap = document.createElement('div');
      wrap.className = 'hl-tool hl-capture-tag';
      wrap.style.top = (rect.bottom + 6) + 'px';
      wrap.style.left = rect.left + 'px';
      const label = document.createElement('span');
      label.textContent = '✓ 已摘录';
      const select = document.createElement('select');
      select.className = 'hl-kind-select';
      this._appendKindOptions(select, '');
      select.onclick = (e) => e.stopPropagation();
      select.onchange = (e) => {
        e.stopPropagation();
        const updated = { ...h, kind: select.value, updated_at: Date.now() };
        AiduBridge.highlights.save(updated).then((r) => {
          if (!r.ok) { AiduToast.show('标记失败: ' + r.error, 'error'); return; }
          const idx = this.items.findIndex((x) => x.id === h.id);
          if (idx >= 0) this.items[idx] = updated;
          this._hideButton();
        });
      };
      wrap.append(label, select);
      document.body.appendChild(wrap);
      this._btn = wrap;
    }

    /** <select> 填充"未分类" + 全部自定义标签选项, 单条摘录行和刚摘录完的
     *  小标签选择器共用这份逻辑, 不重复写两遍。 */
    _appendKindOptions(select, currentKind) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '未分类';
      if (!currentKind) noneOpt.selected = true;
      select.appendChild(noneOpt);
      this._tagStore.tags.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        if (currentKind === t.id) opt.selected = true;
        select.appendChild(opt);
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

    /** 全书摘录, 按 章/句序 排(可选关键词过滤: 命中原文或备注即算; 可选分类过滤) */
    _sortedItems(query, kindFilter) {
      const q = (query || '').trim().toLowerCase();
      let filtered = this.items;
      if (q) {
        filtered = filtered.filter((h) => (h.selected_text || '').toLowerCase().includes(q)
          || (h.note || '').toLowerCase().includes(q));
      }
      if (kindFilter && kindFilter !== 'all') {
        filtered = filtered.filter((h) => (h.kind || '') === kindFilter);
      }
      return filtered.slice().sort((a, b) => (a.chapter - b.chapter) || (a.sentence_index - b.sentence_index));
    }

    /** 单条摘录行(跳转/加备注/改分类/删除) —— 从 togglePanel 抽出来, 搜索过滤时要反复重建列表 */
    _buildRow(h, panel, list) {
      const row = document.createElement('div');
      row.className = 'hl-row';
      const meta = document.createElement('div');
      meta.className = 'hl-row-meta';
      meta.textContent = `第 ${h.chapter + 1} 章 · 句 ${h.sentence_index + 1}`;
      // 2026-09-05 自定义标签: 分类既是展示也是操作入口——<select> 本身用"有没有
      // 打标签"这一档底色渲染(具体是哪个标签不再逐个配色, 见 reader.css 里
      // .hl-kind-select 的注释), 选完即存, 不用另开编辑框。
      const kindSelect = document.createElement('select');
      kindSelect.className = 'hl-kind-select' + (h.kind ? ' hl-kind-tagged' : '');
      this._appendKindOptions(kindSelect, h.kind || '');
      kindSelect.onclick = (e) => e.stopPropagation();
      kindSelect.onchange = (e) => {
        e.stopPropagation();
        const nextKind = kindSelect.value;
        const updated = { ...h, kind: nextKind, updated_at: Date.now() };
        AiduBridge.highlights.save(updated).then((r) => {
          if (!r.ok) {
            AiduToast.show('标记失败: ' + r.error, 'error');
            kindSelect.value = h.kind || '';
            return;
          }
          const idx = this.items.findIndex((x) => x.id === h.id);
          if (idx >= 0) this.items[idx] = updated;
          h.kind = nextKind;
          kindSelect.className = 'hl-kind-select' + (nextKind ? ' hl-kind-tagged' : '');
        });
      };
      meta.appendChild(kindSelect);
      const txt = document.createElement('div');
      txt.className = 'hl-row-text';
      txt.textContent = h.selected_text;
      row.append(meta, txt);

      // 2026-09-05 摘录关联生词: 命中生词本才显示, 命中 0 个就什么都不加——
      // 大部分摘录跟生词无关, 常驻一行"0 个生词"是噪音。
      const vocabHits = this._vocabHitsFor(h.selected_text);
      if (vocabHits.length) {
        const vocabEl = document.createElement('div');
        vocabEl.className = 'hl-row-vocab';
        vocabEl.textContent = `含 ${vocabHits.length} 个生词: ${vocabHits.join(', ')}`;
        row.appendChild(vocabEl);
      }

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
        // 2026-09-05: 之前保存完备注是 panel.remove()+togglePanel() 整个重开面板——
        // 搜索词和分类筛选都会被重置成初始状态, 用户刚筛出一批要补备注的摘录,
        // 补完第一条整个筛选就没了。改成只重建列表内容(跟删除按钮同款), 保留输入框。
        this._editNote(h, noteBtn, () => {
          this._fillList(list, panel, this._searchInput ? this._searchInput.value : '');
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
          this.deps.onChanged && this.deps.onChanged();
          AiduToast.show('已删除摘录', 'info');
          this._fillList(list, panel, this._searchInput ? this._searchInput.value : '');
        });
      };
      row.appendChild(del);
      return row;
    }

    /** 按当前搜索词 + 分类筛选重建列表内容(不重建整个面板, 保留输入框焦点) */
    _fillList(list, panel, query) {
      list.innerHTML = '';
      const kindFilter = this._kindFilter ? this._kindFilter.value : 'all';
      const sorted = this._sortedItems(query, kindFilter);
      if (!sorted.length) {
        list.appendChild(Object.assign(document.createElement('div'), {
          className: 'hl-panel-empty',
          textContent: this.items.length
            ? '没有匹配的摘录/备注/分类。'
            : '这里列出全部笔记。阅读时选中一段文字, 点"摘录"保存, 会出现在这里。',
        }));
        return;
      }
      sorted.forEach((h) => list.appendChild(this._buildRow(h, panel, list)));
    }

    /** 2026-09-05: 标签删除时后端已经把引用它的摘录 kind 清成 ''(见
     *  highlights_repo.rs::clear_kind_for_tag), 这里把前端内存里的 this.items
     *  同步一遍——凡是 kind 不为空、但在当前标签列表里已经找不到的, 一律清空。
     *  真机测试(而非读代码)发现的问题: 漏了这步会让 _tagStore.labelFor() 的
     *  "找不到就返回'未分类'"兜底把一个已删除的标签 id 误当成"确实打了标签",
     *  展示/导出时凭空多出一个"未分类"方括号标签。 */
    _reconcileOrphanedTags() {
      const validIds = new Set(this._tagStore.tags.map((t) => t.id));
      this.items.forEach((h) => {
        if (h.kind && !validIds.has(h.kind)) h.kind = '';
      });
    }

    /** 分类筛选下拉的选项要跟着标签管理的增删改活——标签改名/删除后, 筛选下拉
     *  里对应的选项文案/存在与否都要刷新, 不重建整个面板。 */
    _rebuildKindFilterOptions() {
      if (!this._kindFilter) return;
      const prevValue = this._kindFilter.value;
      this._kindFilter.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = '全部分类';
      this._kindFilter.appendChild(allOpt);
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '未分类';
      this._kindFilter.appendChild(noneOpt);
      this._tagStore.tags.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        this._kindFilter.appendChild(opt);
      });
      // 之前选中的标签如果被删了, option 已经不在列表里, 浏览器会自动落回第一项
      // (全部分类)——这里显式尝试恢复, 恢复不了就顺其自然落回"全部分类"。
      this._kindFilter.value = prevValue;
    }

    /** 摘录面板 (命令面板入口): 列表/跳转/删除/搜索/标签管理/导出 */
    togglePanel() {
      if (this._panel && this._panel.parentNode) {
        this._panel.parentNode.removeChild(this._panel);
        this._panel = null; this._searchInput = null; this._kindFilter = null; this._tagManagerWrap = null;
        return;
      }
      const panel = document.createElement('div');
      panel.className = 'hl-panel';
      const head = document.createElement('div');
      head.className = 'hl-panel-head';
      const title = document.createElement('span');
      title.textContent = '摘录 (' + this.items.length + ')';
      const close = document.createElement('button');
      close.className = 'btn-small';
      close.textContent = '✕';
      close.setAttribute('aria-label', '关闭摘录面板');
      close.onclick = () => {
        panel.remove();
        this._searchInput = null; this._kindFilter = null; this._tagManagerWrap = null;
      };
      head.append(title, close);

      // K18 (2026-08-14): 唯一导出通道之前是整本 .aidu-data JSON 备份, 不是人可读
      // 笔记——"精读"这个产品定位下摘录笔记恰恰是最该能导出复习/分享的产出物。
      // 2026-09-05: 补 HTML/打印(存为 PDF), 跟"管理标签"一起放进单独一行工具条,
      // 免得挤在标题行(340px 宽的面板塞不下 5 个东西)。
      const actions = document.createElement('div');
      actions.className = 'hl-panel-actions';
      const mdBtn = document.createElement('button');
      mdBtn.className = 'btn-small';
      mdBtn.textContent = '导出 Markdown';
      mdBtn.onclick = (e) => { e.stopPropagation(); this._exportMarkdown(); };
      const htmlBtn = document.createElement('button');
      htmlBtn.className = 'btn-small';
      htmlBtn.textContent = '导出 HTML';
      htmlBtn.onclick = (e) => { e.stopPropagation(); this._exportHtml(); };
      const printBtn = document.createElement('button');
      printBtn.className = 'btn-small';
      printBtn.textContent = '打印 / 存为 PDF';
      printBtn.title = '打开系统打印对话框, 选"另存为 PDF"即可存成 PDF 文件(不是应用直接生成 PDF)';
      printBtn.onclick = (e) => { e.stopPropagation(); this._printExport(); };
      const tagMgrBtn = document.createElement('button');
      tagMgrBtn.className = 'btn-small';
      tagMgrBtn.textContent = '管理标签';
      tagMgrBtn.onclick = (e) => {
        e.stopPropagation();
        if (this._tagManagerWrap.hidden) {
          this._tagManagerWrap.hidden = false;
        } else {
          this._tagManagerWrap.hidden = true;
        }
      };
      actions.append(mdBtn, htmlBtn, printBtn, tagMgrBtn);

      // 2026-09-05: 标签管理面板默认折叠(打开摘录面板最常见的诉求是看/搜/跳转,
      // 不是管理标签), 点"管理标签"才展开。
      const tagManagerWrap = this._tagStore.renderManagerPanel(() => {
        // 删标签时后端会把引用它的摘录 kind 级联清空(highlights_repo.rs::
        // clear_kind_for_tag), 但前端这份 this.items 缓存不会跟着自动更新——
        // 之前这里漏了这一步, 真机测试时发现删标签后导出 Markdown 里出现
        // "**[未分类]**" 这种荒谬的方括号(orphan 的 tag id 传进
        // labelFor()、命中它"找不到就返回'未分类'"这条兜底, 被当成了一个
        // 真实存在的标签名)。这里主动清一遍, 跟后端已经做的事保持一致。
        this._reconcileOrphanedTags();
        this._rebuildKindFilterOptions();
        this._fillList(list, panel, this._searchInput ? this._searchInput.value : '');
      });
      tagManagerWrap.hidden = true;
      this._tagManagerWrap = tagManagerWrap;

      // 2026-09-05: 摘录一多(整本书精读下来几十上百条很常见)翻页找不如搜——
      // 命中原文或备注即算, 前端内存过滤, 全书摘录量级(几百条)完全不需要后端分页。
      // 分类筛选和搜索并列, 同一行——两者是"缩小范围"的两种手段, 不用分两处。
      const searchWrap = document.createElement('div');
      searchWrap.className = 'hl-panel-search';
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'hl-search-input';
      search.placeholder = '搜索摘录原文 / 备注…';
      search.oninput = () => this._fillList(list, panel, search.value);
      this._searchInput = search;

      const kindFilter = document.createElement('select');
      kindFilter.className = 'hl-kind-filter';
      this._kindFilter = kindFilter;
      this._rebuildKindFilterOptions();
      kindFilter.onchange = () => this._fillList(list, panel, search.value);

      searchWrap.append(search, kindFilter);

      const list = document.createElement('div');
      list.className = 'hl-panel-list';
      this._fillList(list, panel, '');
      // 2026-09-05: 生词本要异步查一次, 先用已有(可能是空/上次缓存)的结果渲染出
      // 面板不等待, 查完后如果面板还开着(用户没在这瞬间关掉)才补一次渲染——
      // 避免生词本大的时候摘录面板打开有明显卡顿。
      this._loadVocabWords().then(() => {
        if (this._panel === panel) this._fillList(list, panel, search.value);
      });

      panel.append(head, actions, tagManagerWrap, searchWrap, list);
      document.body.appendChild(panel);
      this._panel = panel;
      search.focus();
    }

    /** K18 (2026-08-14): 导出逻辑(按章分组/排版/下载/打印)全部挪进
     *  highlights_export.js(2026-09-05, 拆分理由见该文件头注释)——这里只负责
     *  把"标签文案怎么查""生词命中怎么算"这两个依赖本实例状态的东西接进去。 */
    _exportGroups() {
      return HighlightsExport.buildGroups(this.items, {
        labelForKind: (k) => this._tagStore.labelFor(k),
        vocabHitsFor: (t) => this._vocabHitsFor(t),
      });
    }

    _exportMarkdown() {
      const bookKey = this.deps.bookKey();
      const { groups, total } = this._exportGroups();
      HighlightsExport.downloadBlob(HighlightsExport.toMarkdown(bookKey, groups), 'text/markdown', `${bookKey}-摘录.md`);
      AiduToast.show(`已导出 ${total} 条摘录`, 'success');
    }

    /** 2026-09-05: 导出 HTML —— 用户要能把摘录发给别人/存档, Markdown 需要额外
     *  工具才能好看地看, HTML 双击就能在任何浏览器里打开、排版是定死的。 */
    _exportHtml() {
      const bookKey = this.deps.bookKey();
      const { groups, total } = this._exportGroups();
      HighlightsExport.downloadBlob(HighlightsExport.toHtmlDocument(bookKey, groups), 'text/html', `${bookKey}-摘录.html`);
      AiduToast.show(`已导出 ${total} 条摘录`, 'success');
    }

    /** 2026-09-05: "导出 PDF"——没有引入 PDF 生成库(会碰到 Tauri CSP 只允许
     *  'self' 脚本源的限制, 且没必要为这个多带一个依赖), 而是借浏览器/系统自带
     *  的打印能力, 见 highlights_export.js::printHtml 头注释。按钮文案和这里的
     *  提示都写清楚这是"打印", 不是应用自己生成 PDF 文件——CLAUDE.md 的错误
     *  反馈原则同样适用于"功能到底做了什么", 不能让用户以为点了就直接拿到
     *  一个 PDF。 */
    _printExport() {
      const bookKey = this.deps.bookKey();
      const { groups, total } = this._exportGroups();
      HighlightsExport.printHtml(HighlightsExport.toHtmlDocument(bookKey, groups));
      AiduToast.show(`已打开打印对话框(${total} 条摘录), 选"另存为 PDF"即可存成 PDF 文件`, 'info');
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
