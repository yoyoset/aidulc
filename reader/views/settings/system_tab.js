/**
 * views/settings/system_tab.js —— 设置页「系统与书库」tab (日志/首次向导/书库位置/在线引擎)
 * 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 settings_view.js 的巨型
 * render() 拆出——原来 5 个 tab 全内联写在一个 889 行的函数里, 现在每个 tab 独立成文件,
 * 仿 reader/views/reader/*.js 已经用过的拆分模式。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsSystemTab {
    /** @param {HTMLElement} pane 挂载点(「系统与书库」tab 的 pane)
     *  @param {object} store 阅读器全局 store (加载已有书库成功后需要触发 change) */
    render(pane, store) {
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
             pane.appendChild(logSec);
      
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
            pane.appendChild(wizardSec);
      
            // P1.2: 书库位置(用户明确要求的产品能力, 见 docs/ROADMAP.md P1)
            // UX5 #4 (2026-08-13): 书库位置 = 数据根 —— config/db/jobs_out/models/backups/logs
            // 全部在根下; 当前生效位置存在且可写 → 绿色徽章, 失效 → 红/灰 + 原因。
            const libSec = el('div', 'settings-section');
            libSec.appendChild(el('h2', null, '书库位置'));
            libSec.appendChild(el('div', 'import-tip',
              '这里是所有数据的根: 数据库 (data.db)、配置 (config.toml)、书库 (jobs_out/)、模型 (models/)、备份 (backups/)、日志 (logs/) 都在它下面。整个目录拷到另一台机器, 选中即用。'));
            const libPathRow = el('div', 'settings-row');
            const libPath = el('code', 'j0-path', '读取中…');
            // UX5 #4: 绿色生效徽章 (失效标红 + 原因)
            const libBadge = el('span', 'lib-badge lib-badge-loading', '检查中…');
            libPathRow.append(libPath, libBadge);
            libSec.appendChild(libPathRow);
            const libBtns = el('div', 'page-toolbar');
            libBtns.style.flexWrap = 'wrap';
            const libOpenBtn = el('button', 'btn-small', '在资源管理器中打开');
            libOpenBtn.title = '打开当前书库位置 (不改动任何东西)';
            const libChangeBtn = el('button', 'btn-small', '更改…');
            // UX5 #4: 更改 = 整根迁移 (先备份, 复制校验通过才删旧, 重启生效)
            libChangeBtn.title = '换一个空目录做新的数据根。会整根迁移 (配置/数据库/书库/模型), 先备份、复制并逐文件校验, 通过后重启时才删除旧位置。';
            // L7 (2026-08-11): 加载已有书库目录 —— 选一个大文件夹, 里面的成品书包可登记
            const libLoadBtn = el('button', 'btn-small', '加载已有书库…');
            libLoadBtn.title = '选一个装有成品书包的目录 (比如从另一台电脑整个拷过来的库), 扫描 → 确认后登记到当前数据根, 不复制不移动文件。';
            libBtns.append(libOpenBtn, libChangeBtn, libLoadBtn);
            libSec.appendChild(libBtns);
            const libMeta = el('div', 'settings-meta');
            libSec.appendChild(libMeta);
            // UX5 修正: 书库成品不在数据根下时的收拢警告 (数据分散两个地方 → 一键收拢)
            const libOutWarn = el('div', 'import-tip');
            libSec.appendChild(libOutWarn);
            const libMsg = el('div', 'import-tip');
            libSec.appendChild(libMsg);
             pane.appendChild(libSec);
      
            const refreshLibPath = () => {
              AiduMiscService.libraryDirGet().then((r) => {
                libPath.textContent = r.ok ? r.data : ('读取失败: ' + r.error);
                libPath.title = r.ok ? r.data : '';
              });
              // UX5 #4: 徽章 —— 存在且可写 → 绿色; 否则红/灰 + 原因。书库不在根下 → 收拢警告。
              AiduMiscService.libraryRootStatus().then((r) => {
                if (!r.ok || !r.data) { libBadge.className = 'lib-badge lib-badge-err'; libBadge.textContent = '无法检查'; return; }
                const d = r.data;
                if (d.ok) {
                  libBadge.className = 'lib-badge lib-badge-ok';
                  libBadge.textContent = '生效中';
                  libBadge.title = '当前书库位置可用 (可写)';
                } else {
                  libBadge.className = 'lib-badge lib-badge-err';
                  libBadge.textContent = (d.reason || '已失效') + (d.db_exists ? '' : ' · 数据库缺失');
                  libBadge.title = d.reason || '书库位置失效';
                }
                // 摘要: 数据根 + 数据库 (都在根下, 一致); 书库只在不在根下时列出并标 ⚠
                const meta = [`数据根: ${d.root}`, `数据库: ${d.db_path || (d.root + '\\data.db')}`];
                if (d.out_dir && !d.out_inside_root) {
                  meta.push(`书库: ${d.out_dir} (不在数据根下, 见下方警告)`);
                }
                libMeta.textContent = meta.join('\n');
                // 收拢警告: 书库成品不在数据根下 → 一键收拢 (备份+校验+重启清旧)
                libOutWarn.innerHTML = '';
                if (d.out_dir && !d.out_inside_root) {
                  libOutWarn.style.display = '';
                  libOutWarn.appendChild(el('span', null,
                    `书库成品当前在旧位置「${d.out_dir}」, 不在数据根下 —— 数据分散在两个地方。收拢后所有数据都在数据根里, 整个目录拷走即用。`));
                  const consolidateBtn = el('button', 'btn-small btn-primary', '收拢到数据根');
                  consolidateBtn.style.marginLeft = '8px';
                  consolidateBtn.title = '把书库成品收拢到数据根下的 jobs_out/: 先自动备份到 backups/, 复制并逐文件校验 (大小+sha256), 通过后重启时才清理旧位置。';
                  consolidateBtn.onclick = () => {
                    consolidateBtn.disabled = true;
                    consolidateBtn.textContent = '收拢中…';
                    AiduMiscService.libraryOutConsolidate().then((r2) => {
                      consolidateBtn.disabled = false;
                      if (!r2.ok) {
                        libOutWarn.appendChild(el('div', null, '收拢失败: ' + r2.error));
                        return;
                      }
                      const d2 = r2.data || {};
                      libOutWarn.innerHTML = '';
                      libOutWarn.appendChild(el('div', null,
                        `已把书库收拢到数据根: ${d2.new_out} (备份: ${d2.backup_path || ''})。重启应用后从数据根读取。`));
                    });
                  };
                  libOutWarn.appendChild(consolidateBtn);
                } else {
                  libOutWarn.style.display = 'none';
                }
              });
              // 旧程序目录 (program dir) 迁移提示: 检测到旧位置有数据 → 引导迁到数据根。
              AiduMiscService.dataMigrationStatus().then((r) => {
                if (!r.ok || !r.data) return;
                const d = r.data;
                if (!d.pending) {
                  // M5 (2026-08-12) 真凶: 这里无条件清空 libMsg —— refreshLibPath 在每次 render
                  // 和「更改…」成功后都会跑, pending=false 就把刚写的动作结果当场抹掉。
                  // 只清自己写的迁移提示, 不动别的消息。
                  if (libMsg.textContent.startsWith('检测到旧位置')) libMsg.textContent = '';
                  return;
                }
                libMsg.textContent = '检测到旧位置 (程序目录) 下有书库与词库数据。为避免 cargo clean 等操作误删, 建议迁移到当前数据根。';
                const migrateBtn = el('button', 'btn-small btn-primary', '迁移到数据根');
                migrateBtn.style.marginLeft = '8px';
                migrateBtn.onclick = () => {
                  migrateBtn.disabled = true;
                  migrateBtn.textContent = '准备中…';
                  AiduMiscService.dataMigrationDryRun().then((dry) => {
                    if (!dry.ok || !dry.data || !dry.data.pending) {
                      migrateBtn.disabled = false;
                      migrateBtn.textContent = '迁移到数据根';
                      libMsg.textContent = dry.data && dry.data.pending === false ? '已无待迁移数据。' : (dry.error || '读取失败');
                      return;
                    }
                    const dd = dry.data.dry;
                    const items = dd.out_items + (dd.db_exists ? 1 : 0);
                    const msg = '将迁移 ' + items + ' 项 (书库 ' + (dd.out_bytes / 1048576).toFixed(1) +
                      ' MB' + (dd.db_exists ? ' + 数据库 ' + (dd.db_bytes / 1048576).toFixed(1) + ' MB' : '') +
                      ') 到:\n' + dd.target_out + '\n\n先自动备份到: backups/ 目录 (路径会显示), 复制并校验通过后才删除旧文件。完成后需要重启应用。';
                    AiduModal.confirm({
                      title: '迁移书库与词库到数据根?',
                      message: msg,
                      confirmText: '开始迁移',
                      danger: true,
                      onConfirm: () => AiduMiscService.dataMigrationRun().then((r3) => {
                        if (!r3.ok) { throw new Error(r3.error); }
                        libMsg.textContent = '迁移完成。备份: ' + r3.data.backup_path + '。请重启应用。';
                        libMsg.title = r3.data.backup_path;
                        return;
                      }),
                    });
                  });
                };
                libMsg.appendChild(migrateBtn);
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
      
            // UX5 #4: 更改… = 整根迁移。流程: 选目录 → 确认 (L1 清单+备份说明) → 迁移 → 重启生效。
            libChangeBtn.onclick = () => {
              libChangeBtn.disabled = true;
              libMsg.textContent = '选择新位置…';
              AiduMiscService.libraryDirPick().then((pick) => {
                if (!pick.ok || !pick.data || pick.data.cancelled) {
                  libChangeBtn.disabled = false;
                  if (pick && pick.ok && pick.data && pick.data.cancelled) {
                    libMsg.textContent = '已取消, 书库位置未更改。';
                  }
                  return;
                }
                const newRoot = pick.data.path;
                if (newRoot === libPath.textContent) {
                  libChangeBtn.disabled = false;
                  libMsg.textContent = '选择的位置和当前一致, 书库位置未更改。';
                  return;
                }
                libMsg.textContent = '确认迁移到: ' + newRoot + ' …';
                AiduModal.confirm({
                  title: '整根迁移书库位置?',
                  message: '将把整个数据根从「' + libPath.textContent + '」整根迁移到:\n\n' + newRoot +
                    '\n\n包含: config.toml / data.db / jobs_out/ / models/\n\n' +
                    '流程: 先自动备份到 backups/ → 复制并逐文件校验 (大小+sha256) → 校验通过后, 重启时才会删除旧位置文件。原位置文件一个都不会少。\n\n完成后需要重启应用。',
                  confirmText: '开始整根迁移',
                  danger: true,
                  onConfirm: () => AiduMiscService.libraryDirPickAndSet(newRoot).then((r) => {
                    if (!r.ok) { throw new Error(r.error); }
                    const d = r.data || {};
                    if (d.cancelled) {
                      libChangeBtn.disabled = false;
                      libMsg.textContent = '已取消, 书库位置未更改。';
                      return;
                    }
                    // UX5 修正: 用户选了当前书库所在目录 → 数据根迁过去, 书原地不动 (rooted_around_out)
                    libMsg.textContent = (d.rooted_around_out
                      ? '已把数据根迁到书库所在目录「' + d.new_dir + '」, 书库子项收进 ' + d.new_dir + '\\jobs_out, 你的书原地不动。'
                      : '已整根迁移到 ' + d.new_dir) + ' (备份: ' + (d.backup_path || '') + ')。重启应用后从新位置读取。';
                    libMsg.title = d.backup_path || '';
                    refreshLibPath();
                    return;
                  }),
                });
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
                      store.emit('change', store.state);
                    }),
                  });
                });
              });
            };
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
            // UX5 #6 (2026-08-13): 预设模型 deepseek-v4-flash (OPENCODE GO 的 OpenAI 兼容端点)
            onlineModel.placeholder = '模型名 (预设: deepseek-v4-flash)';
            const onlineKey = el('input', 'prep-input');
            onlineKey.type = 'password';
            onlineKey.placeholder = 'API key (存本机, 不落 config.toml; 留空 = 不修改)';
            const onlineStatus = el('div', 'sync-status', '读取中…');
            const onlineSave = el('button', 'btn-small btn-primary', '保存配置');
            const onlineTest = el('button', 'btn-small', '连通性测试');
            // UX5 #6 (2026-08-13): 「清除在线引擎 key」按钮 —— 接 credentials::delete_online_key
            const onlineClearKey = el('button', 'btn-small btn-danger', '清除在线引擎 key');
            onlineClearKey.title = '删除本机凭据管理器里保存的在线引擎 API key。清除后两档开关置灰, 显示未配置。';
            const onlineRow = el('div', 'settings-row');
            onlineRow.style.flexWrap = 'wrap';
            onlineRow.append(onlineSave, onlineTest, onlineClearKey);
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
            pane.appendChild(onlineSec);
      
            AiduMiscService.onlineConfigGet().then((res) => {
              if (!res.ok) { onlineStatus.textContent = '读取失败: ' + res.error; return; }
              const d = res.data || {};
              onlineEndpoint.value = d.endpoint || '';
              // UX5 #6 (2026-08-13): 模型预填 deepseek-v4-flash (没配过就预填, 存盘后就是它)
              onlineModel.value = d.model || 'deepseek-v4-flash';
              onlineStatus.textContent = 'key: ' + (d.key_configured ? '已配置' : '未配置') +
                (d.endpoint ? ' · ' + d.endpoint : '') + ' · ' + onlineModel.value;
              // L8: 回显两档开关; 只有端点+key 都齐了才允许开 (否则置灰指向配置区)
              const canEnable = !!(d.endpoint && d.key_configured);
              lookupSwitch.cb.checked = !!d.lookup_enabled;
              wholeBookSwitch.cb.checked = !!d.whole_book_enabled;
              lookupSwitch.cb.disabled = !canEnable;
              wholeBookSwitch.cb.disabled = !canEnable;
              // UX5 #6: 没有 key 时「清除 key」按钮置灰
              onlineClearKey.disabled = !d.key_configured;
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
            // UX5 #6 (2026-08-13): 清除在线引擎 key —— 确认后删, 开关置灰、状态显示未配置
            onlineClearKey.onclick = () => {
              AiduModal.confirm({
                title: '清除在线引擎的 API key?',
                message: '将删除本机凭据管理器里保存的在线引擎 API key。清除后两档授权开关会置灰, 需重新填入 key 才能再次外发。',
                confirmText: '清除',
                danger: true,
                onConfirm: () => AiduMiscService.onlineConfigClearKey().then((r) => {
                  if (!r.ok) throw new Error(r.error);
                  onlineKey.value = '';
                  onlineClearKey.disabled = true;
                  lookupSwitch.cb.checked = false;
                  wholeBookSwitch.cb.checked = false;
                  lookupSwitch.cb.disabled = true;
                  wholeBookSwitch.cb.disabled = true;
                  onlineStatus.textContent = '已清除在线引擎 key · 状态: 未配置';
                  return;
                }),
              });
            };
    }
  }

  global.SettingsSystemTab = SettingsSystemTab;
})(window);
