/**
 * components/missing_library_modal.js —— P0-1 (2026-11-09): 「找不到书库」阻断式提示
 *
 * 背景: 数据根指针 (data_root.txt) 指向的目录被删除 / 移动硬盘没插时, 旧启动流程
 * 静默退回默认数据目录并新建空库 —— 用户看到书库、生词、模型登记全空, 却没有任何
 * 提示, 以为数据丢了。
 *
 * 这个弹窗必须**点外部关不掉**, 也不能用 Esc 关闭: 用户必须先明确选择
 * 「重新指定 / 在原位置新建 / 改用默认位置 / 从快照恢复」之一, 否则关掉后只会继续看空书库。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function line(parent, text) {
    parent.appendChild(el('p', null, text));
  }

  function show(status, onDone) {
    const s = status || {};
    const pointer = String(s.pointer || '');
    const fallback = String(s.fallback || '');

    const ov = el('div', 'modal-overlay missing-library-overlay');
    const box = el('div', 'modal-box missing-library-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.appendChild(el('h2', 'modal-title', '找不到书库'));

    const msg = el('div', 'modal-message');
    line(msg, '上次使用的书库位置:');
    msg.appendChild(el('code', 'j0-path', pointer || '(没有记录)'));
    line(msg, '可能原因: 移动硬盘没插 / 目录被移动或删除。');
    msg.appendChild(el('div', 'missing-library-fallback',
      '当前临时位置: ' + (fallback || '(默认数据目录)')));
    line(msg, '在下面选择一个处理方式之前, 本次会话使用的是临时位置, 数据不会自动合并回原书库。');
    box.appendChild(msg);

    const buttons = [];
    const pick = el('button', 'btn-primary', '重新指定书库位置…');
    const recreate = el('button', 'btn-small', '在原位置新建空书库');
    const useDefault = el('button', 'btn-small', '改用默认位置');
    // S2 (2026-11-15): 第 4 个出口 —— 原书库没了, 但每天的数据库快照还在 (放在数据根外面)。
    const restore = el('button', 'btn-small', '从快照恢复数据…');
    buttons.push(pick, recreate, useDefault, restore);

    const statusLine = el('div', 'sync-status', '');
    const snapshotBox = el('div', 'missing-library-snapshots');
    const actions = el('div', 'modal-actions missing-library-actions');
    actions.append(pick, recreate, useDefault, restore);
    box.append(statusLine, snapshotBox, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);

    let busy = false;
    let closed = false;

    const setBusy = (on) => {
      busy = on;
      buttons.forEach((b) => { b.disabled = on; });
    };

    const fail = (e) => {
      setBusy(false);
      statusLine.textContent = '操作失败: ' + String(e && (e.message || e));
    };

    const finish = (text) => {
      if (closed) return;
      closed = true;
      statusLine.textContent = text;
      if (global.AiduToast) global.AiduToast.show(text, 'success');
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          ov.remove();
          if (typeof onDone === 'function') onDone();
        }, 700);
      }
    };

    const run = (call, successText) => {
      if (busy) return;
      setBusy(true);
      statusLine.textContent = '处理中…';
      Promise.resolve(call()).then((r) => {
        if (!r || !r.ok) { fail((r && r.error) || '未知错误'); return; }
        if (r.data && r.data.cancelled) {
          setBusy(false);
          statusLine.textContent = '已取消, 书库位置未更改。';
          return;
        }
        finish(successText);
      }).catch(fail);
    };

    // 1) 选一个新位置: 后端弹目录选择框, 做整根迁移 (空库也会迁移), 然后写指针。
    pick.onclick = () => run(
      () => global.AiduMiscService.libraryDirPickAndSet(),
      '书库位置已更改, 请重启应用。'
    );

    // 2) 在原指针位置重建空书库: 复用整根迁移, 把当前临时库搬到用户原来的位置。
    recreate.onclick = () => {
      if (!pointer) { fail('没有可用的原书库位置'); return; }
      run(
        () => global.AiduMiscService.libraryDirPickAndSet(pointer),
        '已在原位置新建空书库, 请重启应用。'
      );
    };

    // 3) 放弃原指针, 下次启动回到默认数据目录。
    useDefault.onclick = () => run(
      () => global.AiduMiscService.dataRootForgetPointer(),
      '已改用默认位置, 请重启应用。'
    );

    // 4) 从每日快照恢复: 展开快照列表 (恢复在重启后、开库之前生效, 落在本次会话使用的
    //    临时位置的数据库上 —— 想恢复到原书库位置, 先用上面的「重新指定」再恢复)。
    restore.onclick = () => {
      if (!global.AiduSnapshotRestore) { fail('当前版本不支持快照恢复'); return; }
      restore.disabled = true;
      snapshotBox.textContent = '';
      global.AiduSnapshotRestore.mount(snapshotBox);
    };

    // 故意不绑定遮罩点击 / Esc: 这是阻断式提示, 只能通过三个按钮之一离开。

    return { close: () => ov.remove() };
  }

  global.AiduMissingLibraryModal = { show };
})(window);
