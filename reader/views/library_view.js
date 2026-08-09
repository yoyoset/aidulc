/**
 * views/library_view.js —— 书库: 书卡列表 + 最近阅读 + 导入入口
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** 阶段名 → 中文 (与 prep_view 一致) */
  const STAGE_LABEL = {
    parse: '识别', nlp: '分词', translate: '翻译', explain: '讲解',
    tts: '语音', align: '对齐', pack: '排版', spawn_error: '启动失败',
  };

  class LibraryView {
    constructor(store, kind) {
      this.store = store;
      // v7 架构分离: kind = 'original' (书库, 原版管理) | 'product' (成品架, 可阅读)
      this.kind = kind || 'original';
      this.onOpenBook = null;   // (book) => void
      this.onImported = null;   // (count) => void
      this.onImportError = null; // (err) => void
      // 阶段2 (F45): 拖拽监听用单一槽位管理, 重渲染不累积; 导入用短窗口去重, 单次动作只导一次
      this._dragSlot = new AiduListenerSlot();
      this._importDedup = new AiduImportDedup(2000);
    }

    /** 书状态 → { label, badgeClass } (苹果级: 状态可视) */
    _bookStatus(book) {
      const map = {
        ready: { label: '就绪', cls: 'badge-ok' },
        // mark_original_done 把源书标成 done: 已生成译本, 展示为"已就绪"
        done: { label: '已就绪', cls: 'badge-ok' },
        partial: { label: '部分失败', cls: 'badge-warn' },
        processing: { label: '处理中', cls: 'badge-busy' },
        pending: { label: '待处理', cls: 'badge-idle' },
        failed: { label: '失败', cls: 'badge-err' },
      };
      return map[book.status] || { label: book.status, cls: 'badge-idle' };
    }

    /** 阶段6 设计交付 §01: 状态分段映射 —— 未处理 = pending/failed; 已就绪 = ready/done/partial */
    _inStatusBucket(book, bucket) {
      switch (bucket) {
        case 'ready': return ['ready', 'done', 'partial'].includes(book.status);
        case 'processing': return book.status === 'processing';
        case 'pending': return ['pending', 'failed'].includes(book.status);
        default: return true;
      }
    }

    /** 阶段6 设计交付 §01: 分段计数 (苹果级: 数量可见, 空分段不误导) */
    _updateSegCounts(books, segBar) {
      if (!segBar) return;
      segBar.querySelectorAll('.lib-seg').forEach((seg) => {
        const bucket = seg.dataset.bucket;
        const n = bucket === 'all' ? (books || []).length
          : (books || []).filter((b) => this._inStatusBucket(b, bucket)).length;
        seg.dataset.count = String(n);
        const countEl = seg.querySelector('.lib-seg-count');
        if (countEl) countEl.textContent = String(n);
      });
    }

    /** F33/F34 (2026-08-09): 路由离开时注销事件订阅, 不残留拖拽监听/轮询 (与 prep_view 对称) */
    cleanup() {
      if (this._dragSlot) this._dragSlot.clear();
      if (this._offLibChanged) { this._offLibChanged(); this._offLibChanged = null; }
      if (this._off) { this._off(); this._off = null; }
      if (this._jobTimer) { clearInterval(this._jobTimer); this._jobTimer = null; }
    }

    render(container) {
      container.innerHTML = '';
      // 阶段2 (F45): 注销上一轮拖拽监听 (单一槽位, 重渲染不累积)。在 _buildImportCard()
      // 注册新监听之前执行 —— 原来写在这之后, `this._offDrag()` 杀掉的是刚注册的新
      // listener(拖拽导入每次 render 后即失效)。顺序先清后注册。
      this._dragSlot.clear();
      const wrap = el('div', 'library-view');
      const isOriginal = this.kind === 'original';

      // M6: 加载档案表, 书卡/导入卡显示真实档案名 (自建档案从这里开始有名字)
      AiduBridge.profiles.list().then((res) => {
        this._profiles = (res.ok && res.data) || [];
        this._renderBooks(listEl, this.store.state.books || [], searchInput);
      });

      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, isOriginal ? '书库' : '我的书'));
      // P1.5: 书包是资产, 支持跨设备导入(zip); 两个视图都放, 导入的书直接进"我的书"
      const importBookBtn = el('button', 'btn-small', '导入书包(.zip)');
      importBookBtn.title = '导入之前从别的设备导出的书包 zip, 免重新处理直接可读';
      importBookBtn.onclick = () => this._importBookZip();
      header.appendChild(importBookBtn);

      // 导入成功提示 (阶段2: 导入的是原书, 下一步创建译本)
      const notice = this.store.state.importedNotice;
      if (notice && (Date.now() - notice.ts) < 8000) {
        const tip = el('div', 'import-notice',
          `已导入 ${notice.count} 本原书。下一步: 在书卡上点击"创建译本"生成可阅读版本。`);
        wrap.appendChild(tip);
      }

      // 区隔: 书籍导入卡片 (只原版书库显示; 成品架只负责阅读)
      const importCard = isOriginal ? this._buildImportCard() : null;
      if (importCard) wrap.append(header, importCard);
      else wrap.append(header);

      const listEl = el('div', 'book-list');
      wrap.append(listEl);

      // I-D: 搜索 + 筛选工具条 (设计交付 §01: 状态分段控件是筛选不是导航, 带计数)
      const toolbar = el('div', 'library-toolbar');
      const searchInput = el('input', 'prep-input');
      searchInput.placeholder = '搜索书名…';
      const segBar = el('div', 'library-segmented');
      // 状态分段: 全部 / 已就绪 / 处理中 / 未处理 (映射见 _inStatusBucket)
      const buckets = [
        { key: 'all', label: '全部' },
        { key: 'ready', label: '已就绪' },
        { key: 'processing', label: '处理中' },
        { key: 'pending', label: '未处理' },
      ];
      buckets.forEach((b) => {
        const seg = el('button', 'lib-seg', null);
        seg.dataset.bucket = b.key;
        const labelSpan = el('span', null, b.label);
        const countSpan = el('span', 'lib-seg-count', '0');
        seg.append(labelSpan, countSpan);
        if (b.key === (this._statusFilter || 'all')) seg.classList.add('active');
        seg.addEventListener('click', () => {
          this._statusFilter = b.key;
          segBar.querySelectorAll('.lib-seg').forEach((s) => s.classList.toggle('active', s === seg));
          this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar);
        });
        segBar.appendChild(seg);
      });
      toolbar.append(searchInput, segBar);
      wrap.insertBefore(toolbar, listEl);

      // Bug fix (审查确认): 注销旧监听 (每次 render 叠加导致 listener 累积)
      this._off && this._off();
      this._off = this.store.on('change', (s) => this._renderBooks(listEl, s.books, searchInput, segBar));
      // 阶段7 (UX 3.3): 备料完成/导入后 library-changed 事件即时刷新书库, 译本子卡不用等 5s 轮询
      if (this._offLibChanged) { this._offLibChanged(); this._offLibChanged = null; }
      this._offLibChanged = AiduBridge.listen('library-changed', () => {
        loadBooks();
      });
      // v7: 按 kind 拉数据 (书库=原版 | 成品架=product); 书库才轮询 job 进度
       const loadBooks = () => AiduLibraryService.list(this.kind).then((res) => {
         if (res.ok) this.store.set({ books: res.data || [] });
         else AiduToast.show('读取书库失败: ' + res.error, 'error');
       }).catch((err) => AiduToast.show('读取书库失败: ' + err, 'error'));
      if (this.kind === 'original') {
        const loadJobs = () => AiduJobService.list().then((res) => {
          this._jobs = (res.ok && res.data) || [];
          this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar);
        });
        if (this._jobTimer) clearInterval(this._jobTimer);
        this._jobTimer = setInterval(loadJobs, 5000);
        loadJobs();
      }
      loadBooks();

      const books = this.store.state.books || [];
      if (books.length === 0) {
        const empty = el('div', 'book-empty', isOriginal
          ? '书库还是空的。用上方"导入书籍"卡片, 拖入或选择一本 EPUB / PDF / TXT。'
          : '还没有完成的书。书库导入 → 阅读准备处理完成后, 会出现在这里。');
        listEl.appendChild(empty);
      } else {
        this._renderBooks(listEl, books, searchInput, segBar);
      }
      searchInput.oninput = () => this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar);
      container.appendChild(wrap);
    }

    _renderBooks(listEl, books, searchInput, segBar) {
      listEl.innerHTML = '';
      if (!books || books.length === 0) {
        const empty = el('div', 'book-empty', this.kind === 'original'
          ? '书库还是空的。用上方"导入书籍"卡片, 拖入或选择一本 EPUB / PDF / TXT。'
          : '还没有完成的书。书库导入 → 阅读准备处理完成后, 会出现在这里。');
        listEl.appendChild(empty);
        return;
      }
      // 阶段6 设计交付 §01: 状态分段带计数 (已就绪/处理中/未处理)
      this._updateSegCounts(books, segBar);
      // I-D: 搜索 + 筛选 (分段状态映射见 _statusBuckets)
      const q = (searchInput && searchInput.value || '').toLowerCase();
      const filter = this._statusFilter || 'all';
      // F30: "最近阅读"排序 —— 打开过的书在前 (last_opened_at 降序), 未打开过按标题
      const sorted = books.slice().sort((a, b) => {
        const la = a.last_opened_at || 0;
        const lb = b.last_opened_at || 0;
        if (la !== lb) return lb - la;
        return (a.title || a.id).localeCompare(b.title || b.id);
      });
      const filtered = sorted.filter(b => {
        if (q && !(b.title || b.id).toLowerCase().includes(q)) return false;
        if (filter !== 'all' && !this._inStatusBucket(b, filter)) return false;
        return true;
      });
      if (!filtered.length) {
        listEl.appendChild(el('div', 'book-empty', '没有符合条件的书。'));
        return;
      }
      filtered.forEach(book => {
        const card = el('div', 'book-card');
        const name = el('div', 'book-card-title', book.title || book.id);
        const profileLabel = this._profileName(book.profile_id);
        const langLabel = { en: '英文', ja: '日文' }[book.source_language] || book.source_language || '英文';
        const st = this._bookStatus(book);
        const badge = el('span', 'book-badge ' + st.cls, st.label);
        const meta = el('div', 'book-card-meta',
          `${book.chapter_count || 0} 章 · ${langLabel}→中文 · ${profileLabel}` +
          (book.failed_count ? ` · ${book.failed_count} 句失败` : '') +
          // M7 R18: 阅读进度反馈 (微信读书/kindle 书架同款)
          (book.reading_chapter != null ? ` · 已读至第 ${book.reading_chapter + 1} 章` : '') +
          (book.time_spent_ms > 60000 ? ` · 已读 ${Math.round(book.time_spent_ms / 60000)} 分钟` : ''));
        meta.prepend(badge);
        // S5 资产模型: 成品卡显示用了什么模型 (不同模型=不同资产)
        if (this.kind === 'product') {
          const modelTag = book.llm_id || book.tts_id || '';
          const tag = el('span', 'model-tag', modelTag.split('|').slice(0, 2).join('/') || '默认模型');
          meta.appendChild(tag);
        }
        // R6 改进: 处理中的书显示实时进度 (来自 job_list 匹配)
        if (book.status === 'processing') {
          const job = (this._jobs || []).find(j => j.book_path && book.source_path &&
            j.book_path.replace(/\\/g, '/') === book.source_path.replace(/\\/g, '/'));
          if (job && job.total > 0) {
            const pct = Math.round((job.current / job.total) * 100);
            const stLabel = STAGE_LABEL[job.stage] || job.stage;
            const pbar = el('div', 'prep-bar');
            const pfill = el('div', 'prep-bar-fill');
            pfill.style.width = pct + '%';
            pbar.appendChild(pfill);
            const ptext = el('div', 'book-progress-text', `${stLabel} ${pct}% · ${job.current}/${job.total} 句`);
            card.appendChild(pbar);
            card.appendChild(ptext);
          }
        }

        // 打开: 就绪/部分失败可开; 处理中/待处理禁用 (苹果级: 禁用要给原因)
        const canOpen = book.status === 'ready' || book.status === 'partial';
        const openBtn = el('button', 'btn-small', this.kind === 'product' ? '打开阅读' : '打开');
        openBtn.disabled = !canOpen;
        if (!canOpen) {
          openBtn.title = '这本书还在准备中, 完成后再来读';
          openBtn.classList.add('btn-disabled');
        }
        openBtn.onclick = () => this.onOpenBook && this.onOpenBook(book);

        const actions = el('div', 'book-card-actions');
        if (this.kind === 'product') {
          // 成品架: 阅读 + 导出(资产可跨设备迁移) + 删除
          actions.append(openBtn);
          const exportBtn = el('button', 'btn-small', '导出');
          exportBtn.onclick = () => this._exportBookZip(book);
          actions.appendChild(exportBtn);
          const delBtn = el('button', 'btn-small btn-danger', '删除');
          delBtn.onclick = () => {
            AiduModal.confirm({
              title: `删除《${book.title}》?`,
              message: '这本书的成品内容会移除, 无法恢复。需要重新处理才能再读。',
              confirmText: '删除',
              danger: true,
              onConfirm: () => AiduLibraryService.remove(book.id, true)
                .then(() => { this.store.emit('change', this.store.state); AiduToast.show('已删除《' + book.title + '》', 'success'); }),
            });
          };
          actions.appendChild(delBtn);
        } else {
          // 原版书库 (source): 阶段2 —— 原书不可直接阅读, 主动作是"创建译本"
          const previewBtn = el('button', 'btn-small', '预览原文');
          previewBtn.onclick = () => this._openPreview(book);
          const setBtn = el('button', 'btn-small', '设置');
          setBtn.onclick = () => this._openBookSettings(book);
           // 阶段2 (F45/BOOK_WORKFLOW): 原书没有 pack/进度/书签, 不可打开阅读。
           // 统一主动作 = 创建/新增译本; 处理中时不伪装可操作(有译本的处理中也可再增)。
           const hasEditions = Array.isArray(book.editions) && book.editions.length > 0;
           const createBtn = el('button', 'btn-small btn-primary', hasEditions ? '新增译本' : '创建译本');
           createBtn.onclick = () => this._chooseEditionProfile(book);
           if (book.status === 'processing' && !hasEditions) {
             // 首次备料中: 还没译本可展示, 隐藏主动作, 用状态徽章表示"处理中"
             createBtn.style.display = 'none';
           }
          const delBtn = el('button', 'btn-small btn-danger', '删除');
          delBtn.onclick = () => {
            AiduModal.confirm({
              title: `删除《${book.title}》?`,
               message: '原书及其全部译本、阅读进度、书签和处理任务都会移除，无法恢复。',
              confirmText: '删除',
              danger: true,
              onConfirm: () => AiduLibraryService.remove(book.id, true)
                .then(() => { this.store.emit('change', this.store.state); AiduToast.show('已删除《' + book.title + '》', 'success'); }),
            });
          };
           actions.append(previewBtn, setBtn, createBtn, delBtn);
        }
         card.append(name, meta, actions);
         if (this.kind === 'original' && Array.isArray(book.editions) && book.editions.length) {
           const editions = el('div', 'edition-list');
           editions.appendChild(el('div', 'settings-hint', `译本/成品 (${book.editions.length})`));
           book.editions.forEach((edition) => {
             const child = el('div', 'edition-card');
             const childTitle = el('div', 'book-card-title', edition.title || edition.id);
             const childProfile = this._profileName(edition.profile_id);
             // 模型快照是路径, 卡片只显示文件名 (苹果级: 不把 F:/hf_cache/... 长路径糊在卡上)
             const shortModel = (p) => {
               if (!p) return '';
               const s = String(p);
               return s.split(/[\\/]/).pop() || s;
             };
             const childModel = [edition.llm_id, edition.tts_id].map(shortModel).filter(Boolean).join(' / ') || '默认模型';
             const childMeta = el('div', 'book-card-meta',
               `${childProfile} · ${edition.source_language || 'en'}→${edition.target_language || 'zh-CN'} · ${childModel}`);
             const childActions = el('div', 'book-card-actions');
             const childOpen = el('button', 'btn-small', '打开阅读');
             childOpen.disabled = !['ready', 'partial'].includes(edition.status);
             childOpen.onclick = () => this.onOpenBook && this.onOpenBook(edition);
             const childDelete = el('button', 'btn-small btn-danger', '删除译本');
             childDelete.onclick = () => AiduModal.confirm({
               title: `删除译本《${edition.title || edition.id}》?`,
               message: '只删除这个译本，原书和其它译本保留。',
               confirmText: '删除', danger: true,
               onConfirm: () => AiduLibraryService.remove(edition.id, true)
                 .then(() => { this.store.emit('change', this.store.state); AiduToast.show('译本已删除', 'success'); }),
             });
             childActions.append(childOpen, childDelete);
             child.append(childTitle, childMeta, childActions);
             editions.appendChild(child);
           });
           card.appendChild(editions);
         }
         listEl.appendChild(card);
      });
    }

    /** M6: 档案 id → 显示名 (自建档案查表, 内建兜底, 查不到显示未知) */
    _profileName(id) {
      const p = (this._profiles || []).find((x) => x.id === id);
      if (p && p.name) return p.name;
      if (id === 'kid') return '陪小孩读';
      if (id === 'default' || !id) return '成人自读';
      return '未知档案';
    }

    /** R1/R2: 开始阅读准备 — 前置检查 → 通过入队; 未通过 → 书卡标原因 */
    _startPrepForBook(book, selectedProfileId, cbs) {
      const profileId = selectedProfileId || book.profile_id || 'default';
      const batchId = this._lastBatchId || ('batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      const onSkipped = (cbs && cbs.onSkipped) || null;
      const onStarted = (cbs && cbs.onStarted) || null;
      AiduToast.show('正在检查《' + (book.title || book.id) + '》…', 'info');
      AiduImportService.startPrep(batchId, [book.id], profileId).then((res) => {
        if (!res.ok) { AiduToast.show('开始失败: ' + res.error, 'error'); return; }
        const d = res.data || {};
        if (d.skipped && d.skipped.length) {
          const reasons = (d.skipped[0].reasons || []).join('; ');
          if (onSkipped) { onSkipped(d.skipped[0].reasons || []); return; }
          AiduToast.show('无法开始: ' + reasons, 'error');
          if (reasons.includes('模型')) {
            AiduModal.confirm({
              title: '还缺模型',
              message: reasons + '\n\n去模型中心配置后回来重试。',
              confirmText: '去模型中心',
              onConfirm: () => { window.location.hash = '#/models'; },
            });
          }
          return;
        }
        if (onStarted) { onStarted(); return; }
        AiduToast.show('已加入处理队列', 'success');
        this.store.emit('change', this.store.state);
      });
    }

    /**
     * 阶段4 (BOOK_WORKFLOW): source → 配置面板 → 开始备料 → edition。
     * 面板必须完成 profile/语言/模型配置后才允许开始; preflight 失败留在面板显示原因和下一步。
     */
    _chooseEditionProfile(book) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = el('div', 'modal-box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', `为《${book.title || book.id}》创建译本`);
      // 阶段2 (BOOK_WORKFLOW): 说清原书 vs 译本边界 —— 原书只是来源, 译本才是可读成品。
      const hint = el('div', 'settings-hint',
        '译本是从这本原书生成的可阅读版本。配置好档案、语言和模型后, 系统会生成译文、讲解和音频。' +
        '同一本原书可以用不同参数生成多个译本; 相同参数重新生成会覆盖原译本。');
      const body = el('div', 'book-settings-body');

      // 档案
      body.appendChild(el('div', 'settings-hint', '学习档案'));
      const profileSelect = el('select', 'prep-select');
      (this._profiles || [{ id: 'default', name: '成人自读' }]).forEach((p) => {
        const opt = el('option', null, p.name || p.id);
        opt.value = p.id;
        profileSelect.appendChild(opt);
      });

      // 语言 (source → target)
      body.appendChild(el('div', 'settings-hint', '语言'));
      const langRow = el('div', 'prep-row');
      const srcSel = el('select', 'prep-select');
      [['en', '英文'], ['ja', '日文 (即将支持)']].forEach(([c, l]) => {
        const opt = el('option', null, l); opt.value = c;
        if (c !== 'en') opt.disabled = true;
        srcSel.appendChild(opt);
      });
      const tgtSel = el('select', 'prep-select');
      [['zh-CN', '中文']].forEach(([c, l]) => {
        const opt = el('option', null, l); opt.value = c;
        tgtSel.appendChild(opt);
      });
      langRow.append(srcSel, tgtSel);

      // 模型 (阶段4: 不配置就用全局推荐; 统一从后端 models_list 取状态)
      body.appendChild(el('div', 'settings-hint', '模型 (不选就跟随模型中心的全局推荐)'));
      const modelRow = el('div', 'prep-row');
      const llmSel = el('select', 'prep-select');
      const ttsSel = el('select', 'prep-select');
      modelRow.append(llmSel, ttsSel);

      // preflight 结果区 (失败显示原因 + 下一步, 不关面板)
      const result = el('div', 'prep-preflight-result');
      result.style.display = 'none';

      const actions = el('div', 'modal-actions');
      const cancel = el('button', 'btn-small', '取消');
      const start = el('button', 'btn-small btn-primary', '开始备料');
      actions.append(cancel, start);
      box.append(title, hint, body, result, actions);
      ov.appendChild(box);
      document.body.appendChild(ov);

      function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      cancel.onclick = close;
      ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
      document.addEventListener('keydown', onKey);

      // 载入档案/模型状态 (阶段4: 四个状态已扫描/已登记/可用/已绑定由后端返回, 前端只渲染)
      body.appendChild(el('div', 'settings-loading', '加载中…'));
      Promise.all([AiduModelService.list(), AiduModelService.bookBinding(book.id)])
        .then(([listRes, bindRes]) => {
          const loading = body.querySelector('.settings-loading');
          if (loading) loading.remove();
          const models = (listRes.ok && Array.isArray(listRes.data)) ? listRes.data : [];
          const bind = (bindRes.ok && bindRes.data) || {};
          srcSel.value = bind.source_language || 'en';

          const llmOpt = el('option', null, '跟随全局推荐'); llmOpt.value = '';
          llmSel.appendChild(llmOpt);
          models.filter(m => m.family === 'llm').forEach(m => {
            const opt = el('option', null, m.model_id); opt.value = m.id;
            opt.title = '已登记' + (m.recommended ? ' · 全局推荐' : '');
            llmSel.appendChild(opt);
          });
          const ttsOpt = el('option', null, '跟随全局推荐'); ttsOpt.value = '';
          ttsSel.appendChild(ttsOpt);
          models.filter(m => m.family === 'tts').forEach(m => {
            const opt = el('option', null, m.model_id); opt.value = m.id;
            opt.title = '已登记' + (m.recommended ? ' · 全局推荐' : '');
            ttsSel.appendChild(opt);
          });
          if (bind.llm_id) llmSel.value = bind.llm_id;
          if (bind.tts_id) ttsSel.value = bind.tts_id;
          if (models.filter(m => m.family === 'llm').length === 0 ||
              models.filter(m => m.family === 'tts').length === 0) {
            body.appendChild(el('div', 'settings-hint settings-warn',
              '模型中心还没有完整的模型组合。请先到模型中心配置翻译引擎和语音引擎, 再回来创建译本。'));
          }
          body.appendChild(modelRow);
          // 重新挂回: body 是空容器, 顺序追加即可
          body.appendChild(profileSelect);
          body.appendChild(langRow);
        }).catch((e) => {
          const loading = body.querySelector('.settings-loading');
          if (loading) loading.remove();
          body.appendChild(el('div', 'global-error', '加载配置失败: ' + e));
        });

      // 阶段4: 配置完成前不创建 edition; preflight 失败留在面板显示原因和下一步
      start.onclick = () => {
        start.disabled = true;
        start.textContent = '正在检查…';
        result.style.display = 'none';
        // 先持久化书级模型绑定 (不同模型 = 不同 edition 的参数快照来源)
        AiduModelService.bindBook(
          book.id, srcSel.value, tgtSel.value, llmSel.value || null, ttsSel.value || null, null
        ).then((bindRes) => {
          if (!bindRes.ok) {
            start.disabled = false; start.textContent = '开始备料';
            result.style.display = '';
            result.className = 'prep-preflight-result prep-failure';
            result.textContent = '保存模型配置失败: ' + bindRes.error + '。请重试。';
            return;
          }
          const profileId = profileSelect.value;
          return this._startPrepForBook(book, profileId, {
            onSkipped: (reasons) => {
              // preflight 未通过: 留在面板, 显示原因 + 下一步
              start.disabled = false;
              start.textContent = '开始备料';
              result.style.display = '';
              result.className = 'prep-preflight-result prep-failure';
              result.textContent = '暂时无法开始: ' + reasons.join('; ');
              const goModels = el('button', 'btn-small btn-primary', '去模型中心');
              goModels.onclick = () => { close(); window.location.hash = '#/models'; };
              result.appendChild(goModels);
            },
            onStarted: () => {
              close();
              AiduToast.show('已加入处理队列, 完成后自动生成译本', 'success');
              this.store.emit('change', this.store.state);
            },
          });
        }).catch((e) => {
          start.disabled = false; start.textContent = '开始备料';
          result.style.display = '';
          result.className = 'prep-preflight-result prep-failure';
          result.textContent = '开始失败: ' + e;
        });
      };
      cancel.focus();
    }

    /** S4: 预览原文 (模态: 书库打开的是原始书籍) */
    _openPreview(book) {
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
          warn.style.color = 'var(--md-sys-color-error, #b3261e)';
          warn.style.margin = '8px 0';
          warn.style.fontSize = '13px';
          body.appendChild(warn);
        }
        (d.chapters || []).slice(0, 20).forEach(ch => {
          const sec = el('div', 'preview-chapter');
          const h = el('div', 'preview-ch-title', ch.title || ('Chapter ' + (ch.index + 1)));
          sec.appendChild(h);
          (ch.sentences || []).slice(0, 10).forEach(s => {
            sec.appendChild(el('div', 'preview-sentence', s));
          });
          if ((ch.sentences || []).length > 10) {
            sec.appendChild(el('div', 'preview-more', `…共 ${ch.sentences.length} 段`));
          }
          body.appendChild(sec);
        });
      });
    }

    /** 书设置弹窗 (P3): 语言 + 模型覆盖 (默认跟随全局推荐) */
    _openBookSettings(book) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', `书设置 — ${book.title || book.id}`);
      const body = el('div', 'book-settings-body');

      const langLabel = el('div', 'settings-hint', '语言');
      const langRow = el('div', 'prep-row');
      const srcSel = el('select', 'prep-select');
      [['en', '英文'], ['ja', '日文 (即将支持)']].forEach(([c, l]) => {
        const opt = el('option', null, l); opt.value = c;
        if (c !== 'en') opt.disabled = true;
        srcSel.appendChild(opt);
      });
      const tgtSel = el('select', 'prep-select');
      [['zh-CN', '中文']].forEach(([c, l]) => {
        const opt = el('option', null, l); opt.value = c;
        tgtSel.appendChild(opt);
      });
      langRow.append(srcSel, tgtSel);

      const modelHint = el('div', 'settings-hint', '模型 (不配置就用模型中心的全局推荐)');
      const llmRow = el('div', 'prep-row');
      const llmSel = el('select', 'prep-select');
      const ttsSel = el('select', 'prep-select');

      const actions = el('div', 'modal-actions');
      const cancelBtn = el('button', 'btn-small', '取消');
      const saveBtn = el('button', 'btn-small btn-primary', '保存');
      actions.append(cancelBtn, saveBtn);

      function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') close(); }

      body.append(langLabel, langRow, modelHint, llmRow);
      box.append(title, body, actions);
      ov.appendChild(box);
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
      document.addEventListener('keydown', onKey);

      // 加载: 当前绑定 + 可用模型 (四态: loading/error/success)
      body.prepend(el('div', 'settings-loading', '加载中…'));
      Promise.all([
        AiduModelService.bookBinding(book.id),
        AiduModelService.list(),
      ]).then(([bindRes, listRes]) => {
        body.querySelector('.settings-loading').remove();
        if (!bindRes.ok || !listRes.ok) {
          // F18 (2026-08-08): 原实现 `appendChild(el(...).textContent && null)` 恒为 null,
          // 必然抛 TypeError 落入 catch, 错误详情与重试入口都丢失。直接挂错误块。
          body.appendChild(el('div', 'global-error',
            '加载失败: ' + ((bindRes.error) || (listRes.error) || '未知错误')));
          const retry = el('button', 'btn-small', '重试');
          retry.onclick = () => { ov.remove(); this._openBookSettings(book); };
          body.appendChild(retry);
          return;
        }
        const bind = bindRes.data || {};
        const models = listRes.data || [];
        srcSel.value = bind.source_language || 'en';

        // LLM 下拉: 跟随全局 + 已注册 llm 模型
        const llmOpt = el('option', null, '跟随全局推荐'); llmOpt.value = '';
        llmSel.appendChild(llmOpt);
        models.filter(m => m.family === 'llm').forEach(m => {
          const opt = el('option', null, m.model_id); opt.value = m.id;
          llmSel.appendChild(opt);
        });
        // TTS 下拉
        const ttsOpt = el('option', null, '跟随全局推荐'); ttsOpt.value = '';
        ttsSel.appendChild(ttsOpt);
        models.filter(m => m.family === 'tts').forEach(m => {
          const opt = el('option', null, m.model_id); opt.value = m.id;
          ttsSel.appendChild(opt);
        });
        // 回显当前绑定
        if (bind.llm_id) llmSel.value = bind.llm_id;
        if (bind.tts_id) ttsSel.value = bind.tts_id;
        // 无模型提示 (Empty 态)
        if (models.filter(m => m.family === 'llm').length === 0 ||
            models.filter(m => m.family === 'tts').length === 0) {
          body.appendChild(el('div', 'settings-hint settings-warn',
            '模型中心还没有完整的模型组合。请先到模型中心配置翻译引擎和语音引擎。'));
        }
        llmRow.append(llmSel, ttsSel);
      }).catch((e) => {
        body.querySelector('.settings-loading').remove();
        body.appendChild(el('div', 'global-error', '加载失败: ' + e));
      });

      cancelBtn.onclick = close;
      saveBtn.onclick = () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        AiduModelService.bindBook(
          book.id, srcSel.value, tgtSel.value,
          llmSel.value || null, ttsSel.value || null, null
        ).then((r) => {
          if (!r.ok) { saveBtn.disabled = false; saveBtn.textContent = '保存'; body.appendChild(el('div', 'global-error', '保存失败: ' + r.error)); return; }
          close();
          AiduToast.show('已保存《' + (book.title || '') + '》的设置', 'success');
          this.store.emit('change', this.store.state);
        });
      };
      cancelBtn.focus();
    }

    /** P1.5: 导出书包为 zip (成品资产, 跨设备迁移) */
    _exportBookZip(book) {
      AiduLibraryService.exportBook(book.id).then((r) => {
        if (!r.ok) { AiduToast.show('导出失败: ' + r.error, 'error'); return; }
        const d = r.data || {};
        if (d.cancelled) return;
        AiduToast.show('已导出到 ' + d.path, 'success');
      });
    }

    /** P1.5: 导入 zip 书包 (免重新处理, 直接进"我的书") */
    _importBookZip() {
      AiduLibraryService.importBook().then((r) => {
        if (!r.ok) { AiduToast.show('导入失败: ' + r.error, 'error'); return; }
        const d = r.data || {};
        if (d.cancelled) return;
        AiduToast.show('已导入《' + d.id + '》, 可在"我的书"里打开', 'success');
        AiduLibraryService.list(this.kind).then((lr) => {
          if (lr.ok) this.store.set({ books: lr.data || [] });
        });
      });
    }

    /** 导入卡片: 拖拽 + 文件选择; 不要求用户输入任何路径 (易用性审查: 删除手动路径输入) */
    _buildImportCard() {
      const card = el('div', 'import-card');
      card.appendChild(el('div', 'import-card-title', '导入书籍'));

      const dropZone = el('div', 'prep-dropzone', '把一本或多本 EPUB / PDF / TXT 拖到这里, 或点击选择文件');
      dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
      dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
      if (window.AiduBridge && window.__TAURI__?.event) {
        // 阶段2 (F45): 单一槽位注册, 重渲染时旧的会被新注册自动注销, 不累积
        this._dragSlot.set(window.AiduBridge.listen('tauri://drag-drop', (ev) => {
          dropZone.classList.remove('drag-over');
          const paths = ev.payload && ev.payload.paths;
          if (paths && paths.length) this._startBatchImport(paths);
        }));
      }
      const fileInput = el('input', null);
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.accept = '.epub,.pdf,.txt';
      fileInput.style.display = 'none';
      fileInput.onchange = () => {
        // M 系列: 走 bridge (视图不直连 __TAURI__)
        window.AiduBridge.pickFiles(['epub', 'pdf', 'txt']).then((r) => {
          if (r.ok && r.data && r.data.length) this._startBatchImport(r.data);
        });
        fileInput.value = '';
      };
      dropZone.appendChild(fileInput);
      dropZone.onclick = () => fileInput.click();

      const optsRow = el('div', 'prep-row');
      const profileSelect = el('select', 'prep-select');
      profileSelect.title = '用哪个学习档案处理 (音色/讲解策略/语速在设置里管理)';
      // M6: 档案从表里动态加载 (内建 default/kid + 用户自建), 不再硬编码两个
      AiduBridge.profiles.list().then((res) => {
        const profiles = (res.ok && Array.isArray(res.data) ? res.data : []).slice();
        if (!profiles.some((p) => p.id === 'default')) profiles.unshift({ id: 'default', name: '成人自读' });
        if (!profiles.some((p) => p.id === 'kid')) profiles.push({ id: 'kid', name: '陪小孩读' });
        profileSelect.innerHTML = '';
        profiles.forEach((p) => {
          const opt = el('option', null, p.name);
          opt.value = p.id;
          profileSelect.appendChild(opt);
        });
      });
      const langSelect = el('select', 'prep-select');
      langSelect.id = 'prep-source-lang';
      [['en', '英文'], ['ja', '日文 (即将支持)'], ['other', '其他']].forEach(([code, label]) => {
        const opt = el('option', null, label);
        opt.value = code;
        if (code !== 'en') opt.disabled = true;
        langSelect.appendChild(opt);
      });
      const tip = el('div', 'import-tip', '导入后书籍进入"阅读准备"排队处理, 完成后回到书库。');
      optsRow.append(profileSelect, langSelect);
      card.append(dropZone, optsRow, tip);
      return card;
    }

    /** 导入 (R1: 只登记 source 到书库, 不开始处理; 下一步由 source 卡"创建译本"触发) */
    _startBatchImport(paths) {
      const profileSel = document.querySelector('.import-card .prep-select');
      const profileId = profileSel ? profileSel.value : 'default';
      // 阶段2 (F45): 单次动作只导一次 —— 拖拽事件与文件选择同时命中/快速连点都只放行第一次
      if (this._importDedup && !this._importDedup.shouldFire(paths, profileId)) return;
      const langSel = document.getElementById('prep-source-lang');
      const sourceLang = langSel ? langSel.value : 'en';
      // 苹果级: 立即反馈"正在登记"
      AiduToast.show(`正在导入 ${paths.length} 本书…`, 'info');
      AiduImportService.importBooks(paths, profileId, { source: sourceLang, target: 'zh-CN' })
        .then((res) => {
          if (!res.ok) {
            if (this.onImportError) this.onImportError(res.error);
            AiduToast.show('导入失败: ' + res.error, 'error');
            return;
          }
          const d = res.data || {};
          // 记录 batch → 书卡出现后"创建译本"用它 (全跳过时为空串, 由创建译本流程自行处理)
          this._lastBatchId = d.batch_id || '';
          const registered = (d.registered || []).length;
          const skipped = (d.skipped || []).length;
          if (this.onImported) this.onImported(registered, d.batch_id);
          // 阶段2 (F45): 明确"导入的是原书, 下一步创建译本", 不是"已加入处理队列"
          if (registered === 0) {
            AiduToast.show('这些原书之前已导入, 可直接为它们创建译本', 'success');
          } else if (skipped > 0) {
            AiduToast.show(`已导入 ${registered} 本原书 (${skipped} 个文件之前已导入, 跳过)。下一步: 为原书创建译本。`, 'success');
          } else {
            AiduToast.show(`已导入 ${registered} 本原书。下一步: 为原书创建译本。`, 'success');
          }
          // 刷新书列表
          this.store.emit('change', this.store.state);
          AiduLibraryService.list().then((lr) => {
            if (lr.ok) this.store.set({ books: lr.data });
          });
        }).catch((e) => {
          if (this.onImportError) this.onImportError(String(e));
          AiduToast.show('导入失败: ' + e, 'error');
        });
    }
  }

  global.LibraryView = LibraryView;
})(window);
