/**
 * components/snapshot_restore.js —— S2 (2026-11-15): 「从快照恢复」列表
 *
 * 后端每天第一次启动给数据库做一份快照 (放在数据根外面, 见 infrastructure/snapshot.rs)。
 * 之前只会建、不会恢复: 书库根目录丢了, 用户面前仍然只有一个空库。
 *
 * 这个组件同时挂在两处: 设置页「系统与书库」和启动时的「找不到书库」弹窗。
 * 恢复是"暂存, 重启后生效" —— 数据库此刻正被本进程打开, 不能在运行中替换。
 *
 * 只恢复数据库里的东西 (生词 / 阅读进度 / 摘录 / 设置 / 模型登记)。书包和音频文件
 * 不在快照里 (体积大且可以重新生成), 文案里写明, 避免用户以为能找回整个书库。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** 20261109 → 2026-11-09 */
  function fmtDate(d) {
    const s = String(d || '');
    return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) : s;
  }

  function fmtSize(bytes) {
    const mb = (Number(bytes) || 0) / 1048576;
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round((Number(bytes) || 0) / 1024)) + ' KB';
  }

  /**
   * @param {HTMLElement} container 挂载点
   * @param {{onStaged?: function(string)}} [opts] 暂存成功后回调(参数是快照日期)
   */
  function mount(container, opts) {
    const o = opts || {};
    const wrap = el('div', 'snapshot-restore');
    wrap.appendChild(el('p', 'log-info',
      '每天第一次启动会自动存一份数据库快照 (保留最近 7 份)。恢复只会找回生词、阅读进度、摘录、设置和模型登记; ' +
      '书和音频文件不在快照里。恢复在重启应用后生效, 恢复前的数据会另存一份, 不会丢。'));
    const list = el('div', 'snapshot-list');
    const status = el('div', 'sync-status', '');
    wrap.append(list, status);
    container.appendChild(wrap);

    const svc = global.AiduMiscService;
    if (!svc || !svc.snapshotList) {
      status.textContent = '当前版本不支持快照恢复。';
      return wrap;
    }

    const stage = (snap) => {
      const vocab = snap.vocab_count == null ? '' : ` (${snap.vocab_count} 个生词)`;
      global.AiduModal.confirm({
        title: '从 ' + fmtDate(snap.date) + ' 的快照恢复?',
        message: '下次启动时, 当前数据库会被这份快照' + vocab + '替换。\n' +
          '替换前会把当前数据库另存到快照目录 (data-before-restore-*), 恢复错了还能找回。\n\n' +
          '确认后请关闭并重新打开应用。',
        confirmText: '恢复',
        cancelText: '取消',
        danger: true,
        onConfirm: () => svc.snapshotRestore(snap.date).then((r) => {
          if (!r.ok) throw new Error(r.error);
          status.textContent = '已安排恢复到 ' + fmtDate(snap.date) + ' 的快照, 请关闭并重新打开应用生效。';
          if (global.AiduToast) global.AiduToast.show('已安排恢复, 重启后生效', 'success');
          if (typeof o.onStaged === 'function') o.onStaged(snap.date);
        }),
      });
    };

    svc.snapshotList().then((res) => {
      if (!res.ok) { status.textContent = '读取快照列表失败: ' + res.error; return; }
      const snaps = (res.data && res.data.snapshots) || [];
      if (res.data && res.data.pending) {
        status.textContent = '已有一次恢复在等待, 重启应用后生效。';
      }
      if (!snaps.length) {
        list.appendChild(el('p', 'profile-meta', '还没有快照 (每天第一次启动会自动生成)。'));
        return;
      }
      snaps.forEach((snap) => {
        const row = el('div', 'settings-row snapshot-row');
        const vocab = snap.vocab_count == null ? '生词数未知' : snap.vocab_count + ' 个生词';
        row.appendChild(el('span', 'log-info', fmtDate(snap.date) + ' · ' + vocab + ' · ' + fmtSize(snap.size)));
        const btn = el('button', 'btn-small', '恢复到这一份');
        btn.onclick = () => stage(snap);
        row.appendChild(btn);
        list.appendChild(row);
      });
    }).catch((e) => { status.textContent = '读取快照列表失败: ' + String((e && e.message) || e); });

    return wrap;
  }

  global.AiduSnapshotRestore = { mount, fmtDate };
})(window);
