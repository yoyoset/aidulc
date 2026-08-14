/**
 * components/modal.js —— 模态弹窗 (苹果级: 遮罩/Esc 关闭/焦点陷阱/标题+内容+操作)
 * 用法:
 *   const m = AiduModal.confirm({
 *     title: '删除《xx》?',
 *     message: '书的内容和音频都会移除。',
 *     confirmText: '删除', danger: true,
 *     onConfirm: () => {...}   // 返回 Promise 则按钮转"处理中"
 *   });
 *   m.close();  // 程序化关闭
 */
(function (global) {
  'use strict';

  function buildOverlay() {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    ov.appendChild(box);
    document.body.appendChild(ov);
    return { ov, box };
  }

  function makeConfirm(opts) {
    const { ov, box } = buildOverlay();
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = opts.title || '';
    const msg = document.createElement('p');
    msg.className = 'modal-message';
    msg.textContent = opts.message || '';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-small';
    cancelBtn.textContent = opts.cancelText || '取消';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = opts.danger ? 'btn-small btn-danger' : 'btn-small btn-primary';
    confirmBtn.textContent = opts.confirmText || '确定';

    box.append(title, msg);
    // K15 (2026-08-14): 可选附加勾选项 (如"同时删除磁盘文件"), onConfirm 通过闭包读取勾选状态
    if (opts.checkboxLabel) {
      const row = document.createElement('label');
      row.className = 'modal-checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!opts.checkboxDefault;
      row.append(cb, document.createTextNode(' ' + opts.checkboxLabel));
      box.append(row);
      opts.checkboxRef = cb;
    }
    box.append(actions);
    actions.append(cancelBtn, confirmBtn);

    function close() {
      document.removeEventListener('keydown', onKey);
      ov.remove();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    cancelBtn.onclick = close;
    confirmBtn.onclick = () => {
      const r = opts.onConfirm ? opts.onConfirm() : null;
      if (r && typeof r.then === 'function') {
        confirmBtn.disabled = true;
        confirmBtn.textContent = opts.processingText || '处理中…';
        r.then(() => close()).catch((err) => {
          // UX5 修正 (2026-08-13): 确认框里的动作失败必须可见 —— 此前 catch 只重置按钮
          // 不显示错误, 用户看到"点了一下没反应" (迁移/同步等后端拒绝都被静默吞掉, 违反契约第一条)。
          confirmBtn.disabled = false;
          confirmBtn.textContent = opts.confirmText || '确定';
          if (global.AiduToast && opts.onError) opts.onError(err);
          else if (global.AiduToast) AiduToast.show((err && err.message) || String(err), 'error');
        });
      } else {
        close();
      }
    };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    // 焦点: 进弹窗聚焦取消钮 (苹果式, 避免误触确认)
    cancelBtn.focus();
    return { close };
  }

  global.AiduModal = {
    confirm: makeConfirm,
  };
})(window);
