/**
 * views/models_view.js —— 模型中心 (H4)
 * 按语言分组 → 家族 (翻译/讲解 LLM, 语音 TTS, 词法 NLP)
 * 每项: 名称/大小/状态/推荐/移除/设为推荐; 顶部"扫描复用"+"登记"
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // M7 R8 (2026-08-08): 已知可下载模型目录 —— URL/sha256/大小全部实测验证过
  // (HF API 2026-08-08 查得), 不是猜的。
  const DOWNLOAD_CATALOG = [
    {
      family: 'llm', label: '翻译/讲解引擎', name: 'Qwen3-4B', file: 'Qwen3-4B-Q4_K_M.gguf',
      url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
      sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
      sizeBytes: 2497280256, version: 'Q4_K_M',
    },
    {
      family: 'tts', label: '语音引擎', name: 'Kokoro-82M', file: 'kokoro-v1_0.pth',
      url: 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth',
      sha256: '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4',
      sizeBytes: 327212226, version: 'v1.0',
    },
  ];

  class ModelsView {
    constructor(store) {
      this.store = store;
    }

    render(container) {
      this.host = container;
      container.innerHTML = '';
      const wrap = el('div', 'models-view');
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '模型中心'));
      const scanBtn = el('button', 'btn-primary', '扫描已有模型');
      scanBtn.onclick = () => this._scanAndRegister();
      header.appendChild(scanBtn);
      wrap.appendChild(header);

      // M7 R8: 一键下载区 (新用户上手: 没模型时不用手动找文件)
      const downloadSec = el('div', 'model-downloads');
      wrap.appendChild(downloadSec);

      const listEl = el('div', 'models-list');
      wrap.appendChild(listEl);
      container.appendChild(wrap);

      AiduModelService.list().then((res) => {
        listEl.innerHTML = '';
        if (!res.ok) { listEl.appendChild(el('div', 'global-error', '读模型列表失败: ' + res.error)); return; }
        const models = res.data || [];
        this._renderDownloads(downloadSec, models);
        this._renderGrouped(listEl, models);
      }).catch((err) => {
        listEl.innerHTML = '';
        const error = el('div', 'global-error', '读模型列表失败: ' + String(err));
        const retry = el('button', 'btn-small', '重试');
        retry.onclick = () => this.render(this.host);
        listEl.append(error, retry);
      });
    }

    /** 一键下载区: 每个目录项一行动态显示已装/下载中/失败重试 */
    _renderDownloads(sec, models) {
      sec.innerHTML = '';
      const title = el('h2', null, '一键下载');
      const tip = el('div', 'import-tip',
        '下载常用引擎, 完成后自动登记。下载在后台进行, 支持断点续传; 中断后重新点即可继续。');
      const rows = el('div', 'model-download-list');
      DOWNLOAD_CATALOG.forEach((item) => {
        const row = el('div', 'model-row');
        const name = el('span', 'model-name', item.label + ' · ' + item.name);
         const registeredModel = models.find((m) => m.family === item.family && m.model_id === item.name);
         if (registeredModel) {
           const statusLabel = { registered: '已登记', recommended: '已绑定推荐', bound: '已绑定使用' };
           const badge = el('span', 'book-badge badge-ok', statusLabel[registeredModel.asset_status] || '已登记');
           badge.style.marginLeft = '8px';
           name.appendChild(badge);
         }
        const size = el('span', 'model-meta', `${(item.sizeBytes / 1e6).toFixed(0)} MB`);
         const btn = el('button', 'btn-primary', registeredModel ? '已登记' : '下载');
         btn.disabled = !!registeredModel;
         if (!registeredModel) btn.onclick = () => this._downloadModel(item, btn);
        const actions = el('div', 'model-actions');
        actions.appendChild(btn);
        row.append(name, size, actions);
        rows.appendChild(row);
      });
      sec.append(title, tip, rows);
    }

    /** 后台下载 + 轮询状态 (不冻结 UI) → 完成自动登记 */
    _downloadModel(item, btn) {
      btn.disabled = true;
      btn.textContent = '下载中…';
      AiduMiscService.runtimeConfig().then((cfg) => {
        const d = (cfg && cfg.ok && cfg.data) || {};
        const dir = (d.llm_model || d.tts_model)
          ? (d.llm_model || d.tts_model).replace(/[\\/][^\\/]+$/, '')
          : (d.default_model_dir || '');
        if (!dir) throw new Error('找不到模型目录');
        const dest = dir.replace(/[\\/]+$/, '') + '/' + item.file;
        // F4: 超时按文件规模算 (至少 600s, 1MB/s 下限)
        const timeout = Math.max(600, Math.round(item.sizeBytes / 1048576));
        return AiduModelService.download(item.url, dest, item.sha256, timeout).then((r) => {
          if (!r.ok) throw new Error(r.error);
          return this._pollDownload(r.data.token, btn, item, dest);
        });
      }).catch((e) => {
        AiduToast.show('下载失败: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '重试下载';
      });
    }

    _pollDownload(token, btn, item, dest) {
      return AiduModelService.downloadStatus(token).then((res) => {
        const d = (res.ok && res.data) || {};
        if (!d.done) {
          // M7 R12: 进度可感知 —— 字节数 + 进度条 (大下载不再"只看到下载中…")
          const readMB = (d.bytes_read || 0) / 1048576;
          const totalMB = (d.total || item.sizeBytes) / 1048576;
          const pct = totalMB > 0 ? Math.min(100, Math.round((readMB / totalMB) * 100)) : 0;
          btn.textContent = `下载中… ${pct}% (${readMB.toFixed(0)}/${totalMB.toFixed(0)} MB)`;
          return new Promise((resolve) => setTimeout(() => resolve(this._pollDownload(token, btn, item, dest)), 1000));
        }
        if (!d.ok) throw new Error(d.error || '未知错误');
        // 完成 → 自动登记
        return AiduModelService.register({
          family: item.family, language: 'en', model_id: item.name, version: item.version,
          variant: item.version, path: dest, source_type: 'local',
          source_ref: item.url, sha256: item.sha256, size_bytes: item.sizeBytes, custom: false,
        }).then((reg) => {
          if (!reg.ok) throw new Error(reg.error);
          AiduToast.show('已下载并登记: ' + item.name, 'success');
          btn.textContent = '已安装';
          this._reload();
        });
      });
    }

    _renderGrouped(listEl, models) {
      const byLang = {};
      (models || []).forEach(m => {
        if (!byLang[m.language]) byLang[m.language] = [];
        byLang[m.language].push(m);
      });
      Object.keys(byLang).sort().forEach(lang => {
        const group = el('div', 'model-group');
        group.appendChild(el('h2', null, `语言: ${lang === '*' ? '通用' : lang.toUpperCase()}`));
        let hasLlm = false, hasTts = false;
        ['llm', 'tts', 'nlp'].forEach(family => {
          const famModels = byLang[lang].filter(m => m.family === family);
          if (family === 'llm' && famModels.length) hasLlm = true;
          if (family === 'tts' && famModels.length) hasTts = true;
          if (!famModels.length) return;
          const famName = { llm: '翻译/讲解引擎', tts: '语音引擎', nlp: '词法引擎' }[family];
          group.appendChild(el('h3', null, famName));
          famModels.forEach(m => {
            const row = el('div', 'model-row');
            const nameWrap = el('span', 'model-name');
            nameWrap.textContent = m.model_id + (m.custom ? ' (自定义)' : '');
            if (m.active) {
              // 苹果级: 推荐徽章 (视觉化, 替代文字)
              const badge = el('span', 'book-badge badge-ok', '推荐');
              badge.style.marginLeft = '8px';
              nameWrap.appendChild(badge);
            }
            const size = el('span', 'model-meta', `${Math.round(m.size_bytes / 1e6)} MB · ${m.variant}`);
            const actions = el('div', 'model-actions');
            if (!m.active) {
              const fav = el('button', 'btn-small', '设为推荐');
              fav.onclick = () => AiduModelService.setRecommended(m.id)
                .then((r) => { if (r.ok) { AiduToast.show('已设为推荐: ' + m.model_id, 'success'); this._reload(); } });
              actions.appendChild(fav);
            }
            const del = el('button', 'btn-small btn-danger', '移除');
            del.onclick = () => {
              AiduModal.confirm({
                title: `移除模型 ${m.model_id}?`,
                message: '移除后处理书籍时将不再可用。',
                confirmText: '移除',
                danger: true,
                onConfirm: () => AiduModelService.remove(m.id).then(() => { this._reload(); AiduToast.show('已移除', 'info'); }),
              });
            };
            actions.appendChild(del);
            row.append(nameWrap, size, actions);
            group.appendChild(row);
          });
        });
        // 缺模型引导 (苹果级: 指向下一步)
        if (!hasLlm || !hasTts) {
          const missing = !hasLlm && !hasTts ? '翻译引擎和语音引擎' : (!hasLlm ? '翻译引擎' : '语音引擎');
          const warn = el('div', 'settings-hint settings-warn',
            `还缺${missing}。导入书籍前至少需要一套完整的模型组合。`);
          group.appendChild(warn);
        }
        listEl.appendChild(group);
      });
      if (!Object.keys(byLang).length) {
        const empty = el('div', 'book-empty', '还没有登记任何模型。导入书籍前需要配置翻译引擎和语音引擎。');
        const scanBtn = el('button', 'btn-small btn-primary', '扫描已有模型');
        scanBtn.onclick = () => this._scanAndRegister();
        const emptyWrap = el('div', 'prep-empty');
        emptyWrap.append(empty, scanBtn);
        listEl.appendChild(emptyWrap);
      }
    }

    _scanAndRegister() {
      // 从运行时配置取模型目录 (不硬编码开发机路径)
      AiduMiscService.runtimeConfig().then((cfg) => {
        const llmPath = cfg && cfg.ok && cfg.data && cfg.data.llm_model ? cfg.data.llm_model : '';
        const dir = llmPath ? llmPath.replace(/[\\/][^\\/]+$/, '') : '';
        return AiduModelService.scan(dir || 'C:/');
      }).then((res) => {
        if (!res.ok) { AiduToast.show('扫描失败: ' + res.error, 'error'); return; }
        const found = res.data || [];
        if (!found.length) { AiduToast.show('没有找到新的模型文件', 'info'); return; }
        const jobs = found.map(m => AiduModelService.register({
          family: m.file_name.endsWith('.gguf') ? 'llm' : 'tts',
          language: 'en',
          model_id: m.file_name.replace(/\.[^.]+$/, ''),
          version: 'scanned',
          path: m.path,
          source_type: 'local',
          size_bytes: m.size_bytes,
          custom: true,
        }));
        Promise.all(jobs).then(() => { this._reload(); AiduToast.show(`已登记 ${found.length} 个模型`, 'success'); });
      });
    }

    _reload() {
      // Embedded model center must refresh only its own host, not the whole settings page.
      if (this.host) this.render(this.host);
    }
  }

  global.ModelsView = ModelsView;
})(window);
