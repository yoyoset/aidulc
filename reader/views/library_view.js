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

  // K2-2/K2-3: 封面渲染/横滑区拆去 library/cover.js; 状态徽章/分段拆去 library/status.js。

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
      // UX5 #1 (2026-08-13): 译本展开状态持久化 —— 整列重建/轮巡不冲掉用户展开的书。
      // 重建卡片时按 set 决定 .edition-body 是否保留 collapsed; toggle 时加入/移出。
      this._expanded = new Set();
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
      // G1 (2026-08-11): 导入卡不再占半屏顶部, 而是书卡网格的最后一格 (同尺寸);
      // 「成人自读/英文」两个下拉移除 —— 参数只留在创建译本弹窗一处。
      if (isOriginal) wrap.append(header);

      // K2-3 (2026-08-13): "最近阅读"横向滑动区 (成品架专属——书库页是处理管理, 不是阅读入口)。
      const shelfEl = isOriginal ? null : el('div', 'library-shelf');
      if (shelfEl) wrap.append(shelfEl);

      const listEl = el('div', 'book-list');
      // 2026-08-17: 每次 render 都从持久化里取一次, 这样切走再回来/重启 app 都保持
      if (this._cardCompact === undefined) this._cardCompact = this._storedCompact();
      if (this._cardCompact) listEl.classList.add('book-list--compact');
      wrap.append(listEl);

      // I-D: 搜索 + 筛选工具条 (设计交付 §01: 状态分段控件是筛选不是导航, 带计数)
      const toolbar = el('div', 'library-toolbar');
      const searchInput = el('input', 'prep-input');
      searchInput.placeholder = '搜索书名…';
      // K31 (2026-08-15): 排序下拉 —— 纯内存状态 (this._sortMode), 不持久化, 默认 recent
      const sortSel = el('select', 'prep-select');
      [
        { key: 'recent', label: '最近打开' },
        { key: 'title', label: '书名 A-Z' },
        { key: 'progress', label: '阅读进度' },
        { key: 'added', label: '添加时间' },
      ].forEach((o) => {
        const opt = el('option', null, o.label);
        opt.value = o.key;
        sortSel.appendChild(opt);
      });
      sortSel.value = this._sortMode || 'recent';
      sortSel.addEventListener('change', () => {
        this._sortMode = sortSel.value;
        this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar, shelfEl);
      });
      // K31: 卡片大小切换 —— 紧凑/大图二态按钮, 默认大图。
      // 2026-08-17 (用户反馈"点紧凑要默认保存"): 原来是纯内存状态, 切走页面或重启
      // 就退回大图。改成落 localStorage(同 aidulc.lastProfile 的做法), 属于"这台机器
      // 上这个人的显示偏好", 不进 reader_settings 那张按档案存学习设置的表。
      const sizeBtn = el('button', 'btn-small', this._cardCompact ? '大图' : '紧凑');
      sizeBtn.title = this._cardCompact ? '切换为大图卡片' : '切换为紧凑卡片';
      sizeBtn.addEventListener('click', () => {
        this._cardCompact = !this._cardCompact;
        sizeBtn.textContent = this._cardCompact ? '大图' : '紧凑';
        sizeBtn.title = this._cardCompact ? '切换为大图卡片' : '切换为紧凑卡片';
        listEl.classList.toggle('book-list--compact', this._cardCompact);
        this._saveCompact(this._cardCompact);
      });
      // 2026-08-18 (用户): "放一个刷新按钮"。除了兜住"某条路径忘了发 library-changed"
      // 这类问题, 手动刷新本身也是用户合理的诉求 —— 页面显示的是磁盘+DB 的快照,
      // 用户在别处动过东西(比如手动删了书包目录)时得有个不重启就能重读的入口。
      const refreshBtn = el('button', 'btn-small', '刷新');
      refreshBtn.title = '重新读取书库 (删除/外部改动后没刷新时点这里)';
      refreshBtn.addEventListener('click', () => {
        refreshBtn.disabled = true;
        Promise.resolve(this._reload && this._reload())
          .then(() => AiduToast.show('已刷新', 'success'))
          .finally(() => { refreshBtn.disabled = false; });
      });
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
          this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar, shelfEl);
        });
        segBar.appendChild(seg);
      });
      toolbar.append(searchInput, sortSel, sizeBtn, refreshBtn, segBar);
      wrap.insertBefore(toolbar, listEl);

      // Bug fix (审查确认): 注销旧监听 (每次 render 叠加导致 listener 累积)
      this._off && this._off();
      this._off = this.store.on('change', (s) => this._renderBooks(listEl, s.books, searchInput, segBar, shelfEl));
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
       // 挂到实例上: 刷新按钮和"删除后重取"都在 render 作用域外, 需要拿到它
       this._reload = loadBooks;
      if (this.kind === 'original') {
        const loadJobs = () => AiduJobService.list().then((res) => {
          this._jobs = (res.ok && res.data) || [];
          // UX5 #1 (2026-08-13): 轮巡只增量刷进度条, 不再整列 _renderBooks ——
          // 整列重建会把用户展开的译本全部折回 collapsed (UX4 修好 toggle 后仍被冲掉)。
          this._updateJobProgress(listEl);
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
        this._renderBooks(listEl, books, searchInput, segBar, shelfEl);
      }
      searchInput.oninput = () => this._renderBooks(listEl, this.store.state.books || [], searchInput, segBar, shelfEl);
      container.appendChild(wrap);
    }

    _renderBooks(listEl, books, searchInput, segBar, shelfEl) {
      listEl.innerHTML = '';
      const parseTitle = (b) => (global.AiduTitleCleanup ? global.AiduTitleCleanup.parseBookTitle(b.title || b.id).title : (b.title || b.id));
      if (shelfEl) global.AiduLibraryCover.renderShelf(shelfEl, books, { onOpenBook: (b) => this.onOpenBook && this.onOpenBook(b), parseTitle });
      if (!books || books.length === 0) {
        const empty = el('div', 'book-empty', this.kind === 'original'
          ? '书库还是空的。用上方"导入书籍"卡片, 拖入或选择一本 EPUB / PDF / TXT。'
          : '还没有完成的书。书库导入 → 阅读准备处理完成后, 会出现在这里。');
        listEl.appendChild(empty);
        return;
      }
      // 阶段6 设计交付 §01: 状态分段带计数 (已就绪/处理中/未处理)
      global.AiduLibraryStatus.updateSegCounts(books, segBar);
      // I-D: 搜索 + 筛选 (分段状态映射见 _statusBuckets)
      const q = (searchInput && searchInput.value || '').toLowerCase();
      const filter = this._statusFilter || 'all';
      // F30/K31: 排序由 this._sortMode 决定 (默认 recent, 规则与历史完全一致)
      const sorted = this._sortBooks(books);
      const filtered = sorted.filter(b => {
        if (q && !(b.title || b.id).toLowerCase().includes(q)) return false;
        if (filter !== 'all' && !global.AiduLibraryStatus.inStatusBucket(b, filter)) return false;
        return true;
      });
      if (!filtered.length && !(this.kind === 'original')) {
        listEl.appendChild(el('div', 'book-empty', '没有符合条件的书。'));
        return;
      }
      // G1 (2026-08-11): 原书库网格最后一格是"导入"虚线格 (同书卡尺寸)。
      // 搜索/筛选时导入格仍显示 (它是入口, 不是书)。
      if (this.kind === 'original') {
        listEl.appendChild(this._buildImportGridCell());
      }
      if (!filtered.length) {
        listEl.appendChild(el('div', 'book-empty', '没有符合条件的书。'));
        return;
      }
      filtered.forEach(book => {
        const card = el('div', 'book-card');
        // UX5 #1 (2026-08-13): 卡片带 data-book-id —— 轮巡按 id 找卡只刷进度条, 不整列重建
        card.dataset.bookId = String(book.id);
        // K2-2: product 书自带 pack_dir; original 书借第一个译本的封面(通常同一本源书)。
        const coverSrc = this.kind === 'product' ? book : (Array.isArray(book.editions) && book.editions[0]);
        card.appendChild(global.AiduLibraryCover.build(book.title || book.id, coverSrc && coverSrc.pack_dir, coverSrc && coverSrc.cover_file));
        // G5 (2026-08-11): 书名/作者清洗 —— 文件名原样上屏不是设计 (z-library 后缀/作者括括号)。
        // 拆成 书名 + 作者 两行; 解析不出就保留原串。
        const parsed = global.AiduTitleCleanup ? global.AiduTitleCleanup.parseBookTitle(book.title || book.id) : { title: book.title || book.id, author: null };
        const name = el('div', 'book-card-title', parsed.title);
        if (parsed.author) {
          const authorEl = el('div', 'book-card-author', parsed.author);
          card.appendChild(authorEl);
        }
        const profileLabel = this._profileName(book.profile_id);
        const langLabel = { en: '英文', ja: '日文' }[book.source_language] || book.source_language || '英文';
        const st = global.AiduLibraryStatus.bookStatus(book);
        // M1-a (2026-08-12): 成品文件缺失时状态徽章被 pack_state 覆盖 —— 数据没了不许
        // 再显示「已就绪」假装可读。徽章文案直接来自事实 (missing/incomplete)。
        const badPack = book.pack_state && book.pack_state !== 'ok';
        const effSt = badPack
          ? { label: book.pack_state === 'missing' ? '成品文件缺失' : '成品文件不完整', cls: 'badge-err' }
          : st;
        const badge = el('span', 'book-badge ' + effSt.cls, effSt.label);
        // G4 (2026-08-11): 章数从 edition 取 (原书登记时不填 chapter_count); 句数/时长补齐。
        const editionsArr = Array.isArray(book.editions) ? book.editions : [];
        const chapterCount = this._chapterCount(book);
        const sentenceCount = editionsArr.reduce((s, e) => s + (e.sentence_count || 0), 0);
        const audioSec = editionsArr.reduce((s, e) => s + (e.audio_seconds || 0), 0);
        const metaBits = [`${chapterCount} 章`];
        if (sentenceCount) metaBits.push(`${sentenceCount} 句`);
        if (audioSec) {
          const h = Math.floor(audioSec / 3600), m = Math.floor((audioSec % 3600) / 60);
          metaBits.push(h > 0 ? `${h}h${m}m 音频` : `${m}m 音频`);
        }
        const meta = el('div', 'book-card-meta',
          metaBits.join(' · ') + ' · ' + `${langLabel}→中文 · ${profileLabel}` +
          (book.failed_count ? ` · ${book.failed_count} 句失败` : ''));
        meta.prepend(badge);
        // AUTOSTANDARDIZE: 第二档徽章(转换痕迹), DOM 构造在 library/status.js。
        global.AiduLibraryStatus.appendStandardizeBadge(meta, book, el);
        // K2-4 (2026-08-13): 阅读状态独立成一排对齐的统计块 (是否读了/读了多久/多少笔记/
        // 多少书签), 不再拼进一整条字符串——数字对不齐、弱视觉层级是本期治理的问题之一。
        // 阅读时长此前挂在"有 reading_chapter 才显示"的条件下, 现在独立判断 time_spent_ms
        // (听过但还没翻页也该看到"读过")。
        const stats = el('div', 'book-card-stats');
        if (book.reading_chapter != null && chapterCount > 0) {
          const pct = Math.round(((book.reading_chapter + 1) / chapterCount) * 100);
          stats.appendChild(el('span', 'book-stat', `读到第 ${book.reading_chapter + 1} 章 · ${pct}%`));
        }
        if (book.time_spent_ms > 60000) {
          stats.appendChild(el('span', 'book-stat', `已读 ${Math.round(book.time_spent_ms / 60000)} 分钟`));
        }
        if (book.notes_count) {
          stats.appendChild(el('span', 'book-stat', `📝 ${book.notes_count} 条笔记`));
        }
        if (book.bookmarks_count) {
          stats.appendChild(el('span', 'book-stat', `🔖 ${book.bookmarks_count} 个书签`));
        }
        if (stats.childElementCount) card.appendChild(stats);
        // R6 改进: 处理中的书显示实时进度 (来自 job_list 匹配)
        if (book.status === 'processing') {
          const job = (this._jobs || []).find(j => j.book_path && book.source_path &&
            j.book_path.replace(/\\/g, '/') === book.source_path.replace(/\\/g, '/'));
          if (job && job.total > 0) {
            const pct = Math.round((job.current / job.total) * 100);
            const stLabel = global.AiduLibraryStatus.STAGE_LABEL[job.stage] || job.stage;
            const pbar = el('div', 'prep-bar');
            const pfill = el('div', 'prep-bar-fill');
            pfill.style.width = pct + '%';
            pbar.appendChild(pfill);
            const ptext = el('div', 'book-progress-text', `${stLabel} ${pct}% · ${job.current}/${job.total} 句`);
            card.appendChild(pbar);
            card.appendChild(ptext);
          }
        }

        // G2 (2026-08-11): 每卡至多一个主按钮。删除/预览/设置收进「详情」overflow 菜单。
        const actions = el('div', 'book-card-actions');
        const canOpen = book.status === 'ready' || book.status === 'partial';
        if (this.kind === 'product') {
          // L2/M1-a (2026-08-11/12): 成品文件缺失 —— pack_state = missing/incomplete 时
          // 书卡红色报错 (徽章已被 badPack 覆盖), 不再显示"已就绪"假装可读。
          // 给出两个出口: 重新生成译本 / 移除这个译本记录。
          if (badPack) {
            const reason = el('div', 'book-card-err-hint',
              book.pack_state === 'missing'
                ? '这本书的成品文件找不到了 (目录已被移动或删除)。可以从原书重新生成, 或移除这个译本记录。'
                : '这本书的目录还在但内容不完整 (可能被清理过)。可以重新生成, 或移除这个译本记录。');
            card.appendChild(reason);
            const regenBtn = el('button', 'btn-small btn-primary', '重新生成译本');
            regenBtn.onclick = () => this._regenerateEdition(book);
            actions.append(regenBtn);
            const rmBtn = el('button', 'btn-small', '移除这个译本记录');
            rmBtn.onclick = () => this._removeEdition(book);
            actions.appendChild(rmBtn);
          } else {
            const openBtn = el('button', 'btn-small btn-primary', '打开阅读');
            openBtn.disabled = !canOpen;
            if (!canOpen) { openBtn.title = '这本书还在准备中, 完成后再来读'; openBtn.classList.add('btn-disabled'); }
            openBtn.onclick = () => this.onOpenBook && this.onOpenBook(book);
            actions.append(openBtn);
          const menuBtn = el('button', 'btn-small', '⋯');
          // K12 (2026-08-14): 只在没封面时提供"补封面"入口, 有封面的书不需要
          menuBtn.onclick = () => this._openBookMenu(book, { export: true, delete: true, online: true, backfillCover: !book.cover_file });
          actions.appendChild(menuBtn);
          }
        } else {
          // 原版书库: 主按钮 = 创建/新增译本 (G6: 措辞统一不再因有无译本换词);
          // 预览/设置/删除收进「详情」。
          const hasEditions = Array.isArray(book.editions) && book.editions.length > 0;
          const createBtn = el('button', 'btn-small btn-primary', '创建译本');
          createBtn.onclick = () => this._chooseEditionProfile(book);
          if (book.status === 'processing' && !hasEditions) {
            createBtn.style.display = 'none';
          }
          actions.append(createBtn);
          const menuBtn = el('button', 'btn-small', '⋯');
          // 2026-08-17: 补封面接到这里。K12 当初只把它写进 kind==='product' 分支, 而
          // main.js 只挂了 new LibraryView(store,'original') 这一个视图 —— 那个分支
          // 在 UI 上根本到不了, 这个功能从写出来就是点不到的(用户实测: 书卡 ⋯ 和
          // 译本 ⋯ 里都没有)。封面属于译本不属于原书, 所以目标是第一个缺封面的译本。
          const coverless = (Array.isArray(book.editions) ? book.editions : []).find((e) => !e.cover_file);
          menuBtn.onclick = () => this._openBookMenu(book, {
            preview: true, settings: true, delete: true, online: true,
            backfillCover: !!coverless, backfillTarget: coverless,
          });
          actions.appendChild(menuBtn);
        }
         card.append(name, meta, actions);
         // M1-a (2026-08-12): 原版书卡有译本成品丢失时同样标红提示 (徽章已被 badPack
         // 覆盖), 出口在展开的译本子卡上 (每个坏译本有自己的重新生成/移除)。
         if (badPack && this.kind === 'original') {
           card.appendChild(el('div', 'book-card-err-hint',
             book.pack_state === 'missing'
               ? '这本书有译本成品文件找不到了。展开下方译本列表, 可重新生成或移除记录。'
               : '这本书有译本成品目录不完整。展开下方译本列表, 可重新生成或移除记录。'));
         }
         // G3 (2026-08-11): 译本/成品列表默认折叠 —— 显示「译本 (N) ▸」, 点开才铺。
         // M1-b (2026-08-12): 折叠开关切的是真正藏内容的 .edition-body —— 此前切外层
         // editions 容器, 箭头会变但内容永远展不开 (用户看到的就是"点了没反应")。
         // 箭头方向按状态: 折叠 ▸ / 展开 ▾ (初始折叠所以是 ▸)。
         // UX5 #1 (2026-08-13): 初始状态由 this._expanded 决定 —— 用户展开过的书重建后保持展开。
         if (this.kind === 'original' && Array.isArray(book.editions) && book.editions.length) {
           const editions = el('div', 'edition-list');
           const expanded = this._expanded.has(book.id);
           const toggle = el('button', 'edition-toggle',
             `译本 (${book.editions.length}) ${expanded ? '▾' : '▸'}`);
           editions.appendChild(toggle);
           const body = el('div', 'edition-body' + (expanded ? '' : ' collapsed'));
           toggle.onclick = () => {
             const collapsed = body.classList.toggle('collapsed');
             if (collapsed) this._expanded.delete(book.id);
             else this._expanded.add(book.id);
             toggle.textContent = `译本 (${book.editions.length}) ${collapsed ? '▸' : '▾'}`;
           };
           book.editions.forEach((edition) => {
             const child = el('div', 'edition-card');
             const childTitle = el('div', 'book-card-title', edition.title || edition.id);
             const childProfile = this._profileName(edition.profile_id);
             // G7 (2026-08-11): 模型显示登记时的人话展示名, 原始文件名收进 title 悬浮。
             const childModel = [edition.llm_id, edition.tts_id].map((p) => this._modelDisplayName(p)).filter(Boolean).join(' · ') || '默认模型';
             const childMeta = el('div', 'book-card-meta',
               `${childProfile} · ${edition.source_language || 'en'}→${edition.target_language || 'zh-CN'} · ${childModel}`);
             childMeta.title = [edition.llm_id, edition.tts_id].filter(Boolean).join('\n');
              const childActions = el('div', 'book-card-actions');
               const childCanOpen = ['ready', 'partial'].includes(edition.status);
              // L2 (2026-08-11): 展开的译本子卡同样标红 + 点击给明确错误, 不静默无反应。
              if (edition.pack_state && edition.pack_state !== 'ok') {
                const childErr = el('span', 'book-badge badge-err',
                  edition.pack_state === 'missing' ? '成品文件缺失' : '成品文件不完整');
                childMeta.prepend(childErr);
                const childRegen = el('button', 'btn-small btn-primary', '重新生成译本');
                childRegen.onclick = () => this._regenerateEdition(edition);
                const childRm = el('button', 'btn-small', '移除这个译本记录');
                childRm.onclick = () => this._removeEdition(edition);
                childActions.append(childRegen, childRm);
              } else {
                const childOpen = el('button', 'btn-small btn-primary', '打开阅读');
                childOpen.disabled = !childCanOpen;
                if (!childCanOpen) {
                  childOpen.title = '这本书还在准备中, 完成后再来读';
                  childOpen.classList.add('btn-disabled');
                }
                childOpen.onclick = () => this.onOpenBook && this.onOpenBook(edition);
                const childMenu = el('button', 'btn-small', '⋯');
                childMenu.onclick = () => this._openBookMenu(edition, { delete: true, editionChild: true });
                childActions.append(childOpen, childMenu);
              }
              child.append(childTitle, childMeta, childActions);
             body.appendChild(child);
           });
           editions.appendChild(body);
           card.appendChild(editions);
         }
          listEl.appendChild(card);
      });
    }

    /** K31 (2026-08-15): 排序比较 —— recent(默认, 与历史一致)/title/progress/added */
    _sortBooks(books) {
      const mode = this._sortMode || 'recent';
      const arr = books.slice();
      const titleKey = (b) => (b.title || b.id);
      const cmp = {
        recent: (a, b) => {
          const la = a.last_opened_at || 0;
          const lb = b.last_opened_at || 0;
          if (la !== lb) return lb - la;
          return titleKey(a).localeCompare(titleKey(b));
        },
        title: (a, b) => titleKey(a).localeCompare(titleKey(b)),
        progress: (a, b) => {
          const ra = this._readingProgress(a);
          const rb = this._readingProgress(b);
          if (rb !== ra) return rb - ra;
          return titleKey(a).localeCompare(titleKey(b));
        },
        added: (a, b) => {
          const va = a.created_at != null ? a.created_at : a.id;
          const vb = b.created_at != null ? b.created_at : b.id;
          if (va === vb) return 0;
          return va > vb ? -1 : 1;
        },
      }[mode];
      return cmp ? arr.sort(cmp) : arr;
    }

    /** K31: 阅读进度比例 (0~1), 未开始读/无章数按 0 (进度排序时沉底) */
    _readingProgress(book) {
      const cc = this._chapterCount(book);
      if (!cc || book.reading_chapter == null) return 0;
      return (book.reading_chapter + 1) / cc;
    }

    /** G4/K31: 章数从 edition 取 (原书登记时不填 chapter_count), 无 edition 退回书级 */
    _chapterCount(book) {
      const editionsArr = Array.isArray(book.editions) ? book.editions : [];
      if (editionsArr.length) return Math.max(...editionsArr.map((e) => e.chapter_count || 0));
      return book.chapter_count || 0;
    }

    /** UX5 #1 (2026-08-13): 轮巡增量更新 —— 只刷对应卡片进度条, 不整列重建。
     *  卡片按 data-book-id 匹配; 任务进行中时补/更 .prep-bar-fill 宽度 + 文案。
     *  任务完成/书状态变化由 library-changed 事件触发整列刷新 (原有机制, 这里不动)。 */
    _updateJobProgress(listEl) {
      if (!listEl) return;
      const jobs = this._jobs || [];
      const books = this.store.state.books || [];
      listEl.querySelectorAll('.book-card').forEach((card) => {
        const bookId = card.dataset && card.dataset.bookId;
        if (!bookId) return;
        const book = books.find((b) => String(b.id) === String(bookId));
        if (!book || book.status !== 'processing') return;
        const job = jobs.find((j) => j.book_path && book.source_path &&
          j.book_path.replace(/\\/g, '/') === book.source_path.replace(/\\/g, '/'));
        if (!job || !(job.total > 0)) return;
        const pct = Math.round((job.current / job.total) * 100);
        const stLabel = global.AiduLibraryStatus.STAGE_LABEL[job.stage] || job.stage;
        let pbar = card.querySelector('.prep-bar');
        if (!pbar) {
          // 书卡渲染时还是 pending、任务随即开始 —— 增量补上进度条 (只动这张卡)
          pbar = el('div', 'prep-bar');
          pbar.appendChild(el('div', 'prep-bar-fill'));
          card.appendChild(pbar);
        }
        const pfill = pbar.querySelector('.prep-bar-fill');
        if (pfill) pfill.style.width = pct + '%';
        let ptext = card.querySelector('.book-progress-text');
        if (!ptext) { ptext = el('div', 'book-progress-text'); card.appendChild(ptext); }
        ptext.textContent = `${stLabel} ${pct}% · ${job.current}/${job.total} 句`;
      });
    }

    /** M6: 档案 id → 显示名 (自建档案查表, 内建兜底, 查不到显示未知) */
    _profileName(id) {
      const p = (this._profiles || []).find((x) => x.id === id);
      if (p && p.name) return p.name;
      const builtin = AiduBuiltinProfiles.BUILTIN_PROFILES[id];
      if (builtin) return builtin.name;
      if (!id) return AiduBuiltinProfiles.BUILTIN_PROFILES.default.name;
      return '未知档案';
    }

    /** G7 (2026-08-11): 模型 id → 人话展示名。模型 id 形如 llm|en|qwen3-4b|2507-q4_k_m,
     *  原始文件名 (Qwen3-4B-Instruct-2507-Q4_K_M.gguf) 收进 title 悬浮。 */
    _modelDisplayName(id) {
      if (!id) return '';
      const s = String(id);
      // 从模型注册表里查展示名 (models_list 数据); 查不到退化用 id 末段
      if (this._models && Array.isArray(this._models)) {
        const m = this._models.find((x) => x.id === s || x.model_id === s);
        if (m) {
          const family = m.family === 'tts' ? '语音' : m.family === 'nlp' ? 'NLP' : '讲解';
          const short = (m.model_id || '').split('-').slice(0, 2).join(' ') || m.model_id;
          return `${short} · ${family}`;
        }
      }
      // 退化: id 是路径时取文件名; 是注册表 id 时取中间段
      const isPath = /[\\/]/.test(s);
      const base = isPath ? s.split(/[\\/]/).pop() : s;
      const segs = base.split('|').filter(Boolean);
      const model = segs[2] || segs[0] || base;
      const short = model.replace(/\.(gguf|pth|bin)$/i, '').split('-').slice(0, 2).join(' ');
      return short || base;
    }

    /** G2 (2026-08-11): 书卡 ⋯ 详情菜单 —— 删除等危险动作必须进二级 + 二次确认 */
    _openBookMenu(book, opts) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'vocab-menu';
      box.setAttribute('role', 'menu');
      const items = [];
      if (opts && opts.preview) items.push(['预览原文', () => this._openPreview(book)]);
      if (opts && opts.settings) items.push(['设置', () => this._openBookSettings(book)]);
      if (opts && opts.export) items.push(['导出 (zip)', () => this._exportBookZip(book)]);
      // UX5 #6 (2026-08-13): L8② 整本外发入口 —— 开启时每本确认外发量后再发
      if (opts && opts.online) items.push(['整本翻译/讲解(在线)', () => this._onlineWholeBook(book)]);
      // K12 (2026-08-14): 补封面——只重跑封面抽取这一步(几秒钟), 不是重新备料整本书
      // backfillTarget: 原书卡上点补封面时, 真正要补的是它下面那个缺封面的译本
      // (封面存在译本的书包里, 原书没有 pack_dir)
      if (opts && opts.backfillCover) {
        items.push(['补封面', () => this._backfillCover((opts && opts.backfillTarget) || book)]);
      }
      if (opts && opts.delete) {
        items.push(['删除' + (opts.editionChild ? '译本' : ''), () => {
          const isChild = !!opts.editionChild;
          AiduModal.confirm({
            title: isChild ? `删除译本《${book.title || book.id}》?` : `删除《${book.title}》?`,
            message: isChild
              ? '只删除这个译本, 原书和其它译本保留。'
              : '原书及其全部译本、阅读进度、书签和处理任务都会移除, 无法恢复。',
            confirmText: '删除', danger: true,
            // 2026-08-18: 原来是 `store.emit('change', store.state)` —— 拿**没变过的
            // 旧 books 数组**重渲染一遍, 删掉的译本当然还在页面上(用户报的"删除译本
            // 以后刷新有问题"就是这个)。要重新去后端取。
            onConfirm: () => AiduLibraryService.remove(book.id, true)
              .then(() => {
                AiduToast.show('已删除' + (isChild ? '译本' : '《' + (book.title || '') + '》'), 'success');
                return this._reload && this._reload();
              }),
          });
        }]);
      }
      items.forEach(([label, fn]) => {
        const it = el('button', 'vocab-menu-item', label);
        it.onclick = () => { ov.remove(); fn(); };
        box.appendChild(it);
      });
      ov.appendChild(box);
      ov.addEventListener('click', (ev) => { if (ev.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

    /** K12 (2026-08-14): 补封面——K2-2 封面管线上线前跑完的老 edition 没有封面,
     *  只重跑"从源 EPUB 抽封面拷进书包根"这一步(几秒钟), 不碰已生成的译文/音频。 */
    _backfillCover(book) {
      AiduToast.show('正在抽取封面…', 'info');
      AiduLibraryService.backfillCover(book.id).then((r) => {
        if (!r.ok) { AiduToast.show('补封面失败: ' + r.error, 'error'); return; }
        if (!r.data || !r.data.cover) {
          AiduToast.show('这本源书本身没有封面, 补不出来', 'info');
          return;
        }
        AiduToast.show('封面已补上', 'success');
        this.store.emit('change', this.store.state);
        AiduLibraryService.list(this.kind).then((lr) => {
          if (lr.ok) this.store.set({ books: lr.data });
        });
      });
    }

    /** L1-d/L2 (2026-08-11): 成品文件缺失 → 重新生成译本 (复用创建译本流程, 源 EPUB 路径在 books.source_path)。 */
    _regenerateEdition(edition) {
      const source = {
        id: edition.source_id,
        title: edition.title || edition.id,
        profile_id: edition.profile_id || this._storedProfile() || 'default',
        source_language: edition.source_language || 'en',
        target_language: edition.target_language || 'zh-CN',
        llm_id: edition.llm_id,
        tts_id: edition.tts_id,
        nlp_id: edition.nlp_id,
      };
      this._chooseEditionProfile(source);
    }

    /** L2 (2026-08-11): 成品文件缺失 → 移除这个译本记录 (仅删 DB 行, 不碰磁盘文件 —— 磁盘本来就没了)。 */
    _removeEdition(edition) {
      AiduModal.confirm({
        title: `移除译本《${edition.title || edition.id}》记录?`,
        message: '这本书的成品文件已经找不到了, 只移除这条记录 (原书保留, 可以随时重新生成)。',
        confirmText: '移除', danger: true,
        onConfirm: () => AiduLibraryService.remove(edition.id, true)
          .then(() => { this.store.emit('change', this.store.state); AiduToast.show('已移除译本记录', 'success'); }),
      });
    }

    /** 卡片紧凑模式的持久化 (2026-08-17): 同 _storedProfile 的 localStorage 做法。
     *  读失败/没有 localStorage 时退回 false(大图), 不阻塞渲染。 */
    _storedCompact() {
      try { return window.localStorage.getItem('aidulc.lib.compact') === '1'; } catch (e) { return false; }
    }
    _saveCompact(on) {
      try { window.localStorage.setItem('aidulc.lib.compact', on ? '1' : '0'); } catch (e) { /* 无 localStorage 不阻塞 */ }
    }

    /** 默认与预填 (UX 审计 2026-08-09): 记住上次选的档案, 导入/创建译本自动预选 */
    _storedProfile() {
      try { return window.localStorage.getItem('aidulc.lastProfile') || ''; } catch (e) { return ''; }
    }
    _saveProfile(id) {
      try { if (id) window.localStorage.setItem('aidulc.lastProfile', id); } catch (e) { /* 无 localStorage 不阻塞 */ }
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

    // ---- 以下都委托给 views/library/ 下的独立模块 (2026-08-31 治理) ----
    // library_view 曾在一个类里同时装着书卡渲染、任务进度、三个巨型模态、导入导出,
    // 和当初 settings_view "一个 render 塞 5 个 tab" 是同一种病。这里只留接线,
    // 视图状态 (档案列表 / 拖拽槽位 / 去重器 / 批次 id) 仍归本类持有, 通过 deps 传递。

    /** 阶段4 (BOOK_WORKFLOW): source → 配置面板 → 开始备料 → edition */
    _chooseEditionProfile(book) {
      AiduEditionProfileModal.showEditionProfileModal(book, {
        profiles: this._profiles,
        storedProfile: () => this._storedProfile(),
        saveProfile: (id) => this._saveProfile(id),
        startPrep: (b, profileId, cbs) => this._startPrepForBook(b, profileId, cbs),
        onStarted: () => this.store.emit('change', this.store.state),
      });
    }

    /** S4: 预览原文 (书库打开的是原始书籍) */
    _openPreview(book) {
      AiduLibraryPreviewModal.showPreviewModal(book);
    }

    /** 书设置弹窗 (P3 + L10): 改的是这本书下次生成时的默认参数 */
    _openBookSettings(book) {
      AiduBookSettingsModal.showBookSettingsModal(book, {
        profiles: this._profiles,
        storedProfile: () => this._storedProfile(),
        onSaved: () => this.store.emit('change', this.store.state),
      });
    }

    /** 导入导出模块要用到的视图状态 */
    _ioDeps() {
      return {
        store: this.store,
        kind: this.kind,
        dragSlot: this._dragSlot,
        importDedup: this._importDedup,
        onImported: (n, batchId) => { if (this.onImported) this.onImported(n, batchId); },
        onImportError: (e) => { if (this.onImportError) this.onImportError(e); },
        setLastBatchId: (id) => { this._lastBatchId = id; },
      };
    }

    _exportBookZip(book) { AiduLibraryImportExport.exportBookZip(book); }
    _onlineWholeBook(book) { AiduLibraryImportExport.onlineWholeBook(book, this._ioDeps()); }
    _importBookZip() { AiduLibraryImportExport.importBookZip(this._ioDeps()); }
    _buildImportGridCell() { return AiduLibraryImportExport.buildImportGridCell(this._ioDeps()); }
    _startBatchImport(paths) { AiduLibraryImportExport.startBatchImport(paths, this._ioDeps()); }
  }

  global.LibraryView = LibraryView;
})(window);
