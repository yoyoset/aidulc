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
    }

    /** 书状态 → { label, badgeClass } (苹果级: 状态可视) */
    _bookStatus(book) {
      const map = {
        ready: { label: '就绪', cls: 'badge-ok' },
        partial: { label: '部分失败', cls: 'badge-warn' },
        processing: { label: '处理中', cls: 'badge-busy' },
        pending: { label: '待处理', cls: 'badge-idle' },
        failed: { label: '失败', cls: 'badge-err' },
      };
      return map[book.status] || { label: book.status, cls: 'badge-idle' };
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'library-view');
      const isOriginal = this.kind === 'original';

      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, isOriginal ? '书库' : '我的书'));

      // 导入成功提示 (导入完成后停留书库, 提示去备料台看进度)
      const notice = this.store.state.importedNotice;
      if (notice && (Date.now() - notice.ts) < 8000) {
        const tip = el('div', 'import-notice',
          `已加入 ${notice.count} 本到处理队列。进度请到"阅读准备"查看。`);
        wrap.appendChild(tip);
      }

      // 区隔: 书籍导入卡片 (只原版书库显示; 成品架只负责阅读)
      const importCard = isOriginal ? this._buildImportCard() : null;
      if (importCard) wrap.append(header, importCard);
      else wrap.append(header);

      const listEl = el('div', 'book-list');
      wrap.append(listEl);

      // I-D: 搜索 + 筛选工具条
      const toolbar = el('div', 'library-toolbar');
      const searchInput = el('input', 'prep-input');
      searchInput.placeholder = '搜索书名…';
      const filterSel = el('select', 'prep-select');
      ['all:全部', 'ready:就绪', 'partial:有失败句', 'processing:处理中', 'pending:待处理', 'failed:失败'].forEach(f => {
        const opt = el('option', null, f.split(':')[1]);
        opt.value = f.split(':')[0];
        filterSel.appendChild(opt);
      });
      toolbar.append(searchInput, filterSel);
      wrap.insertBefore(toolbar, listEl);

      // Bug fix (审查确认): 注销旧监听 (每次 render 叠加导致 listener 累积)
      this._off && this._off();
      this._off = this.store.on('change', (s) => this._renderBooks(listEl, s.books, searchInput, filterSel));
      // v7: 按 kind 拉数据 (书库=原版 | 成品架=product); 书库才轮询 job 进度
      const loadBooks = () => AiduLibraryService.list(this.kind).then((res) => {
        if (res.ok) this.store.set({ books: res.data || [] });
      });
      if (this.kind === 'original') {
        const loadJobs = () => AiduJobService.list().then((res) => {
          this._jobs = (res.ok && res.data) || [];
          this._renderBooks(listEl, this.store.state.books || [], searchInput, filterSel);
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
        this._renderBooks(listEl, books, searchInput, filterSel);
      }
      searchInput.oninput = () => this._renderBooks(listEl, this.store.state.books || [], searchInput, filterSel);
      filterSel.onchange = () => this._renderBooks(listEl, this.store.state.books || [], searchInput, filterSel);
      container.appendChild(wrap);
    }

    _renderBooks(listEl, books, searchInput, filterSel) {
      listEl.innerHTML = '';
      if (!books || books.length === 0) {
        const empty = el('div', 'book-empty', this.kind === 'original'
          ? '书库还是空的。用上方"导入书籍"卡片, 拖入或选择一本 EPUB / PDF / TXT。'
          : '还没有完成的书。书库导入 → 阅读准备处理完成后, 会出现在这里。');
        listEl.appendChild(empty);
        return;
      }
      // I-D: 搜索 + 筛选
      const q = (searchInput && searchInput.value || '').toLowerCase();
      const filter = filterSel ? filterSel.value : 'all';
      const filtered = books.filter(b => {
        if (q && !(b.title || b.id).toLowerCase().includes(q)) return false;
        if (filter !== 'all' && b.status !== filter) return false;
        return true;
      });
      if (!filtered.length) {
        listEl.appendChild(el('div', 'book-empty', '没有符合条件的书。'));
        return;
      }
      filtered.forEach(book => {
        const card = el('div', 'book-card');
        const name = el('div', 'book-card-title', book.title || book.id);
        const profileLabel = book.profile_id === 'kid' ? '儿童模式' : '成人自读';
        const langLabel = { en: '英文', ja: '日文' }[book.source_language] || book.source_language || '英文';
        const st = this._bookStatus(book);
        const badge = el('span', 'book-badge ' + st.cls, st.label);
        const meta = el('div', 'book-card-meta',
          `${book.chapter_count || 0} 章 · ${langLabel}→中文 · ${profileLabel}` +
          (book.failed_count ? ` · ${book.failed_count} 句失败` : ''));
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
          // 成品架: 只负责阅读 + 删除
          actions.append(openBtn);
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
          // 原版书库: 预览原文/设置/开始准备/删除
          const previewBtn = el('button', 'btn-small', '预览原文');
          previewBtn.onclick = () => this._openPreview(book);
          const setBtn = el('button', 'btn-small', '设置');
          setBtn.onclick = () => this._openBookSettings(book);
          const needsPrep = book.status === 'pending' || book.status === 'failed';
          const prepBtn = el('button', 'btn-small btn-primary', '开始阅读准备');
          if (!needsPrep) prepBtn.style.display = 'none';
          prepBtn.onclick = () => this._startPrepForBook(book);
          const delBtn = el('button', 'btn-small btn-danger', '删除');
          delBtn.onclick = () => {
            AiduModal.confirm({
              title: `删除《${book.title}》?`,
              message: '这本书的内容和音频都会移除, 无法恢复。',
              confirmText: '删除',
              danger: true,
              onConfirm: () => AiduLibraryService.remove(book.id, true)
                .then(() => { this.store.emit('change', this.store.state); AiduToast.show('已删除《' + book.title + '》', 'success'); }),
            });
          };
          actions.append(openBtn, previewBtn, setBtn, prepBtn, delBtn);
        }
        card.append(name, meta, actions);
        listEl.appendChild(card);
      });
    }

    /** R1/R2: 开始阅读准备 — 前置检查 → 通过入队; 未通过 → 书卡标原因 */
    _startPrepForBook(book) {
      const profileId = book.profile_id || 'default';
      const profile = AiduImportService.buildProfile(profileId);
      // 需要 batch_id: 导入时记录的; 若无 (旧书) → 单本批处理
      const batchId = this._lastBatchId || ('batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      AiduToast.show('正在检查《' + (book.title || book.id) + '》…', 'info');
      AiduJobService.startPrep(batchId, [book.id], profile).then((res) => {
        if (!res.ok) { AiduToast.show('开始失败: ' + res.error, 'error'); return; }
        const d = res.data || {};
        if (d.skipped && d.skipped.length) {
          // 前置检查未通过 → 可读原因 + 跳转模型中心
          const reasons = (d.skipped[0].reasons || []).join('; ');
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
        AiduToast.show('已加入处理队列', 'success');
        this.store.emit('change', this.store.state);
      });
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
        const meta = el('div', 'preview-meta', `${d.chapters ? d.chapters.length : 0} 章 · ${d.format || ''}`);
        body.appendChild(meta);
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
          body.appendChild(el('div', 'global-error',
            '加载失败: ' + ((bindRes.error) || (listRes.error)) + ' ').textContent && null);
          const retry = el('button', 'btn-small', '重试');
          retry.onclick = () => { ov.remove(); this._openBookSettings(book); };
          body.appendChild(el('div', 'settings-error', '加载失败')).appendChild(retry);
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

    /** 导入卡片: 拖拽 + 文件选择; 不要求用户输入任何路径 (易用性审查: 删除手动路径输入) */
    _buildImportCard() {
      const card = el('div', 'import-card');
      card.appendChild(el('div', 'import-card-title', '导入书籍'));

      const dropZone = el('div', 'prep-dropzone', '把一本或多本 EPUB / PDF / TXT 拖到这里, 或点击选择文件');
      dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
      dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
      if (window.AiduBridge && window.__TAURI__?.event) {
        window.AiduBridge.listen('tauri://drag-drop', (ev) => {
          dropZone.classList.remove('drag-over');
          const paths = ev.payload && ev.payload.paths;
          if (paths && paths.length) this._startBatchImport(paths);
        });
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
      ['default:成人自读', 'kid:陪小孩读'].forEach(p => {
        const opt = el('option', null, p.split(':')[1]);
        opt.value = p.split(':')[0];
        profileSelect.appendChild(opt);
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

    /** 导入 (R1: 只登记书到书库, 不自动开始处理; 用户确认后再开始) */
    _startBatchImport(paths) {
      const profileSel = document.querySelector('.import-card .prep-select');
      const profileId = profileSel ? profileSel.value : 'default';
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
          // 记录 batch → 书卡出现后"开始阅读准备"用它
          this._lastBatchId = res.data;
          if (this.onImported) this.onImported(paths.length, res.data);
          AiduToast.show(`已导入 ${paths.length} 本书到书库`, 'success');
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
