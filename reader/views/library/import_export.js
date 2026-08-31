/**
 * views/library/import_export.js —— 书包导入/导出 + 在线整本外发
 *
 * 治理 (2026-08-31): 从 library_view.js 拆出。这几件事和"渲染书卡"是不相关的域,
 * 它们各自有独立的外部交互 (文件对话框、拖拽事件、在线引擎配额确认), 混在视图类里
 * 会让 library_view 既是渲染器又是导入管道。
 *
 * 所有状态仍归 library_view 持有 (拖拽槽位、去重器、批次 id), 本模块通过 deps 读写,
 * 不自己攒状态 —— 拖拽监听的注销时机与视图重渲染绑定, 状态跟着视图走才不会泄漏。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** P1.5: 导出书包为 zip (成品资产, 跨设备迁移) */
  function exportBookZip(book) {
    AiduLibraryService.exportBook(book.id).then((r) => {
      if (!r.ok) { AiduToast.show('导出失败: ' + r.error, 'error'); return; }
      const d = r.data || {};
      if (d.cancelled) return;
      AiduToast.show('已导出到 ' + d.path, 'success');
    });
  }

  /** P1.5: 导入 zip 书包 (免重新处理, 直接进"我的书") */
  function importBookZip(deps) {
    AiduLibraryService.importBook().then((r) => {
      if (!r.ok) { AiduToast.show('导入失败: ' + r.error, 'error'); return; }
      const d = r.data || {};
      if (d.cancelled) return;
      AiduToast.show('已导入《' + d.id + '》, 可在"我的书"里打开', 'success');
      AiduLibraryService.list(deps.kind).then((lr) => {
        if (lr.ok) deps.store.set({ books: lr.data || [] });
      });
    });
  }

  /**
   * UX5 #6 (2026-08-13): L8② 整本外发入口 —— 书卡 ⋯ 菜单「整本翻译/讲解(在线)」。
   * 先查在线引擎配置 (②开关 + key), 再用源译本估算全书外发量, 每本确认后才发。
   * 外发量可能很大且不可撤销, 所以必须先把量算出来给用户看, 不能默默发出去。
   */
  function onlineWholeBook(book, deps) {
    AiduMiscService.onlineConfigGet().then((r) => {
      const d = (r.ok && r.data) || {};
      if (!d.endpoint || !d.key_configured) {
        AiduToast.show('先配置在线引擎 (设置 → 在线引擎 → endpoint + API key) 再整本外发', 'error');
        return;
      }
      if (!d.whole_book_enabled) {
        AiduToast.show('「整本翻译/讲解」未开启: 在 设置 → 在线引擎 勾选 ② 后再试', 'error');
        return;
      }
      // 用第一本译本的 pack 估算外发量 (整本翻译需要一个源译本作为结构来源)
      const editionId = (Array.isArray(book.editions) && book.editions[0] && book.editions[0].id) || book.id;
      AiduLibraryService.loadBookpack(editionId).then((bp) => {
        const b = (bp.ok && bp.data && bp.data.bookpack) || {};
        const chapters = b.chapters || [];
        let sentences = 0, chars = 0;
        chapters.forEach((ch) => (ch.sentences || []).forEach((s) => {
          sentences++;
          chars += String(s.original_text || '').length;
        }));
        const vol = chars > 10000
          ? `全书 ${chapters.length} 章、${sentences} 句、约 ${(chars / 10000).toFixed(1)} 万字`
          : `全书 ${chapters.length} 章、${sentences} 句、约 ${chars} 字符`;
        AiduModal.confirm({
          title: '整本翻译/讲解(在线)?',
          message: `将发送《${book.title || book.id}》全书正文到在线引擎 (${d.endpoint}):\n\n${vol}\n\n` +
            '外发量可能很大, 发送后不可撤销。完成后生成一本无音频的「在线版」译本。',
          confirmText: '开始在线整本翻译',
          danger: true,
          onConfirm: () => AiduBridge.invoke('book_online_translate', { bookId: editionId }).then((res) => {
            if (!res.ok) throw new Error(res.error);
            const r2 = res.data || {};
            AiduToast.show(
              `在线整本翻译完成: ${r2.sentences_done} 句成功` +
              (r2.sentences_failed ? `, ${r2.sentences_failed} 句失败` : ''),
              r2.sentences_failed ? 'warn' : 'success');
            deps.store.emit('change', deps.store.state);
            AiduLibraryService.list('original').then((lr) => {
              if (lr.ok) deps.store.set({ books: lr.data });
            });
          }),
        });
      });
    });
  }

  /** G1 (2026-08-11): 导入格 —— 书卡网格的最后一格, 同尺寸; 拖入/点选即可 */
  function buildImportGridCell(deps) {
    const cell = el('div', 'import-grid-cell');
    const dropZone = el('div', 'prep-dropzone import-grid-drop', '拖入 EPUB / TXT, 或点「导入」逐本选择');
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    if (window.AiduBridge && window.__TAURI__ && window.__TAURI__.event) {
      // 阶段2 (F45): 单一槽位注册, 重渲染时旧的会被新注册自动注销, 不累积
      deps.dragSlot.set(window.AiduBridge.listen('tauri://drag-drop', (ev) => {
        dropZone.classList.remove('drag-over');
        const paths = ev.payload && ev.payload.paths;
        if (paths && paths.length) startBatchImport(paths, deps);
      }));
    }
    dropZone.onclick = () => {
      window.AiduBridge.pickFiles(['epub', 'pdf', 'txt']).then((r) => {
        if (r.ok && r.data && r.data.length) startBatchImport(r.data, deps);
      });
    };
    cell.appendChild(dropZone);
    return cell;
  }

  /**
   * 导入 (R1: 只登记 source 到书库, 不开始处理; 下一步由 source 卡"创建译本"触发)
   * G1 (2026-08-11): 档案/语言参数只在创建译本弹窗一处 —— 导入不再有下拉。
   */
  function startBatchImport(paths, deps) {
    const profileId = 'default';
    const sourceLang = 'en';
    // 阶段2 (F45): 单次动作只导一次 —— 拖拽事件与文件选择同时命中/快速连点都只放行第一次
    if (deps.importDedup && !deps.importDedup.shouldFire(paths, profileId)) return;
    // STDIMPORT (2026-08-17): 先按统一标准体检再登记。之前"导入"完全不碰文件内容,
    // 一本正文丢 95% 的书照样导入成功, 要等用户点了开始处理、烧掉 parse 阶段才发现。
    // AUTOSTANDARDIZE (2026-08-19): 不再有"完全拒绝" —— 不达标(block)的书也照常
    // 登记进书库, 同时把它的路径交给后台自动尝试转换(evaluate 的 pendingStandardize)。
    AiduToast.show(`正在检查 ${paths.length} 本书…`, 'info');
    AiduImportService.auditSources(paths)
      .catch(() => [])   // 体检自身出错不该挡住导入, 当作"判不了"全部放行
      .then((audits) => {
        const gate = global.AiduImportGate.evaluate(paths, audits);
        // m.level 直接就是 toast 的 type('error'/'warning'/'info'), 不用再映射一遍
        gate.messages.forEach((m) => AiduToast.show(m.text, m.level));
        if (!gate.accepted.length) {
          if (deps.onImportError) deps.onImportError('没有符合导入标准的书');
          return null;
        }
        AiduToast.show(`正在导入 ${gate.accepted.length} 本书…`, 'info');
        return AiduImportService.importBooks(gate.accepted, profileId,
          { source: sourceLang, target: 'zh-CN' }, gate.pendingStandardize);
      })
      .then((res) => {
        if (!res) return; // 上一步没发起导入(paths 为空等), 不叠加成功文案
        if (!res.ok) {
          if (deps.onImportError) deps.onImportError(res.error);
          AiduToast.show('导入失败: ' + res.error, 'error');
          return;
        }
        const d = res.data || {};
        // 记录 batch → 书卡出现后"创建译本"用它 (全跳过时为空串, 由创建译本流程自行处理)
        if (deps.setLastBatchId) deps.setLastBatchId(d.batch_id || '');
        const registered = (d.registered || []).length;
        const skipped = (d.skipped || []).length;
        if (deps.onImported) deps.onImported(registered, d.batch_id);
        // 阶段2 (F45): 明确"导入的是原书, 下一步创建译本", 不是"已加入处理队列"
        if (registered === 0) {
          AiduToast.show('这些原书之前已导入, 可直接为它们创建译本', 'success');
        } else if (skipped > 0) {
          AiduToast.show(`已导入 ${registered} 本原书 (${skipped} 个文件之前已导入, 跳过)。下一步: 为原书创建译本。`, 'success');
        } else {
          AiduToast.show(`已导入 ${registered} 本原书。下一步: 为原书创建译本。`, 'success');
        }
        // 刷新书列表
        deps.store.emit('change', deps.store.state);
        AiduLibraryService.list().then((lr) => {
          if (lr.ok) deps.store.set({ books: lr.data });
        });
      }).catch((e) => {
        if (deps.onImportError) deps.onImportError(String(e));
        AiduToast.show('导入失败: ' + e, 'error');
      });
  }

  global.AiduLibraryImportExport = {
    exportBookZip, importBookZip, onlineWholeBook, buildImportGridCell, startBatchImport,
  };
})(window);
