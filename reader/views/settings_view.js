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
      wrap.appendChild(logSec);

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
      wrap.appendChild(libSec);

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

      // G5: 组件中心 (健康检查)
      const compSec = el('div', 'settings-section');
      compSec.appendChild(el('h2', null, '组件与模型'));
      const compList = el('div', 'component-list');
      compSec.appendChild(compList);
      wrap.appendChild(compSec);
      AiduMiscService.componentsHealth().then((res) => {
        compList.innerHTML = '';
        if (!res.ok) { compList.appendChild(el('div', 'global-error', '检查失败: ' + res.error)); return; }
        (res.data || []).forEach(c => {
          const row = el('div', 'component-row',
            `${c.name}: ${c.healthy ? '✓ ' + c.detail : '✗ ' + c.detail}`);
          row.className += c.healthy ? ' component-ok' : ' component-bad';
          compList.appendChild(row);
        });
      });

      // I-C: 同步配置与状态
      const syncSec = el('div', 'settings-section');
      syncSec.appendChild(el('h2', null, '同步 (AIDU 生词)'));
      const syncStatus = el('div', 'sync-status', '读取中…');
      const urlInput = el('input', 'prep-input');
      urlInput.placeholder = 'CF Worker URL';
      const tokenInput = el('input', 'prep-input');
      tokenInput.type = 'password';
      tokenInput.placeholder = 'AUTH_TOKEN (存 Windows 凭据, 不落明文)';
      const saveBtn = el('button', 'btn-primary', '保存配置');
      const syncBtn = el('button', 'btn-small', '立即同步');
      const pullBtn = el('button', 'btn-small', '拉取合并');
      syncSec.append(syncStatus, urlInput, tokenInput, saveBtn, syncBtn, pullBtn);
      wrap.appendChild(syncSec);

      AiduSyncService.status().then((res) => {
        if (res.ok && res.data) {
          syncStatus.textContent = '状态: ' + AiduSyncService.statusLabel(res.data) +
            (res.data.last_sync_at ? ' · 上次 ' + new Date(res.data.last_sync_at).toLocaleTimeString() : '');
        }
      });
      saveBtn.onclick = () => {
        AiduSyncService.configure(urlInput.value.trim(), tokenInput.value.trim()).then((r) => {
          syncStatus.textContent = r.ok ? '配置已保存' : '保存失败: ' + r.error;
          tokenInput.value = '';
        });
      };
      syncBtn.onclick = () => {
        syncStatus.textContent = '同步中…';
        AiduSyncService.now().then((r) => {
          if (r.ok && r.data) syncStatus.textContent = '状态: ' + AiduSyncService.statusLabel(r.data);
          else syncStatus.textContent = '同步失败: ' + (r.error || '');
        });
      };
      pullBtn.onclick = () => {
        syncStatus.textContent = '拉取中…';
        AiduSyncService.pull().then((r) => {
          if (r.ok && r.data) syncStatus.textContent = '状态: ' + AiduSyncService.statusLabel(r.data);
          else syncStatus.textContent = '拉取失败: ' + (r.error || '');
        });
      };

      AiduSettingsService.get('default').then((res) => {
        if (!res.ok) { wrap.appendChild(el('div', 'global-error', '读设置失败: ' + res.error)); return; }
        const s = res.data || {};
        const form = el('div', 'settings-form');

        const fields = [
          ['font_size', '字号', 'number', s.font_size ?? 18, 'px'],
          ['line_height', '行距', 'number', s.line_height ?? 1.7, ''],
          ['content_width', '正文宽度', 'number', s.content_width ?? 760, 'px'],
        ];
        fields.forEach(([key, label, type, value, suffix]) => {
          const row = el('label', 'settings-row', label);
          const input = el('input', null);
          input.type = type;
          input.value = value;
          input.step = type === 'number' ? (key === 'line_height' ? 0.1 : 1) : '';
          input.onchange = () => {
            const patch = { ...s, [key]: parseFloat(input.value) || s[key], updated_at: Date.now() };
            AiduSettingsService.upsert(patch);
            this._applyCss(patch);
          };
          row.appendChild(input);
          if (suffix) row.appendChild(document.createTextNode(suffix));
          form.appendChild(row);
        });

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
          AiduBridge.settings.upsert(patch);
          this._applyCss(patch);
        };
        themeRow.appendChild(themeSel);
        form.appendChild(themeRow);

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
          AiduBridge.settings.upsert(patch);
          this._applyCss(patch);
        };
        childRow.append(el('span', null, '儿童模式 (更大字号/更高对比度/默认词级高亮)'), childBox);
        form.appendChild(childRow);

        wrap.appendChild(form);
        this._applyCss(s);
      });
      container.appendChild(wrap);
    }

    _applyCss(s) {
      const root = document.documentElement;
      root.style.setProperty('--reader-font-size', (s.font_size || 18) + 'px');
      root.style.setProperty('--reader-line-height', s.line_height || 1.7);
      root.style.setProperty('--reader-content-width', (s.content_width || 760) + 'px');
      document.body.dataset.theme = s.theme || 'light';
    }
  }

  global.SettingsView = SettingsView;
})(window);
