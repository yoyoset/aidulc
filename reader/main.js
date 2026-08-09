/**
 * main.js —— 应用入口 (P1): 初始化 bridge → store → shell → router → 各视图
 */
(function () {
  'use strict';

  // ---- 前端全局错误 → 应用日志 (排查反馈全靠它) ----
  (function installErrorLogging() {
    const seen = new Set();
    const send = (level, message) => {
      if (!window.AiduBridge) return;
      if (seen.has(message)) return; // 去重: 循环报错不刷屏
      seen.add(message);
      if (seen.size > 100) seen.clear();
      window.AiduBridge.invoke('log_from_frontend', { level, module: 'frontend', message }).catch(() => {});
    };
    window.addEventListener('error', (e) => {
      send('error', `[${e.filename || ''}:${e.lineno}] ${e.message}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      send('error', `[unhandledrejection] ${String(e.reason && e.reason.stack || e.reason)}`);
    });
  })();

  const app = document.getElementById('app');

  const store = new AiduStore();
  const shell = new ShellView(app);
  shell.render();
  const startupLoading = document.createElement('div');
  startupLoading.className = 'app-loading';
  startupLoading.textContent = '正在启动 aidulc…';
  shell.getViewContainer().appendChild(startupLoading);

  const router = new AiduRouter(shell.getViewContainer());
  shell.setRouter(router);

  // ---- 视图实例 ----
  const libraryView = new LibraryView(store, 'original');
  const prepView = new PrepView(store);
  const settingsView = new SettingsView(store);
  const readerView = new ReaderView(store);
  const wizardView = new WizardView(store);
  const vocabView = new VocabView(store);
  const reviewView = new ReviewView(store);

  // ---- 首次运行: 向导拦截 ----
  AiduModelService.wizardState().then((res) => {
    startupLoading.remove();
    if (!res.ok) throw new Error(res.error || '无法读取首次启动状态');
    if (res.ok && res.data && res.data.status === 'done') {
      router.start();
    } else {
      // 向导未完成 → 全屏向导
      shell.setActiveNav('');
      shell.getViewContainer().innerHTML = '';
      wizardView.onDone = () => router.navigate('library');
      wizardView.render(shell.getViewContainer());
    }
  }).catch((err) => {
    startupLoading.remove();
    shell.getViewContainer().innerHTML = '';
    const error = document.createElement('div');
    error.className = 'global-error';
    error.textContent = '应用启动失败：' + String(err && err.message || err);
    shell.getViewContainer().appendChild(error);
  });

  // ---- 路由 ----
  router.register('library', (container) => {
    shell.setActiveNav('library');
    readerView.cleanup();
    prepView.cleanup();
    if (libraryView._jobTimer) clearInterval(libraryView._jobTimer);
    libraryView.render(container);
    AiduLibraryService.list('original').then((res) => {
      if (res.ok) store.set({ books: res.data });
      else shell.showError('读书库失败: ' + res.error);
    });
  });

  // 旧成品架路由只做兼容重定向；译本现在统一显示在“我的书”的原书卡下。
  router.register('products', () => router.navigate('library'));

  router.register('prep', (container) => {
    shell.setActiveNav('prep');
    readerView.cleanup();
    libraryView.cleanup();
    prepView.render(container);
    prepView.onOpenBook = (bookId, packDir) => {
       // G6: 任务完成 → 打开书籍 (译本现在归属于“我的书”中的原书)
       store.set({ currentBook: { id: bookId, title: packDir.split(/[\\/]/).pop() || bookId } });
       store.set({ readerBackRoute: 'library' });
      router.navigate('reader');
    };
  });

  router.register('settings', (container) => {
    shell.setActiveNav('settings');
    readerView.cleanup();
    prepView.cleanup();
    libraryView.cleanup();
    settingsView.render(container);
  });

  // 阶段6 设计交付 §10 item 4/8: 模型中心并入设置 → 旧 models 路由重定向到设置
  // UX 审计 (2026-08-09): 重定向时带 settingsTab 意图, 让"去模型中心"按钮直达模型中心
  // tab (此前落在设置默认的"系统与书库"页, 用户还要自己找)。
  router.register('models', () => {
    store.set({ settingsTab: 'models' });
    router.navigate('settings');
  });

  router.register('vocab', (container) => {
    shell.setActiveNav('vocab');
    readerView.cleanup();
    prepView.cleanup();
    libraryView.cleanup();
    reviewView.cleanup();
    vocabView.render(container);
  });

  // V3 (2026-08-09): 桌面三栏背单词
  router.register('review', (container) => {
    shell.setActiveNav('review');
    readerView.cleanup();
    prepView.cleanup();
    libraryView.cleanup();
    vocabView.cleanup?.();
    reviewView.render(container);
  });

  router.register('reader', (container) => {
    shell.setActiveNav('reader');
    const current = store.state.currentBook;
    if (!current) {
      // 没选书 → 回书库
      router.navigate('library');
      return;
    }
    readerView.render(container);
    readerView.onBack = () => router.navigate(store.state.readerBackRoute || 'library');
    readerView.open(current.id).catch(err => shell.showError(String(err)));
  });

  // 导入成功 → 提示下一步是"创建译本" (阶段2: 原书 ≠ 可阅读成品)
  libraryView.onImported = (count) => {
    store.set({ importedNotice: { count, ts: Date.now() } });
  };
  libraryView.onImportError = (err) => {
    shell.showError('导入失败: ' + err);
  };

  // 打开书籍 → 阅读器 (书库原版/成品架共用; 成品架返回成品架)
  const openBook = (book, backRoute) => {
    store.set({ currentBook: book });
    store.set({ readerBackRoute: backRoute });
    // F30 (2026-08-08): 登记打开时间 → "最近阅读"有数据源 (last_opened_at)
    AiduLibraryService.open(book.id).then((r) => {
      if (r.ok) {
        const updated = { ...book, last_opened_at: Date.now() };
        store.set({ books: store.state.books.map((b) => (b.id === book.id ? updated : b)) });
      }
    });
    router.navigate('reader');
  };
  libraryView.onOpenBook = (book) => openBook(book, 'library');

  // UX 审计 (2026-08-09): 任务完成 → 全局 toast (不管用户停在哪个页都能看到结果),
  // 长任务不再需要用户自己回来刷新才知道"完成了"。等 300ms 让收尾线程把状态落盘,
  // 以便区分成功/失败 (侧车只保证"跑完了", done/failed 由 Rust 按 bookpack 是否生成判定)。
  AiduBridge.listen('job-progress', (ev) => {
    const p = ev.payload || {};
    if (p.type !== 'job_done') return;
    setTimeout(() => {
      AiduJobService.list().then((res) => {
        if (!res.ok) return;
        const job = (res.data || []).find((j) => j.id === p.jobId);
        if (!job) return;
        const name = String(job.book_path || '').split(/[\\/]/).pop() || job.id;
        if (job.status === 'failed') {
          AiduToast.show(`《${name}》处理失败，去"阅读准备"查看原因`, 'error');
        } else {
          AiduToast.show(`《${name}》处理完成，可以开始阅读了`, 'success');
        }
      });
    }, 300);
  });
})();
