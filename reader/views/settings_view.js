/**
 * views/settings_view.js —— 设置: 字体/行距/宽度/主题/儿童模式 (P2 数据已就绪)
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsView {
    constructor(store) {
      this.store = store;
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'settings-view');
      wrap.appendChild(el('h1', null, '设置'));
      const tabbar = el('div', 'settings-tabs');
      const panes = el('div', 'settings-panes');
      const paneMap = {};
      const addTab = (id, label) => {
        const pane = el('div', 'settings-pane');
        pane.dataset.tab = id;
        paneMap[id] = pane;
        panes.appendChild(pane);
        const tab = el('button', 'settings-tab', label);
        tab.type = 'button';
        tab.dataset.tab = id;
        tab.onclick = () => {
          tabbar.querySelectorAll('.settings-tab').forEach((x) => x.classList.remove('active'));
          panes.querySelectorAll('.settings-pane').forEach((x) => x.classList.remove('active'));
          tab.classList.add('active');
          pane.classList.add('active');
        };
        tabbar.appendChild(tab);
        return pane;
      };
      const systemPane = addTab('system', '系统与书库');
      const readingPane = addTab('reading', '阅读显示');
      const learningPane = addTab('learning', '学习档案');
      const syncPane = addTab('sync', '同步与数据');
      // 阶段6 设计交付 §10 item 8: 模型中心并入设置为一个分区 (模块本身不改, 只换挂载点)
      const modelsPane = addTab('models', '模型中心');
      if (global.ModelsView) {
        new global.ModelsView(this.store).render(modelsPane);
      }
      tabbar.querySelector('.settings-tab').classList.add('active');
      paneMap.system.classList.add('active');
      // UX 审计 (2026-08-09): 支持外部直达指定 tab (如"去模型中心"按钮) —— 一次性意图,
      // 用掉后清除, 下次进设置回到默认 tab。
      const wantedTab = this.store.state.settingsTab;
      if (wantedTab && paneMap[wantedTab]) {
        this.store.set({ settingsTab: null });
        tabbar.querySelectorAll('.settings-tab').forEach((x) => x.classList.remove('active'));
        panes.querySelectorAll('.settings-pane').forEach((x) => x.classList.remove('active'));
        const wantedTabBtn = tabbar.querySelector(`.settings-tab[data-tab="${wantedTab}"]`);
        if (wantedTabBtn) wantedTabBtn.classList.add('active');
        paneMap[wantedTab].classList.add('active');
      }
      const settingsLayout = el('div', 'settings-layout');
      settingsLayout.append(tabbar, panes);
      wrap.appendChild(settingsLayout);

      // 日志区: 反馈排查入口
      const logSec = el('div', 'settings-section');
      logSec.appendChild(el('h2', null, '日志'));
      const logRow = el('div', 'log-row');
      const logInfo = el('span', 'log-info', '前端 JS 错误与处理队列事件全部写入日志文件。');
      const openLogBtn = el('button', 'btn-small', '打开日志文件');
      openLogBtn.onclick = () => {
        AiduMiscService.logPath().then((r) => {
          if (r.ok && r.data && r.data.path) {
            AiduMiscService.openPath(r.data.path).then((openRes) => {
              if (!openRes.ok) {
                logInfo.textContent = '日志路径: ' + r.data.path + ' (已复制到剪贴板)';
                navigator.clipboard.writeText(r.data.path);
              }
            });
          }
        });
      };
      logRow.append(logInfo, openLogBtn);
      logSec.appendChild(logRow);
       systemPane.appendChild(logSec);

      // P1.2: 书库位置(用户明确要求的产品能力, 见 docs/ROADMAP.md P1)
      const libSec = el('div', 'settings-section');
      libSec.appendChild(el('h2', null, '书库位置'));
      const libRow = el('div', 'log-row');
      const libPath = el('span', 'log-info', '读取中…');
      const libChangeBtn = el('button', 'btn-small', '更改…');
      libRow.append(libPath, libChangeBtn);
      libSec.appendChild(libRow);
      const libMsg = el('div', 'import-tip');
      libSec.appendChild(libMsg);
       systemPane.appendChild(libSec);

      const refreshLibPath = () => {
        AiduMiscService.libraryDirGet().then((r) => {
          libPath.textContent = r.ok ? ('当前: ' + r.data) : ('读取失败: ' + r.error);
        });
      };
      refreshLibPath();

      libChangeBtn.onclick = () => {
        libChangeBtn.disabled = true;
        libMsg.textContent = '迁移中, 请稍候…(数据量大时可能需要几分钟)';
        AiduMiscService.libraryDirPickAndSet().then((r) => {
          libChangeBtn.disabled = false;
          if (!r.ok) {
            // 后端明确拒绝的场景(如任务处理中), 错误信息本身就是人话
            libMsg.textContent = r.error;
            return;
          }
          const d = r.data || {};
          if (d.cancelled) {
            libMsg.textContent = d.same ? '选择的位置和当前一致, 未做改动。' : '';
            return;
          }
          const movedN = (d.moved || []).length;
          const failedN = (d.failed || []).length;
          let msg = `已迁移 ${movedN} 项`;
          if (failedN > 0) {
            const reasons = d.failed.map((f) => `${f.name}(${f.reason})`).join('; ');
            msg += `, ${failedN} 项失败: ${reasons}`;
          }
          msg += '。新位置: ' + d.new_dir + '。需要重启应用才能生效。';
          libMsg.textContent = msg;
          refreshLibPath();
        });
      };

      // G5: 组件健康检查 (模型已独立成"模型中心"tab, 这里只留组件体检,
      // 不再重复渲染整套 ModelsView —— UX 审计 2026-08-09: 原来两处各渲染一次,
      // 系统与书库 tab 下会出现第二套完整重复的模型中心)
      const compSec = el('div', 'settings-section');
      compSec.appendChild(el('h2', null, '组件健康检查'));
      const compList = el('div', 'component-list');
      compSec.appendChild(compList);
      systemPane.appendChild(compSec);
      AiduMiscService.componentsHealth().then((res) => {
        compList.innerHTML = '';
        if (!res.ok) { compList.appendChild(el('div', 'global-error', '检查失败: ' + res.error)); return; }
        (res.data || []).forEach(c => {
          const row = el('div', 'component-row',
            `${c.name}: ${c.healthy ? '✓ ' + c.detail : '✗ ' + c.detail}`);
          row.className += c.healthy ? ' component-ok' : ' component-bad';
          // R3.4: 文档解析器缺失 → 一键安装按钮
          if (c.id === 'pymupdf' && !c.healthy) {
            const btn = el('button', 'btn-small', '一键安装');
            btn.style.marginLeft = '8px';
            btn.onclick = () => {
              btn.disabled = true;
              btn.textContent = '安装中…';
              AiduMiscService.docParserInstall().then((r) => {
                const installed = r.ok && r.data && r.data.ok;
                btn.textContent = installed ? '✓ 已安装' : '安装失败';
                if (!installed) row.title = (r.data && r.data.detail) || r.error || '';
              });
            };
            row.appendChild(btn);
          }
          compList.appendChild(row);
        });
      });

      // M6: 学习档案 (每个人不同的英文库: 讲解深度/音色/语速/高亮粒度)
      const profSec = el('div', 'settings-section');
      profSec.appendChild(el('h2', null, '学习档案'));
      profSec.appendChild(el('div', 'import-tip',
        '每个档案定义一套处理参数 (讲解深度/音色/语速/高亮粒度)。导入书籍时选一个档案, 同一本书换档案重跑就是另一套读法。'));
      const profList = el('div', 'profile-list');
      profSec.appendChild(profList);
      const addBtn = el('button', 'btn-small', '+ 新建档案');
      addBtn.onclick = () => this._editProfileModal(null, () => this._renderProfiles(profList));
      profSec.appendChild(addBtn);
       learningPane.appendChild(profSec);
      this._renderProfiles(profList);

      // I-C: 同步配置与状态 (V6 按当前 user 分账, 协议 v1)
      const syncSec = el('div', 'settings-section');
      syncSec.appendChild(el('h2', null, '同步 (背单词状态跨设备)'));
      const syncStatus = el('div', 'sync-status', '读取中…');
      const urlInput = el('input', 'prep-input');
      urlInput.placeholder = 'CF Worker URL (自建 worker 链接)';
      const secretInput = el('input', 'prep-input');
      secretInput.type = 'password';
      secretInput.placeholder = 'ROOT_SECRET 或 6 位邀请码 (换 token, 不落明文)';
      const authBtn = el('button', 'btn-primary', '换 token');
      authBtn.title = '首台用 ROOT_SECRET; 后续设备用 6 位邀请码 (add-device/invite-user)';
      const syncBtn = el('button', 'btn-small', '立即同步');
      const pullBtn = el('button', 'btn-small', '拉取合并');
      const codeBtn = el('button', 'btn-small', '生成邀请码');
      codeBtn.title = '给另一台设备: 绑到当前 user (add-device)';
      const inviteBtn = el('button', 'btn-small', '邀请新成员');
      inviteBtn.title = '给另一个人: 服务端新建成员, 对方填名字 (invite-user, 三项已定 ①)';
      // P0-C (2026-08-10): 手机扫码配对 —— 生成二维码, 手机打开即免登录
      const pairBtn = el('button', 'btn-small btn-primary', '手机扫码连接');
      pairBtn.title = '生成二维码: 手机扫码打开即连, 收藏成书签免登录 (书签带 token = 拿到链接的人能读你的词库)';
      const disconnectBtn = el('button', 'btn-small btn-danger', '断开同步');
      disconnectBtn.title = '删除当前 user 的 token, 本机不再同步';
      disconnectBtn.disabled = true;
      syncSec.append(syncStatus, urlInput, secretInput, authBtn, syncBtn, pullBtn, codeBtn, inviteBtn, pairBtn, disconnectBtn);
       syncPane.appendChild(syncSec);

      const refreshStatus = (d) => {
        syncStatus.textContent = '状态: ' + AiduSyncService.statusLabel(d) +
          (d.user_id ? ' · ' + d.user_id : '') +
          (d.pending_count > 0 ? ' · ' + d.pending_count + ' 条待推' : '') +
          (d.worker_url ? ' · ' + d.worker_url : '') +
          (d.last_sync_at ? ' · 上次 ' + new Date(d.last_sync_at).toLocaleTimeString() : '');
        disconnectBtn.disabled = !d.configured;
      };
      AiduSyncService.status().then((res) => {
        if (res.ok && res.data) refreshStatus(res.data);
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
      syncBtn.onclick = () => {
        syncStatus.textContent = '同步中…';
        AiduSyncService.now().then((r) => {
          if (r.ok && r.data) refreshStatus(r.data);
          else syncStatus.textContent = '同步失败: ' + (r.error || '');
        });
      };
      pullBtn.onclick = () => {
        syncStatus.textContent = '拉取中…';
        AiduSyncService.pull().then((r) => {
          if (r.ok && r.data) refreshStatus(r.data);
          else syncStatus.textContent = '拉取失败: ' + (r.error || '');
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

      AiduSettingsService.get('default').then((res) => {
        if (!res.ok) { wrap.appendChild(el('div', 'global-error', '读设置失败: ' + res.error)); return; }
        const s = res.data || {};
        const form = el('div', 'settings-form');

        // M7 Round 3: 字号/行距/栏宽改图形化档位 (与阅读器浮层一致, 消灭裸数字输入框)
        const applyPatch = (patch) => {
          AiduSettingsService.upsert({ ...s, ...patch, updated_at: Date.now() })
            .catch(() => AiduToast.show('保存失败, 请重试', 'error'));
          this._applyCss({ ...s, ...patch });
        };
        form.appendChild(this._stepRow('字号', [16, 19, 22, 27], s.font_size ?? 19,
          (v) => applyPatch({ font_size: v }), 'Aa'));
        form.appendChild(this._stepRow('行距', [1.6, 1.85, 2.1], s.line_height ?? 1.85,
          (v) => applyPatch({ line_height: v })));
        form.appendChild(this._stepRow('栏宽', [560, 660, 760], s.content_width ?? 660,
          (v) => applyPatch({ content_width: v })));

        // 主题
        const themeRow = el('label', 'settings-row', '主题');
        const themeSel = el('select', null);
        ['light', 'dark'].forEach(t => {
          const opt = el('option', null, t === 'light' ? '浅色' : '深色');
          opt.value = t;
          if (s.theme === t) opt.selected = true;
          themeSel.appendChild(opt);
        });
        themeSel.onchange = () => {
          const patch = { ...s, theme: themeSel.value, updated_at: Date.now() };
          AiduBridge.settings.upsert(patch).catch(() => AiduToast.show('保存失败, 请重试', 'error'));
          this._applyCss(patch);
        };
        themeRow.appendChild(themeSel);
        form.appendChild(themeRow);

        // M7 R23: 主题色系 —— 色块 chips + 自定义色
        const paletteWrap = this._buildPalettePicker(s, (patch) => applyPatch(patch));
        form.appendChild(paletteWrap);

        // 儿童模式
        const childRow = el('label', 'settings-row');
        const childBox = el('input', null);
        childBox.type = 'checkbox';
        childBox.checked = !!s.child_mode;
        childBox.onchange = () => {
          const patch = {
            ...s,
            child_mode: childBox.checked,
            font_size: childBox.checked ? 24 : 18,
            line_height: childBox.checked ? 2.0 : 1.7,
            highlight_granularity: childBox.checked ? 'word' : 'sentence',
            updated_at: Date.now(),
          };
          AiduBridge.settings.upsert(patch).catch(() => AiduToast.show('保存失败, 请重试', 'error'));
          this._applyCss(patch);
        };
        childRow.append(el('span', null, '儿童模式 (更大字号/更高对比度/默认词级高亮)'), childBox);
        form.appendChild(childRow);

         readingPane.appendChild(form);
        this._applyCss(s);
      });
      container.appendChild(wrap);
    }

    _applyCss(s) {
      const root = document.documentElement;
      root.style.setProperty('--rd-text', (s.font_size || 19) + 'px');
      root.style.setProperty('--rd-lh', s.line_height || 1.85);
      root.style.setProperty('--rd-measure', (s.content_width || 660) + 'px');
      root.dataset.kid = s.child_mode ? '1' : '0';
      document.body.dataset.theme = s.theme || 'light';
      document.body.dataset.palette = s.palette || 'clay';
    }

    // ---------------- 学习档案 (M6) ----------------

    /** 主题色系表 (key, 中文标签, 色块 var) —— M7 色块选择器共用 */
    static get PALETTES() {
      return [
        ['clay', '陶土 · 暖', 'var(--swatch-clay)'],
        ['sage', '青苔 · 自然', 'var(--swatch-sage)'],
        ['ocean', '海蓝 · 专注', 'var(--swatch-ocean)'],
        ['rose', '蔷薇 · 温柔', 'var(--swatch-rose)'],
        ['slate', '灰蓝 · 克制', 'var(--swatch-slate)'],
      ];
    }

    /** M7 R3: 图形化档位行 (Aa 四档 / 线条与柱形), 与阅读器浮层同一套视觉 */
    _stepRow(label, values, current, onPick, symbol) {
      const row = el('label', 'settings-row', label);
      const seg = el('div', 'rd-settings-seg');
      values.forEach((v, i) => {
        const btn = el('button', 'rd-settings-opt');
        if (v === current) btn.classList.add('active');
        if (symbol) {
          btn.textContent = symbol;
          btn.classList.add('rd-settings-a' + (i + 1));
        } else {
          btn.classList.add('rd-settings-dot-' + values.length);
        }
        btn.title = String(v);
        btn.onclick = () => {
          seg.querySelectorAll('.rd-settings-opt').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          onPick(v);
        };
        seg.appendChild(btn);
      });
      row.appendChild(seg);
      return row;
    }

    /** M7 R23: 主题色选择器 (5 预设 chips + 自定义色输入, 选自定义才显示) */
    _buildPalettePicker(s, onPatch) {
      const wrap = el('div', 'settings-row');
      wrap.appendChild(el('span', 'rd-settings-label', '主题色'));
      const chips = this._buildThemeChips(s.palette || 'clay', (v) => onPatch({ palette: v }));
      wrap.appendChild(chips);
      // 自定义色输入 (仅 palette=custom 显示)
      const colorRow = el('div', 'settings-row');
      colorRow.appendChild(el('span', 'rd-settings-label', '自定义色'));
      const colorInput = el('input', null);
      colorInput.type = 'color';
      colorInput.value = /^#[0-9a-fA-F]{6}$/.test(s.custom_color || '') ? s.custom_color : '#3b6b8a';
      colorRow.appendChild(colorInput);
      colorRow.style.display = (s.palette === 'custom') ? '' : 'none';
      colorInput.onchange = () => onPatch({ palette: 'custom', custom_color: colorInput.value });
      wrap.appendChild(colorRow);
      return wrap;
    }

    /** M7: 主题色块 chips (5 预设 + 自定义, 色块 + title, 选中高亮) */
    _buildThemeChips(active, onPick) {
      const wrap = el('div', 'rd-theme-chips');
      SettingsView.PALETTES.forEach(([key, label, color]) => {
        const c = el('button', 'rd-theme-chip' + (key === active ? ' active' : ''));
        c.title = label;
        c.dataset.palette = key;
        c.style.setProperty('--chip', color);
        c.onclick = () => {
          wrap.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
          c.classList.add('active');
          onPick(key);
        };
        wrap.appendChild(c);
      });
      // 自定义 chip (彩虹渐变示意)
      const custom = el('button', 'rd-theme-chip' + (active === 'custom' ? ' active' : ''));
      custom.title = '自定义颜色';
      custom.dataset.palette = 'custom';
      custom.style.setProperty('--chip', 'conic-gradient(#b06a4b, #4a6a80, #5d7a58, #96626d, #b06a4b)');
      custom.onclick = () => {
        wrap.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
        custom.classList.add('active');
        onPick('custom');
      };
      wrap.appendChild(custom);
      return wrap;
    }

    /** 音色候选 (可用性取决于已装模型, 保留提示; 单一真相源 core/builtin_profiles) */
    static get VOICES() {
      return AiduBuiltinProfiles.VOICES;
    }

    _renderProfiles(listEl) {
      AiduBridge.profiles.list().then((res) => {
        listEl.innerHTML = '';
        if (!res.ok) { listEl.appendChild(el('div', 'global-error', '读档案失败: ' + res.error)); return; }
        const profiles = AiduBuiltinProfiles.ensureBuiltins(res.data);
        if (!profiles.length) { listEl.appendChild(el('div', 'import-tip', '还没有档案。')); return; }
        profiles.forEach((p) => {
          const row = el('div', 'profile-row');
          const head = el('div', 'profile-head');
          const name = el('span', 'profile-name', p.name);
          const builtin = el('span', 'profile-badge', p.id === 'default' || p.id === 'kid' ? '内建' : '自建');
          head.append(name, builtin);
          const strategy = { none: '不讲', brief: '简要讲解', deep: '深入讲解' }[p.explain_strategy] || p.explain_strategy;
          const gran = p.highlight_granularity === 'word' ? '词级' : '句级';
          const meta = el('div', 'profile-meta', `${strategy} · ${p.voice} · ${p.speed}x · ${gran}`);
          const actions = el('div', 'profile-actions');
          const edit = el('button', 'btn-small', '编辑');
          edit.onclick = () => this._editProfileModal(p, () => this._renderProfiles(listEl));
          actions.appendChild(edit);
          if (p.id !== 'default') {
            const del = el('button', 'btn-small btn-danger', '删除');
            del.onclick = () => {
              AiduModal.confirm({
                title: `删除档案「${p.name}」?`,
                message: '删除后, 用这个档案处理过的书在书卡上会显示"未知档案" (不影响已生成的书)。',
                confirmText: '删除',
                danger: true,
                onConfirm: () => AiduBridge.profiles.remove(p.id).then((r) => {
                  if (!r.ok) { AiduToast.show('删除失败: ' + r.error, 'error'); return; }
                  AiduToast.show('已删除档案', 'info');
                  this._renderProfiles(listEl);
                }),
              });
            };
            actions.appendChild(del);
          }
          row.append(head, meta, actions);
          listEl.appendChild(row);
        });
      });
    }

    /** 新建/编辑档案模态 (M6): 名称 + 讲解策略 + 音色 + 语速 + 高亮粒度 */
    _editProfileModal(profile, onDone) {
      const p = profile || {};
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', profile ? '编辑档案' : '新建档案');
      const body = el('div', 'book-settings-body');
      const form = el('div', 'settings-form');

      const nameRow = el('label', 'settings-row', '名称');
      const nameInput = el('input', null);
      nameInput.type = 'text';
      nameInput.value = p.name || '';
      nameInput.placeholder = '如: 我的慢速精读 / 雅思准备';
      nameRow.appendChild(nameInput);

      const strategyRow = el('label', 'settings-row', '讲解深度');
      const strategySel = el('select', null);
      [['brief', '简要讲解'], ['deep', '深入讲解'], ['none', '不讲解']].forEach(([v, l]) => {
        const opt = el('option', null, l);
        opt.value = v;
        if ((p.explain_strategy || 'brief') === v) opt.selected = true;
        strategySel.appendChild(opt);
      });
      strategyRow.appendChild(strategySel);

      const voiceRow = el('label', 'settings-row', '音色');
      const voiceSel = el('select', null);
      SettingsView.VOICES.forEach(([v, l]) => {
        const opt = el('option', null, l);
        opt.value = v;
        if ((p.voice || 'af_heart') === v) opt.selected = true;
        voiceSel.appendChild(opt);
      });
      voiceRow.appendChild(voiceSel);

      const speedRow = el('label', 'settings-row', '语速');
      const speedInput = el('input', null);
      speedInput.type = 'number';
      speedInput.step = '0.1';
      speedInput.min = '0.5';
      speedInput.max = '1.5';
      speedInput.value = p.speed != null ? p.speed : 1.0;
      speedRow.append(speedInput, document.createTextNode('×'));

      const granRow = el('label', 'settings-row', '高亮粒度');
      const granSel = el('select', null);
      [['sentence', '句级 (跟读导向)'], ['word', '词级 (逐词卡拉OK)']].forEach(([v, l]) => {
        const opt = el('option', null, l);
        opt.value = v;
        if ((p.highlight_granularity || 'sentence') === v) opt.selected = true;
        granSel.appendChild(opt);
      });
      granRow.appendChild(granSel);

      const voiceHint = el('div', 'import-tip', '音色可选列表取决于已装语音模型; 处理时若报错会提示具体原因。');
      form.append(nameRow, strategyRow, voiceRow, speedRow, granRow, voiceHint);

      const actions = el('div', 'modal-actions');
      const cancelBtn = el('button', 'btn-small', '取消');
      const saveBtn = el('button', 'btn-primary', '保存');
      actions.append(cancelBtn, saveBtn);

      body.appendChild(form);
      box.append(title, body, actions);
      ov.appendChild(box);
      document.body.appendChild(ov);
      const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      cancelBtn.onclick = close;
      ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
      document.addEventListener('keydown', onKey);

      saveBtn.onclick = () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const id = profile ? profile.id : ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        const speed = parseFloat(speedInput.value);
        AiduBridge.profiles.upsert({
          id,
          name,
          explain_strategy: strategySel.value,
          voice: voiceSel.value,
          speed: Number.isFinite(speed) ? Math.min(1.5, Math.max(0.5, speed)) : 1.0,
          highlight_granularity: granSel.value,
        }).then((r) => {
          if (!r.ok) { AiduToast.show('保存失败: ' + r.error, 'error'); return; }
          close();
          AiduToast.show('已保存档案「' + name + '」', 'success');
          onDone && onDone();
        });
      };
      nameInput.focus();
    }
  }

  global.SettingsView = SettingsView;
})(window);
