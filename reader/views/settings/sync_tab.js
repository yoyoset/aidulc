/**
 * views/settings/sync_tab.js —— 设置页「同步与数据」tab (背单词状态跨设备同步)
 * 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 settings_view.js 拆出。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsSyncTab {
    /** @param {HTMLElement} pane 挂载点(「同步与数据」tab 的 pane) */
    render(pane) {
            // I-C: 同步配置与状态 (V6 按当前 user 分账, 协议 v1)
            const syncSec = el('div', 'settings-section');
            syncSec.appendChild(el('h2', null, '同步 (背单词状态跨设备)'));
            // K22 (2026-08-14, 用户拍板): 同步范围就是只同步生词表, 不含摘录/书签/阅读进度/
            // 设置——之前只有标题隐含这个意思, 没有显式文案。用户确认这就是想要的边界(不是
            // 遗漏), 只是要让边界看得见, 不是隐含行为。
            const scopeNote = el('div', 'log-info', '同步范围: 只同步生词/背单词进度, 不含摘录、书签、阅读进度和阅读器设置——这些留在本机。');
            syncSec.appendChild(scopeNote);
            const syncStatus = el('div', 'sync-status', '读取中…');
            // L11 (2026-08-11): 后端列表 —— "谁的库选谁的"。每项 = 名称 + URL + 状态,
            // 当前生效高亮; 可切换 / 新增 / 删除。
            const backendList = el('div', 'sync-backend-list');
            const backendAddRow = el('div', 'settings-row');
            const backendNameInput = el('input', 'prep-input');
            backendNameInput.placeholder = '名称 (如 家里的 / 单位 的)';
            const backendUrlInput = el('input', 'prep-input');
            backendUrlInput.placeholder = 'Worker URL';
            const backendAddBtn = el('button', 'btn-small btn-primary', '新增后端');
            backendAddRow.append(backendNameInput, backendUrlInput, backendAddBtn);
            backendAddBtn.onclick = () => {
              AiduSyncService.backendAdd(backendNameInput.value.trim(), backendUrlInput.value.trim()).then((r) => {
                backendNameInput.value = ''; backendUrlInput.value = '';
                if (!r.ok) { syncStatus.textContent = '新增后端失败: ' + r.error; return; }
                renderBackends();
                syncStatus.textContent = '已新增后端。切过去后立即同步即可换库。';
              });
            };
            const renderBackends = () => {
              backendList.innerHTML = '';
              AiduSyncService.backendsList().then((res) => {
                if (!res.ok) { syncStatus.textContent = '读后端列表失败: ' + res.error; return; }
                const list = res.data || [];
                if (!list.length) {
                  backendList.appendChild(el('div', 'import-tip', '还没有后端。填名称 + Worker URL 新增第一个。'));
                  return;
                }
                list.forEach((b) => {
                  const row = el('div', 'sync-backend-row' + (b.active ? ' active' : ''));
                  const nameEl = el('span', 'sync-backend-name', b.name + (b.active ? ' (当前)' : ''));
                  const urlEl = el('code', 'j0-path', b.url);
                  const stateEl = el('span', 'book-badge ' + (b.connected ? 'badge-ok' : 'badge-idle'),
                    b.connected ? '已连接' : '未连接');
                  // M3 (2026-08-13): 「同步此后端」勾选 —— 当前主体 × 该后端一格; 显示所属主体
                  const subjEl = el('span', 'sync-backend-subject', '主体: ' + (b.subject || '我'));
                  const rowMeta = el('div', 'sync-backend-meta');
                  const enableLabel = el('label', 'sync-backend-enable');
                  const enableCb = el('input', '');
                  enableCb.type = 'checkbox';
                  enableCb.checked = !!b.enabled;
                  enableCb.disabled = !b.connected;
                  enableCb.title = b.connected ? '勾选后「立即同步」会同步到这个后端' : '该后端还没有 token (先切过去换 token), 无法启用同步';
                  enableCb.onchange = () => {
                    AiduSyncService.backendToggle(b.name, enableCb.checked).then((r) => {
                      if (!r.ok) { enableCb.checked = !enableCb.checked; syncStatus.textContent = '保存启用状态失败: ' + r.error; return; }
                      syncStatus.textContent = '已' + (enableCb.checked ? '启用' : '停用') + '「' + b.name + '」的同步。';
                    });
                  };
                  enableLabel.append(enableCb, document.createTextNode('同步此后端'));
                  rowMeta.append(enableLabel, subjEl);
                  const actions = el('div', 'settings-row');
                  if (!b.active) {
                    const swBtn = el('button', 'btn-small btn-primary', '切换');
                    swBtn.onclick = () => AiduSyncService.backendSwitch(b.name).then((r) => {
                      if (!r.ok) { syncStatus.textContent = '切换失败: ' + r.error; return; }
                      renderBackends();
                      syncStatus.textContent = '已切换到「' + b.name + '」。下次立即同步会按新后端的库全量对齐 (endpoint 变了)。';
                    });
                    actions.appendChild(swBtn);
                    const rmBtn = el('button', 'btn-small', '删除');
                    rmBtn.onclick = () => AiduSyncService.backendRemove(b.name).then((r) => {
                      if (!r.ok) { syncStatus.textContent = '删除失败: ' + r.error; return; }
                      renderBackends();
                    });
                    actions.appendChild(rmBtn);
                  }
                  row.append(nameEl, urlEl, stateEl, rowMeta, actions);
                  backendList.appendChild(row);
                });
              });
            };
            renderBackends();
            const urlInput = el('input', 'prep-input');
            urlInput.placeholder = 'CF Worker URL (自建 worker 链接)';
            const secretInput = el('input', 'prep-input');
            secretInput.type = 'password';
            secretInput.placeholder = 'ROOT_SECRET 或 6 位邀请码 (换 token, 不落明文)';
            const authBtn = el('button', 'btn-small', '换 token');
            authBtn.title = '首台用 ROOT_SECRET; 后续设备用 6 位邀请码 (add-device/invite-user)';
            const syncBtn = el('button', 'btn-primary', '立即同步');
            const pullBtn = el('button', 'btn-small', '拉取合并');
            // J8 (2026-08-11): 低频操作收进「更多」—— 主按钮是「立即同步」, 不是「换 token」。
            const moreBtn = el('button', 'btn-small', '更多');
            const moreBox = el('div', 'sync-more hidden');
            const codeBtn = el('button', 'btn-small', '生成邀请码');
            codeBtn.title = '给另一台设备: 绑到当前 user (add-device)';
            const inviteBtn = el('button', 'btn-small', '邀请新成员');
            inviteBtn.title = '给另一个人: 服务端新建成员, 对方填名字 (invite-user, 三项已定 ①)';
            // P0-C (2026-08-10): 手机扫码配对 —— 生成二维码, 手机打开即免登录
            const pairBtn = el('button', 'btn-small', '手机扫码连接');
            pairBtn.title = '生成二维码: 手机扫码打开即连, 收藏成书签免登录 (书签带 token = 拿到链接的人能读你的词库)';
            const disconnectBtn = el('button', 'btn-small btn-danger', '断开同步');
            disconnectBtn.title = '删除当前 user 的 token, 本机不再同步';
            disconnectBtn.disabled = true;
            // F4 (2026-08-11): 强制全量重推 —— 服务端数据被清/损坏后, endpoint 没变 A1 不会自动重推,
            // 用户需要手动兜底。清本 user 的 sync_state 后下次"立即同步"即全量重推。
            const forceFullBtn = el('button', 'btn-small', '强制全量重推');
            forceFullBtn.title = '服务端词库被清空/损坏后使用: 清掉本机同步进度, 下次立即同步会全量重推所有词';
            forceFullBtn.disabled = true;
            moreBtn.onclick = () => moreBox.classList.toggle('hidden');
            moreBox.append(codeBtn, inviteBtn, pairBtn, forceFullBtn, disconnectBtn);
            // L5 (2026-08-11): 同步动作按钮成组、组内间距固定 —— 不再被 space-between 撑开
            // (此前是 settings-row 里的散列按钮, 用户抱怨"间隔太远")。
            const syncRow = el('div', 'page-toolbar');
            syncRow.style.flexWrap = 'wrap';
            syncRow.append(syncBtn, pullBtn, moreBtn);
            syncSec.append(syncStatus, backendList, backendAddRow, urlInput, secretInput, authBtn, syncRow, moreBox);
             pane.appendChild(syncSec);
      
            // UX A2 (2026-08-11): 显示「本次推 N 条 / 拉 M 条」; 同步后 N=0 且服务端词库为空
            // → 警示, 不许显示"已同步" (杜绝"后台没做事, 用户以为成功")。afterSync 只对"刚
            // 同步完"的响应生效 —— 纯 status() 查询没有动作, last_wrote 默认 0, 不触发警示。
            const refreshStatus = (d, afterSync) => {
              let text;
              if (afterSync && d.last_wrote === 0 && d.deck_exists === false) {
                text = '警示: 本次推 0 条, 服务端词库为空 —— 本地可能没有待推词条或同步状态异常, 请勿当作已同步。';
              } else {
                text = '状态: ' + AiduSyncService.statusLabel(d);
              }
              text += (d.user_id ? ' · ' + d.user_id : '') +
                (d.worker_url ? ' · ' + d.worker_url : '') +
                (d.last_sync_at ? ' · 上次 ' + new Date(d.last_sync_at).toLocaleTimeString() : '');
              // J8 (2026-08-11): 「N 条待推」要解释为什么没推。
              // K6 (2026-08-14): 原文案称"自动推送只在启动时和任务完成后触发", 但成熟度审计
              // 独立复核两遍(Rust sync_now 调用点 + 前端 AiduSyncService.now() 调用点)确认
              // 全仓没有任何自动触发——唯一调用点是本文件下面手动点「立即同步」。改成如实描述,
              // 不写"会自动"这种不存在的行为(要做真的自动同步是另一件更大的事, 不在这里顺手加)。
              if (d.pending_count > 0) {
                text += '\n' + d.pending_count + ' 条待推 —— 不会自动推送, 点「立即同步」才会发。';
              }
              if (afterSync && (d.last_wrote !== 0 || d.last_pulled !== 0)) {
                text += '\n本次推 ' + d.last_wrote + ' 条 / 拉 ' + d.last_pulled + ' 条';
              }
              // S2 (2026-08-10): 失败必须可见 —— 配额拒绝/部分失败的人话原因直接展示
              if (d.last_error) {
                text += '\n' + d.last_error;
              }
              syncStatus.textContent = text;
              // J8 (2026-08-11): URL 回填当前值 (用户不输入也能看到已配置的 endpoint)
              if (d.worker_url && !urlInput.value) urlInput.value = d.worker_url;
              disconnectBtn.disabled = !d.configured;
              forceFullBtn.disabled = !d.configured;
            };
            AiduSyncService.status().then((res) => {
              if (res.ok && res.data) refreshStatus(res.data, false);
              else syncStatus.textContent = '未配置 (输入 Worker URL + ROOT_SECRET/邀请码 换 token)';
            });
            authBtn.onclick = () => {
              syncStatus.textContent = '换 token 中…';
              const rootSecret = secretInput.value.trim() || null;
              const code = /^\d{6}$/.test(secretInput.value.trim()) ? secretInput.value.trim() : null;
              AiduSyncService.authDevice(urlInput.value.trim(), null, rootSecret, code, '主电脑').then((r) => {
                secretInput.value = '';
                if (!r.ok) { syncStatus.textContent = '换 token 失败: ' + r.error; return; }
                syncStatus.textContent = '已换 token: user=' + (r.data.user_name || r.data.user_id) + ' · 设备=' + r.data.device_id;
                disconnectBtn.disabled = false;
              });
            };
            // M3 (2026-08-13): sync_now 返回数组 (每个已启用后端一个结果)。聚合展示。
            const summarizeSync = (arr) => {
              if (!Array.isArray(arr) || !arr.length) {
                return '本次没有同步任何后端 (没有勾选的后端或未配置 token)';
              }
              const okN = arr.filter((x) => x.ok).length;
              const failedN = arr.length - okN;
              const parts = arr.map((x) => {
                const w = x.ok ? `推 ${x.last_wrote} / 拉 ${x.last_pulled}` : '失败';
                return `${x.name || x.worker_url}: ${x.ok ? '✓ ' + w : '✗ ' + (x.last_error || x.error)}`;
              });
              return `已同步 ${okN} / ${arr.length} 个后端\n` + parts.join('\n') + (failedN ? `\n${failedN} 个后端同步失败` : '');
            };
            syncBtn.onclick = () => {
              syncStatus.textContent = '同步中…';
              AiduSyncService.now().then((r) => {
                if (!r.ok) { syncStatus.textContent = '同步失败: ' + (r.error || ''); return; }
                syncStatus.textContent = summarizeSync(r.data);
                renderBackends();
              });
            };
            pullBtn.onclick = () => {
              syncStatus.textContent = '拉取中…';
              AiduSyncService.pull().then((r) => {
                if (r.ok && r.data) refreshStatus(r.data, true);
                else syncStatus.textContent = '拉取失败: ' + (r.error || '');
              });
            };
            // F4: 强制全量重推 —— 清 sync_state 后引导用户立即同步 (清后点"立即同步"即全量重推)
            forceFullBtn.onclick = () => {
              AiduModal.confirm({
                title: '强制全量重推?',
                message: '将清空本机的同步进度记录, 下次"立即同步"会把所有词全量推到服务端。\n\n用于服务端词库被清空/损坏后恢复。不会删除本地任何词。',
                confirmText: '清空进度',
                danger: true,
                onConfirm: () => AiduSyncService.forceFull().then((r) => {
                  if (!r.ok) { throw new Error(r.error); }
                  syncStatus.textContent = '已清空同步进度。点「立即同步」执行全量重推。';
                  return;
                }),
              });
            };
            // V6: 生成 add-device 邀请码 (绑当前 user)
            codeBtn.onclick = () => {
              syncStatus.textContent = '生成邀请码中…';
              AiduSyncService.makeCode(null, 'add-device', null).then((r) => {
                if (!r.ok) { syncStatus.textContent = '生成失败: ' + r.error; return; }
                AiduToast.show('邀请码: ' + r.data.code + ' (10 分钟有效)', 'info');
                syncStatus.textContent = '邀请码已复制: ' + r.data.code;
              });
            };
            // 三项已定 ①: invite-user —— 服务端新建成员, 对方填名字 (两种码类型完整暴露)
            inviteBtn.onclick = () => {
              const name = (window.prompt('新成员名字 (如"孩子"):', '') || '').trim();
              if (!name) { AiduToast.show('已取消', 'info'); return; }
              syncStatus.textContent = '生成邀请码中…';
              AiduSyncService.makeCode(null, 'invite-user', name).then((r) => {
                if (!r.ok) { syncStatus.textContent = '生成失败: ' + r.error; return; }
                AiduToast.show('邀请码: ' + r.data.code + ' (10 分钟有效)', 'info');
                syncStatus.textContent = '邀请码: ' + r.data.code + ' · 新成员 "' + name + '"';
              });
            };
            disconnectBtn.onclick = () => {
              AiduModal.confirm({
                title: '断开当前 user 的同步?',
                message: '将删除当前 user 在本机保存的 token。此操作只影响本机, 云端已同步的生词不受影响。',
                confirmText: '断开',
                danger: true,
                onConfirm: () => AiduSyncService.disconnect().then((r) => {
                  if (!r.ok) { AiduToast.show('断开失败: ' + r.error, 'error'); return; }
                  AiduToast.show('已断开同步', 'info');
                  disconnectBtn.disabled = true;
                  syncStatus.textContent = '状态: 未配置';
                }),
              });
            };
            // P0-C (2026-08-10): 手机扫码连接 —— 复用 sync_pair_qr (auth/code + auth/device 换独立
            // device token, 不覆盖本机 token), 弹窗显示二维码 + 安全明示 + 踢设备。
            pairBtn.onclick = () => {
              syncStatus.textContent = '生成二维码中…';
              AiduSyncService.pairQr().then((r) => {
                if (!r.ok) { syncStatus.textContent = '生成配对码失败: ' + (r.error || ''); return; }
                syncStatus.textContent = '二维码已生成, 用手机扫一扫连接。';
                showPairModal(r.data);
              });
            };
            const showPairModal = (d) => {
              const ov = document.createElement('div');
              ov.className = 'modal-overlay';
              const box = document.createElement('div');
              box.className = 'modal-box';
              box.setAttribute('role', 'dialog');
              box.setAttribute('aria-modal', 'true');
              const title = el('h2', 'modal-title', '手机扫码连接');
              const body = el('div', 'book-settings-body');
              const qrWrap = el('div', 'pair-qr-wrap');
              qrWrap.innerHTML = d.qr_svg || '<span class="profile-meta">二维码生成失败 (内容过长), 请用下方链接或手动配对。</span>';
              const link = el('div', 'pair-link', d.qr_content || '');
              const warn = el('div', 'pair-warn', '书签里带 token = 拿到这个链接的人就能读你的词库 (老 AIDU 同款做法)。只在信任的手机上使用; 用完随时可踢掉这台设备。');
              const actions = el('div', 'modal-actions');
              const copyBtn = el('button', 'btn-small', '复制链接');
              copyBtn.onclick = () => {
                navigator.clipboard.writeText(d.qr_content || '').then(() => {
                  AiduToast.show('配对链接已复制', 'success');
                }).catch(() => AiduToast.show('复制失败, 请手动选中链接', 'error'));
              };
              const kickBtn = el('button', 'btn-small btn-danger', '踢掉这台设备');
              kickBtn.onclick = () => {
                kickBtn.disabled = true;
                kickBtn.textContent = '踢除中…';
                AiduSyncService.revokeToken(null, d.token).then((rr) => {
                  kickBtn.disabled = false;
                  if (rr.ok && rr.data && rr.data.revoked) {
                    kickBtn.textContent = '已踢掉, 手机将变未配置';
                    kickBtn.classList.add('kick-done');
                    AiduToast.show('已踢掉该设备 token', 'success');
                  } else {
                    kickBtn.textContent = '踢掉失败: ' + ((rr.data && rr.data.error) || rr.error || '未知');
                  }
                });
              };
              const close = el('button', 'btn-small', '关闭');
              close.onclick = () => ov.remove();
              actions.append(copyBtn, kickBtn, close);
              body.append(qrWrap, link, warn);
              box.append(title, body, actions);
              ov.appendChild(box);
              ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
              document.body.appendChild(ov);
            };
    }
  }

  global.SettingsSyncTab = SettingsSyncTab;
})(window);
