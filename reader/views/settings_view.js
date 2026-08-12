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
      // J9 (2026-08-11): 五个 tab 定名 —— 模型中心并入依赖成为「模型与依赖」
      const modelsPane = addTab('models', '模型与依赖');
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

      // N1 (2026-08-12): 向导可重入 —— 走完的向导换机器/换数据目录时能再进一次
      const wizardSec = el('div', 'settings-section');
      wizardSec.appendChild(el('h2', null, '首次设置向导'));
      const wizardRow = el('div', 'settings-row');
      wizardRow.appendChild(el('span', 'log-info', '重新走一遍设置向导 (语言/数据目录/硬件/模型/依赖), 换机器或换数据目录后有用。'));
      const rerunWizard = el('button', 'btn-small', '重新运行首次向导');
      rerunWizard.onclick = () => {
        AiduModelService.wizardReset().then((r) => {
          if (!r.ok) { AiduToast.show('重置向导失败: ' + r.error, 'error'); return; }
          window.location.hash = '#/wizard';
        });
      };
      wizardRow.appendChild(rerunWizard);
      wizardSec.appendChild(wizardRow);
      systemPane.appendChild(wizardSec);

      // P1.2: 书库位置(用户明确要求的产品能力, 见 docs/ROADMAP.md P1)
      // J0 (2026-08-11): 显示完整路径 (不被按钮截断) + 「在资源管理器中打开」;
      // 同时展示数据根目录与数据库路径, 并提示待迁移 (旧位置有数据时)。
      const libSec = el('div', 'settings-section');
      libSec.appendChild(el('h2', null, '书库位置'));
      // M5 (2026-08-12): 三个按钮收进一组 (.page-toolbar 间距), 不再散落
      const libPath = el('code', 'j0-path', '读取中…');
      const libBtns = el('div', 'page-toolbar');
      libBtns.style.flexWrap = 'wrap';
      const libOpenBtn = el('button', 'btn-small', '在资源管理器中打开');
      libOpenBtn.title = '打开当前书库目录所在位置 (不改动任何东西)';
      const libChangeBtn = el('button', 'btn-small', '更改…');
      // M5 (2026-08-12): 语义说清 —— 更改 = 换一个空目录做新书库, 只改配置不搬文件
      libChangeBtn.title = '换一个空目录做新书库。只改配置, 不移动任何书文件。';
      // L7 (2026-08-11): 加载已有书库目录 —— 选一个大文件夹, 里面的成品书包可登记
      const libLoadBtn = el('button', 'btn-small', '加载已有书库…');
      libLoadBtn.title = '选一个装有成品书包的目录 (比如从另一台电脑整个拷过来的库), 扫描 → 确认后登记, 不复制不移动文件。';
      libBtns.append(libOpenBtn, libChangeBtn, libLoadBtn);
      const libRow = el('div', 'settings-row');
      libRow.append(libPath, libBtns);
      libSec.appendChild(libRow);
      const libMeta = el('div', 'settings-meta');
      libSec.appendChild(libMeta);
      const libMsg = el('div', 'import-tip');
      libSec.appendChild(libMsg);
       systemPane.appendChild(libSec);

      const refreshLibPath = () => {
        AiduMiscService.libraryDirGet().then((r) => {
          libPath.textContent = r.ok ? r.data : ('读取失败: ' + r.error);
          libPath.title = r.ok ? r.data : '';
        });
        AiduMiscService.dataMigrationStatus().then((r) => {
          if (!r.ok || !r.data) return;
          const d = r.data;
          const rows = [];
          rows.push('数据目录: ' + d.data_dir);
          rows.push('数据库: ' + d.db_path);
          rows.push('书库: ' + d.out_dir);
          if (d.pending) {
            rows.push('⚠ 旧位置仍有数据, 未迁移 (见下方说明)。');
          }
          libMeta.textContent = rows.join('\n');
          if (d.pending) {
            libMsg.textContent = '检测到旧位置 (程序目录) 下有书库与词库数据。为避免 cargo clean 等操作误删, 建议迁移到数据目录。';
            const migrateBtn = el('button', 'btn-small btn-primary', '迁移到数据目录');
            migrateBtn.style.marginLeft = '8px';
            migrateBtn.onclick = () => {
              migrateBtn.disabled = true;
              migrateBtn.textContent = '准备中…';
              AiduMiscService.dataMigrationDryRun().then((dry) => {
                if (!dry.ok || !dry.data || !dry.data.pending) {
                  migrateBtn.disabled = false;
                  migrateBtn.textContent = '迁移到数据目录';
                  libMsg.textContent = dry.data && dry.data.pending === false ? '已无待迁移数据。' : (dry.error || '读取失败');
                  return;
                }
                const dd = dry.data.dry;
                const items = dd.out_items + (dd.db_exists ? 1 : 0);
                const msg = '将迁移 ' + items + ' 项 (书库 ' + (dd.out_bytes / 1048576).toFixed(1) +
                  ' MB' + (dd.db_exists ? ' + 数据库 ' + (dd.db_bytes / 1048576).toFixed(1) + ' MB' : '') +
                  ') 到:\n' + dd.target_out + '\n\n先自动备份到: backups/ 目录 (路径会显示), 复制并校验通过后才删除旧文件。完成后需要重启应用。';
                AiduModal.confirm({
                  title: '迁移书库与词库到数据目录?',
                  message: msg,
                  confirmText: '开始迁移',
                  danger: true,
                  onConfirm: () => AiduMiscService.dataMigrationRun().then((r) => {
                    if (!r.ok) { throw new Error(r.error); }
                    libMsg.textContent = '迁移完成。备份: ' + r.data.backup_path + '。请重启应用。';
                    libMsg.title = r.data.backup_path;
                    return;
                  }),
                });
              });
            };
            libMsg.appendChild(migrateBtn);
          } else if (libMsg.textContent.startsWith('检测到旧位置')) {
            // M5 (2026-08-12) 真凶: 这里无条件清空 libMsg —— refreshLibPath 在每次 render
            // 和「更改…」成功后都会跑, pending=false 就把刚写的"书库位置已改为 X"结果当场
            // 抹掉, 用户看到的就是"选了目录没有任何结果"。只清自己写的迁移提示, 不动别的消息。
            libMsg.textContent = '';
          }
        });
      };
      refreshLibPath();

      libOpenBtn.onclick = () => {
        const p = libPath.textContent;
        if (!p || p.startsWith('读取')) return;
        AiduMiscService.openPath(p).then((r) => {
          if (!r.ok) {
            libMsg.textContent = '无法打开, 请手动复制路径: ' + p;
            navigator.clipboard.writeText(p).catch(() => {});
          }
        });
      };

      libChangeBtn.onclick = () => {
        libChangeBtn.disabled = true;
        libMsg.textContent = '选择新位置…';
        AiduMiscService.libraryDirPickAndSet().then((r) => {
          libChangeBtn.disabled = false;
          if (!r.ok) {
            // 后端明确拒绝的场景(如任务处理中), 错误信息本身就是人话
            libMsg.textContent = r.error;
            return;
          }
          const d = r.data || {};
          if (d.cancelled) {
            // M5: 取消也要有明确结果, 不静默清空
            libMsg.textContent = d.same ? '选择的位置和当前一致, 书库位置未更改。' : '已取消, 书库位置未更改。';
            return;
          }
          // L7 (2026-08-11): 只改配置不搬文件 —— 不移动任何书, 重启后从新位置读。
          // M5 (2026-08-12): 结果说清"原目录 N 本书未移动"。
          libMsg.textContent = '书库位置已改为 ' + d.new_dir + ', 原目录 ' + (d.book_count ?? 0) +
            ' 本书未移动 (切换只改配置, 不搬文件)。重启应用后生效。';
          refreshLibPath();
        });
      };

      // L7 (2026-08-11): 加载已有书库目录 —— 扫描 → 确认 → 登记 (只登记路径, 不复制)。
      libLoadBtn.onclick = () => {
        libLoadBtn.disabled = true;
        libMsg.textContent = '选择要加载的目录…';
        AiduMiscService.libraryDirPick().then((pick) => {
          if (!pick.ok || !pick.data || pick.data.cancelled) {
            libLoadBtn.disabled = false;
            // M5: 取消也明确说
            if (pick && pick.ok && pick.data && pick.data.cancelled) {
              libMsg.textContent = '已取消, 没有加载任何目录。';
            }
            return;
          }
          const dir = pick.data.path;
          libMsg.textContent = '正在扫描 ' + dir + ' …';
          AiduMiscService.libraryDirScan(dir).then((scan) => {
            libLoadBtn.disabled = false;
            if (!scan.ok) { libMsg.textContent = '扫描失败: ' + scan.error; return; }
            const d = scan.data || {};
            const imp = d.importable || [];
            const ex = d.existing || [];
            if (imp.length === 0) {
              // M5: 0 结果说明扫描范围 + 已有 M 本
              libMsg.textContent = '在「' + dir + '」下没有找到可登记的成品书包' +
                (ex.length ? ' (已有 ' + ex.length + ' 本在书库里)。' : '。');
              return;
            }
            const msg = '在「' + dir + '」下找到 ' + imp.length + ' 本成品 (另有 ' + ex.length +
              ' 本已在书库中)。登记 = 只把路径写进书库, 不复制不移动任何文件。\n\n' +
              imp.slice(0, 8).map((x) => '· ' + (x.title || x.id)).join('\n') +
              (imp.length > 8 ? '\n…' : '') + '\n\n确认登记这 ' + imp.length + ' 本?';
            AiduModal.confirm({
              title: '登记外部书库?',
              message: msg,
              confirmText: '登记',
              onConfirm: () => AiduMiscService.libraryDirImport(imp).then((r) => {
                if (!r.ok) { libMsg.textContent = '登记失败: ' + r.error; return; }
                // M5: 结果说清"扫描到 N 本, 已登记 M 本"
                libMsg.textContent = '扫描到 ' + imp.length + ' 本, 已登记 ' +
                  ((r.data && r.data.imported) ?? 0) + ' 本。' +
                  ((r.data && r.data.failed && r.data.failed.length) ? '失败 ' + r.data.failed.length + ' 本。' : '');
                this.store.emit('change', this.store.state);
              }),
            });
          });
        });
      };

      // J3 (2026-08-11): 依赖并入「模型与依赖」tab —— 组件健康检查 (prep/ffmpeg/PyMuPDF/
      // CUDA) 与模型同页呈现, 不再藏在"系统与书库"里。
      const compSec = el('div', 'settings-section');
      compSec.appendChild(el('h2', null, '依赖组件'));
      const compList = el('div', 'component-list');
      compSec.appendChild(compList);
      modelsPane.appendChild(compSec);
      // S0 (2026-08-10): 探测侧车可能耗时 (异步命令 + 5 秒超时), 先出"检测中…",
      // 结果到了再填充 —— 不阻塞设置页渲染; 失败也显示原因 (后台失败必须可见)。
      compList.appendChild(el('div', 'component-row', '检测中…'));
      AiduMiscService.componentsHealth().then((res) => {
        compList.innerHTML = '';
        if (!res.ok) { compList.appendChild(el('div', 'global-error', '检查失败: ' + res.error)); return; }
        (res.data || []).forEach(c => {
          // J3 (2026-08-11): 当前版本 · 状态 · 操作 (有版本显示, 无则省略)
          const ver = c.version ? ' · 当前 ' + c.version : '';
          const row = el('div', 'component-row',
            `${c.name}: ${c.healthy ? '✓ ' : '✗ '}${c.detail}${ver}`);
          row.className += c.healthy ? ' component-ok' : ' component-bad';
          // J3: 更新渠道 —— 有渠道的给"检查更新/安装"入口, 无渠道的老实显示文字 (不放假按钮)
          if (c.healthy) {
            const ch = el('span', 'component-channel', '[' + (c.update_channel || '无更新渠道') + ']');
            ch.style.marginLeft = '8px';
            ch.style.opacity = '.7';
            ch.style.fontSize = '0.78rem';
            row.appendChild(ch);
            // M4-2 (2026-08-12): 本地文件类模型标"无更新渠道"时, 补一句可操作的下一步 ——
            // 光知道"没渠道"用户不知道下一步干什么。
            if ((c.update_channel || '无更新渠道') === '无更新渠道' && ['llm', 'tts', 'spacy'].includes(c.id)) {
              const how = el('span', 'component-how', '要换新版: 下载后用「添加自定义模型」指向新文件, 再设为推荐。');
              how.style.marginLeft = '8px';
              how.style.opacity = '.7';
              how.style.fontSize = '0.78rem';
              row.appendChild(how);
            }
          }
          // R3.4/J3: 文档解析器缺失 → 一键安装按钮 (这是真实渠道)
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

      // K3 (2026-08-11): 在线 AI 引擎 —— 离线查词的兜底 (不是替代)。
      // endpoint + model 存 config.toml; API key 存 Credential Manager (不落明文)。
      // 外发粒度三档: 查词(1词+1句) / 单句讲解 / 整本外发(默认关,每本确认)。这里只管配置。
      const onlineSec = el('div', 'settings-section');
      onlineSec.appendChild(el('h2', null, '在线引擎 (AI 兜底)'));
      onlineSec.appendChild(el('div', 'import-tip',
        '离线模型查词失败时的兜底: 填 OpenAI 兼容 endpoint + 模型名, API key 只存本机凭据管理器。从本机直连服务商 (不经任何中转)。'));
      const onlineEndpoint = el('input', 'prep-input');
      onlineEndpoint.placeholder = 'OpenAI 兼容 endpoint (如 https://api.openai.com/v1 或自建 vLLM)';
      const onlineModel = el('input', 'prep-input');
      onlineModel.placeholder = '模型名 (如 gpt-4o-mini / deepseek-chat / qwen2.5:14b)';
      const onlineKey = el('input', 'prep-input');
      onlineKey.type = 'password';
      onlineKey.placeholder = 'API key (存本机, 不落 config.toml; 留空 = 不修改)';
      const onlineStatus = el('div', 'sync-status', '读取中…');
      const onlineSave = el('button', 'btn-small btn-primary', '保存配置');
      const onlineTest = el('button', 'btn-small', '连通性测试');
      const onlineRow = el('div', 'settings-row');
      onlineRow.style.flexWrap = 'wrap';
      onlineRow.append(onlineSave, onlineTest);
      // L8 (2026-08-11): 三档授权落成两个独立开关, 默认全关。
      // ① 查词失败时可用在线 AI (发 1 词 + 1 句, ~200 字符)
      // ② 整本翻译/讲解可用在线引擎 (发全书正文, **默认关**, 开启时明确告知外发量)
      const mkSwitch = (label, tip, checked, onChange) => {
        const row = el('label', 'settings-row');
        const cb = el('input', '');
        cb.type = 'checkbox';
        cb.checked = !!checked;
        cb.disabled = true; // 未配置 key 时置灰, 指向配置区
        cb.onchange = () => onChange(cb.checked, cb);
        row.appendChild(cb);
        row.appendChild(el('span', null, label));
        const tipEl = el('div', 'settings-hint', tip);
        const wrap = el('div', 'settings-section');
        wrap.append(row, tipEl);
        return { cb, wrap };
      };
      const lookupSwitch = mkSwitch(
        '① 查词失败时可用在线 AI',
        '只发 1 个词 + 所在那 1 句 (~200 字符)。绝不自动回退 —— 本地查词失败时面板给「用在线 AI 查一次」, 点一下才外发, 发前显示将发送内容。',
        false,
        (v, cb) => {
          onlineStatus.textContent = v ? '开启①中…' : '关闭①中…';
          AiduMiscService.onlineConfigSet(onlineEndpoint.value.trim(), onlineModel.value.trim(), onlineKey.value.trim(), v, null)
            .then((r) => {
              if (!r.ok) { cb.checked = !v; onlineStatus.textContent = '保存失败: ' + r.error; return; }
              onlineKey.value = '';
              onlineStatus.textContent = '已保存 · 查词在线 ' + (v ? '开启' : '关闭') + ' · key: ' + (r.data && r.data.key_configured ? '已配置' : '未配置');
            });
        }
      );
      const wholeBookSwitch = mkSwitch(
        '② 整本翻译/讲解可用在线引擎',
        '会发送全书正文 (外发量可能很大)。默认关闭 —— 开启时每本确认后才发送。',
        false,
        (v, cb) => {
          onlineStatus.textContent = v ? '开启②中…' : '关闭②中…';
          AiduMiscService.onlineConfigSet(onlineEndpoint.value.trim(), onlineModel.value.trim(), onlineKey.value.trim(), null, v)
            .then((r) => {
              if (!r.ok) { cb.checked = !v; onlineStatus.textContent = '保存失败: ' + r.error; return; }
              onlineKey.value = '';
              onlineStatus.textContent = '已保存 · 整本在线 ' + (v ? '开启' : '关闭') + ' · key: ' + (r.data && r.data.key_configured ? '已配置' : '未配置');
            });
        }
      );
      onlineSec.append(onlineEndpoint, onlineModel, onlineKey, lookupSwitch.wrap, wholeBookSwitch.wrap, onlineRow, onlineStatus);
      systemPane.appendChild(onlineSec);

      AiduMiscService.onlineConfigGet().then((res) => {
        if (!res.ok) { onlineStatus.textContent = '读取失败: ' + res.error; return; }
        const d = res.data || {};
        onlineEndpoint.value = d.endpoint || '';
        onlineModel.value = d.model || '';
        onlineStatus.textContent = 'key: ' + (d.key_configured ? '已配置' : '未配置') +
          (d.endpoint ? ' · ' + d.endpoint : '') + (d.model ? ' · ' + d.model : '');
        // L8: 回显两档开关; 只有端点+key 都齐了才允许开 (否则置灰指向配置区)
        const canEnable = !!(d.endpoint && d.key_configured);
        lookupSwitch.cb.checked = !!d.lookup_enabled;
        wholeBookSwitch.cb.checked = !!d.whole_book_enabled;
        lookupSwitch.cb.disabled = !canEnable;
        wholeBookSwitch.cb.disabled = !canEnable;
        if (!canEnable) {
          onlineStatus.textContent = '先填 endpoint + API key 并保存, 再启用上面的开关。' +
            (d.key_configured ? '' : ' (key 未配置)');
        }
      });
      onlineSave.onclick = () => {
        onlineStatus.textContent = '保存中…';
        AiduMiscService.onlineConfigSet(onlineEndpoint.value.trim(), onlineModel.value.trim(), onlineKey.value.trim(),
          lookupSwitch.cb.checked, wholeBookSwitch.cb.checked)
          .then((r) => {
            if (!r.ok) { onlineStatus.textContent = '保存失败: ' + r.error; return; }
            onlineKey.value = '';
            const d = r.data || {};
            onlineStatus.textContent = '已保存 · key: ' + (d.key_configured ? '已配置' : '未配置') +
              ' · ①' + (d.lookup_enabled ? '开' : '关') + ' · ②' + (d.whole_book_enabled ? '开' : '关');
            // 保存后 key/endpoint 齐了才允许开开关
            lookupSwitch.cb.disabled = !(onlineEndpoint.value.trim() && d.key_configured);
            wholeBookSwitch.cb.disabled = !(onlineEndpoint.value.trim() && d.key_configured);
          });
      };
      onlineTest.onclick = () => {
        onlineStatus.textContent = '测试中…';
        AiduMiscService.onlineConfigTest(onlineEndpoint.value.trim() || null, onlineModel.value.trim() || null, onlineKey.value.trim() || null)
          .then((r) => {
            if (!r.ok) { onlineStatus.textContent = '测试失败: ' + r.error; return; }
            onlineStatus.textContent = '连通 ✓ 模型回复: ' + (r.data && r.data.reply ? r.data.reply : 'ok');
          });
      };

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
            row.append(nameEl, urlEl, stateEl, actions);
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
       syncPane.appendChild(syncSec);

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
        // J8 (2026-08-11): 「N 条待推」要解释为什么没推 (自动推送只在启动/完成时触发)
        if (d.pending_count > 0) {
          text += '\n' + d.pending_count + ' 条待推 —— 自动推送只在启动时和任务完成后触发; 想立刻发点「立即同步」。';
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
      syncBtn.onclick = () => {
        syncStatus.textContent = '同步中…';
        AiduSyncService.now().then((r) => {
          if (r.ok && r.data) refreshStatus(r.data, true);
          else syncStatus.textContent = '同步失败: ' + (r.error || '');
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

      AiduSettingsService.get('default').then((res) => {
        if (!res.ok) { wrap.appendChild(el('div', 'global-error', '读设置失败: ' + res.error)); return; }
        const s = res.data || {};
        const form = el('div', 'settings-form');

        // L9 (2026-08-11): 阅读显示这节放**真正的全局设置** —— 主题/主题色/儿童模式。
        // 字号/行距/栏宽/高亮只在阅读器浮层里调 (改的时候能看到效果), 设置页不再放只读摘要。
        // 先点明与「学习档案」的边界: 档案是处理参数(影响生成的内容), 这里是显示偏好(不影响生成)。
        form.appendChild(el('div', 'settings-hint',
          '这里只影响**显示外观** (怎么读), 不影响已生成的内容。字号/行距/栏宽/高亮在阅读器内调整。'));
        form.appendChild(el('div', 'settings-hint settings-warn',
          '与「学习档案」不同: 档案 (成人自读/陪小孩读) 是处理参数, 决定讲解深度/音色/语速, 影响下次生成的内容; 这里只改显示, 不碰生成。'));

        // 主题 (浅色/深色/跟随系统) —— M6 (2026-08-12): 主题在上, 主题色紧随其下,
        // 标签紧贴各自控件 (此前"主题色"标签被先 append, 实际顺序变成 主题色→主题→色点,
        // 用户指出"标签与控件错位")。
        const themeLabel = el('div', 'settings-hint', '主题');
        const themeRow = el('div', 'prep-row');
        const themeSel = el('select', 'prep-select');
        const THEMES = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
        THEMES.forEach(([k, l]) => {
          const opt = el('option', null, l); opt.value = k;
          themeSel.appendChild(opt);
        });
        themeSel.value = ['light', 'dark', 'system'].includes(s.theme) ? s.theme : 'light';
        themeSel.onchange = () => this._saveReadingSettings(Object.assign({}, s, { theme: themeSel.value, updated_at: Date.now() }), themeSel);
        themeRow.appendChild(themeSel);
        form.appendChild(themeLabel);
        form.appendChild(themeRow);
        // 主题色 (色块 chips, 与阅读器浮层同一套 PALETTES) —— 标签紧随主题之下
        const paletteLabel = el('div', 'settings-hint', '主题色');
        const palettes = SettingsView.PALETTES;
        const activePalette = s.palette || 'clay';
        const chipsRow = el('div', 'rd-theme-chips');
        form.appendChild(paletteLabel);
        palettes.forEach(([key, label, color]) => {
          const c = el('button', 'rd-theme-chip' + (activePalette === key ? ' active' : ''));
          c.style.setProperty('--chip', color);
          c.title = label;
          c.dataset.palette = key;
          c.onclick = () => {
            chipsRow.querySelectorAll('.rd-theme-chip').forEach((b) => b.classList.remove('active'));
            c.classList.add('active');
            this._saveReadingSettings(Object.assign({}, s, { palette: key, updated_at: Date.now() }));
          };
          chipsRow.appendChild(c);
        });
        form.appendChild(chipsRow);
        // 儿童模式: 勾选框 + 必须说明它到底改了什么 (L9 要求写明)
        const kidRow = el('label', 'settings-row');
        const kidCheck = el('input', '');
        kidCheck.type = 'checkbox';
        kidCheck.checked = !!s.child_mode;
        kidCheck.onchange = () => this._saveReadingSettings(Object.assign({}, s, { child_mode: kidCheck.checked, updated_at: Date.now() }), kidCheck);
        kidRow.appendChild(kidCheck);
        kidRow.appendChild(el('span', null, '儿童模式'));
        const kidExplain = el('div', 'settings-hint',
          '儿童模式改的是显示: 字号更大、对比度更高、默认词级高亮 (更适合跟读)。只影响显示, 不影响生成的内容。');

        form.append(kidRow, kidExplain);
         readingPane.appendChild(form);
        this._applyCss(s);
      });
      container.appendChild(wrap);
    }

    /** L9 (2026-08-11): 阅读显示全局设置保存 —— 完整 ReaderSettings upsert (只改这几个字段) */
    _saveReadingSettings(merged, controlEl) {
      AiduSettingsService.upsert(merged).then((r) => {
        if (!r.ok) {
          if (controlEl) controlEl.disabled = false;
          if (typeof AiduToast !== 'undefined') AiduToast.show('保存失败: ' + r.error, 'error');
          return;
        }
        this._applyCss(merged);
        if (typeof AiduToast !== 'undefined') AiduToast.show('已保存', 'success');
      });
    }

    _applyCss(s) {
      const root = document.documentElement;
      root.style.setProperty('--rd-text', (s.font_size || 19) + 'px');
      root.style.setProperty('--rd-lh', s.line_height || 1.85);
      root.style.setProperty('--rd-measure', (s.content_width || 660) + 'px');
      root.dataset.kid = s.child_mode ? '1' : '0';
      // L9 (2026-08-11): theme 支持 system (跟随系统) —— 解析后再上 body
      document.body.dataset.theme = (global.AiduTheme && AiduTheme.resolveTheme)
        ? AiduTheme.resolveTheme(s.theme)
        : (s.theme || 'light');
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
          // J7 (2026-08-11): 音色显示人话名 (af_heart → 女声温暖), 不把内部 id 上屏
          const voiceName = this._voiceHumanName(p.voice);
          const meta = el('div', 'profile-meta', `${strategy} · ${voiceName} · ${p.speed}x · ${gran}`);
          const actions = el('div', 'profile-actions');
          const edit = el('button', 'btn-small', '编辑');
          edit.onclick = () => this._editProfileModal(p, () => this._renderProfiles(listEl));
          actions.appendChild(edit);
          // J7 (2026-08-11): 内建档案也能删 (且可恢复) —— 统一: 能删就都能删。
          // 删除后 ensureBuiltins 会补回内建参数, 下次进来还是那两套默认。
          const del = el('button', 'btn-small btn-danger', '删除');
          del.onclick = () => {
            AiduModal.confirm({
              title: `删除档案「${p.name}」?`,
              message: (p.id === 'default' || p.id === 'kid')
                ? '删除后, 用这个档案处理过的书在书卡上会显示"未知档案" (不影响已生成的书)。内建档案可从设置里随时重新创建 (参数用默认值)。'
                : '删除后, 用这个档案处理过的书在书卡上会显示"未知档案" (不影响已生成的书)。',
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
          row.append(head, meta, actions);
          listEl.appendChild(row);
        });
      });
    }

    /** J7: 音色 id → 人话名 (af_heart → 女声温暖 (默认)) */
    _voiceHumanName(voiceId) {
      const found = SettingsView.VOICES.find(([id]) => id === voiceId);
      if (found) return found[1].split(' · ').slice(1).join(' · ') || found[1];
      return voiceId || '默认音色';
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
