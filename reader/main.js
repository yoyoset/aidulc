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

  const router = new AiduRouter(shell.getViewContainer());
  shell.setRouter(router);

  // ---- 视图实例 ----
  const libraryView = new LibraryView(store, 'original');
  const productsView = new LibraryView(store, 'product');
  const prepView = new PrepView(store);
  const settingsView = new SettingsView(store);
  const readerView = new ReaderView(store);
  const wizardView = new WizardView(store);
  const modelsView = new ModelsView(store);
  const vocabView = new VocabView(store);

  // ---- 首次运行: 向导拦截 ----
  AiduModelService.wizardState().then((res) => {
    if (res.ok && res.data && res.data.status === 'done') {
      router.start();
    } else {
      // 向导未完成 → 全屏向导
      shell.setActiveNav('');
      shell.getViewContainer().innerHTML = '';
      wizardView.onDone = () => router.navigate('library');
      wizardView.render(shell.getViewContainer());
    }
  });

  // ---- 路由 ----
  router.register('library', (container) => {
    shell.setActiveNav('library');
    readerView.cleanup();
    libraryView.render(container);
    if (libraryView._jobTimer) clearInterval(libraryView._jobTimer);
    libraryView.render(container);
    if (productsView._jobTimer) clearInterval(productsView._jobTimer);
    AiduLibraryService.list('original').then((res) => {
      if (res.ok) store.set({ books: res.data });
      else shell.showError('读书库失败: ' + res.error);
    });
  });

  // v7: 成品架 (AI 跑完的书, 可阅读)
  router.register('products', (container) => {
    shell.setActiveNav('products');
    readerView.cleanup();
    productsView.render(container);
    if (libraryView._jobTimer) clearInterval(libraryView._jobTimer);
    AiduLibraryService.list('product').then((res) => {
      if (res.ok) store.set({ books: res.data });
      else shell.showError('读成品失败: ' + res.error);
    });
  });

  router.register('prep', (container) => {
    shell.setActiveNav('prep');
    readerView.cleanup();
    prepView.render(container);
    prepView.onOpenBook = (bookId, packDir) => {
      // G6: 任务完成 → 打开书籍 (成品架路由)
      store.set({ currentBook: { id: bookId, title: packDir.split(/[\\/]/).pop() || bookId } });
      store.set({ readerBackRoute: 'products' });
      router.navigate('reader');
    };
  });

  router.register('settings', (container) => {
    shell.setActiveNav('settings');
    readerView.cleanup();
    settingsView.render(container);
  });

  router.register('models', (container) => {
    shell.setActiveNav('models');
    readerView.cleanup();
    modelsView.render(container);
  });

  router.register('vocab', (container) => {
    shell.setActiveNav('vocab');
    readerView.cleanup();
    vocabView.render(container);
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

  // 导入成功 → 提示去备料台看进度 (区隔: 书库只管导入, 备料台只管进度)
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
    router.navigate('reader');
  };
  libraryView.onOpenBook = (book) => openBook(book, 'library');
  productsView.onOpenBook = (book) => openBook(book, 'products');
})();
