/**
 * views/settings/sync_connect.js —— 同步页的「连接」引导卡 (2026-11-16)
 *
 * 用户反馈: 填了 Worker URL 之后完全不知道怎么继续; 新增后端 / CF Worker URL / 换 token
 * 三处重复又没有说明, 配对手机、加另一台电脑的入口藏在「更多」里。
 * 这里只做一件事: 让人从"没连接"一步走到"已连接", 再顺手给出下一步该点什么。
 *   未连接: ① 同步地址 ② 凭据 → 「连接」。输入框下一句话实时说明当前输入会被怎么用、还缺什么。
 *   已连接: 显示已连地址, 并给「添加另一台电脑」(直接把 6 位码显示出来) 和「手机扫码连接」。
 * 纯判定逻辑在 core/sync_credential.js (有单测)。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * @param {HTMLElement} parent
   * @param {{onConnected?: Function, onPair?: Function}} opts
   * @returns {{setStatus: (d: object) => void, el: HTMLElement}}
   */
  function mount(parent, opts) {
    const C = global.AiduSyncCredential;
    const box = el('div', 'sync-connect');
    box.appendChild(el('h3', null, '连接同步服务器'));
    const stateLine = el('div', 'log-info', '读取中…');

    // ---- 未连接: 两步表单 ----
    const form = el('div', 'sync-connect-form');
    const urlInput = el('input', 'prep-input');
    urlInput.placeholder = '① 同步地址, 如 https://sync.你的域名';
    urlInput.setAttribute('aria-label', '同步地址');
    const credInput = el('input', 'prep-input');
    credInput.type = 'password';
    credInput.placeholder = '② 凭据: ROOT_SECRET (首台设备) 或 6 位邀请码';
    credInput.setAttribute('aria-label', '凭据');
    const hint = el('div', 'import-tip');
    const connectBtn = el('button', 'btn-primary', '连接');
    form.append(urlInput, credInput, hint, connectBtn);

    // ---- 已连接: 下一步 ----
    const next = el('div', 'sync-connect-next');
    next.appendChild(el('div', 'import-tip', '想让别的设备也用这份词库:'));
    const addBtn = el('button', 'btn-small', '添加另一台电脑');
    addBtn.title = '生成一个 6 位邀请码, 10 分钟内有效; 在另一台电脑的同步页填同样的地址 + 这个码';
    const pairBtn = el('button', 'btn-small', '手机扫码连接');
    pairBtn.title = '生成链接/二维码, 手机打开即连';
    const changeBtn = el('button', 'btn-small', '换一个服务器…');
    const codeOut = el('div', 'import-tip');
    const nextRow = el('div', 'page-toolbar');
    nextRow.append(addBtn, pairBtn, changeBtn);
    next.append(nextRow, codeOut);

    box.append(stateLine, form, next);
    parent.appendChild(box);

    const refresh = () => {
      hint.textContent = C.connectHint(urlInput.value, credInput.value);
      connectBtn.disabled = !C.canConnect(urlInput.value, credInput.value);
    };
    const show = (connected) => {
      form.classList.toggle('hidden', connected);
      next.classList.toggle('hidden', !connected);
    };
    urlInput.oninput = refresh;
    credInput.oninput = refresh;
    show(false);
    refresh();

    connectBtn.onclick = () => {
      const a = C.authArgs(urlInput.value, credInput.value);
      connectBtn.disabled = true;
      hint.textContent = '连接中…';
      global.AiduSyncService.authDevice(a.workerUrl, null, a.rootSecret, a.code, '主电脑').then((r) => {
        credInput.value = '';
        if (!r.ok) {
          refresh();
          hint.textContent = '连接失败: ' + (r.error || '未知原因') +
            (a.code ? ' (邀请码 10 分钟内有效, 且只能用一次; 过期了回到已连接的设备重新生成)' : ' (检查地址是否能打开、ROOT_SECRET 是否和服务器上设的一致)');
          return;
        }
        if (global.AiduToast) global.AiduToast.show('已连接', 'success');
        show(true);
        stateLine.textContent = '✓ 已连接 ' + a.workerUrl + ' · 主体 ' + (r.data.user_name || r.data.user_id || '');
        if (opts && opts.onConnected) opts.onConnected(r.data);
      });
    };

    addBtn.onclick = () => {
      addBtn.disabled = true;
      codeOut.textContent = '生成中…';
      global.AiduSyncService.makeCode(null, 'add-device', null).then((r) => {
        addBtn.disabled = false;
        if (!r.ok) { codeOut.textContent = '生成失败: ' + (r.error || ''); return; }
        const code = r.data.code;
        codeOut.textContent = '邀请码 ' + code + ' (10 分钟内有效, 只能用一次)。在另一台电脑: 设置 → 同步 → ① 填同样的同步地址, ② 凭据填 ' + code + ' → 连接。';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).catch(() => {});
      });
    };
    pairBtn.onclick = () => { if (opts && opts.onPair) opts.onPair(); };
    changeBtn.onclick = () => { codeOut.textContent = ''; show(false); refresh(); };

    return {
      el: box,
      setStatus(d) {
        const connected = !!(d && d.configured);
        if (d && d.worker_url && !urlInput.value) urlInput.value = d.worker_url;
        show(connected);
        stateLine.textContent = connected
          ? '✓ 已连接 ' + (d.worker_url || '') + (d.user_id ? ' · ' + d.user_id : '')
          : '还没连接。按下面两步填, 然后点「连接」。';
        refresh();
      },
    };
  }

  global.AiduSyncConnect = { mount };
})(window);
