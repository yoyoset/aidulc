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

  // L4 (2026-08-11): nlp 家族的真实身份是 spaCy 分词/NLP (分句、词形还原、短语识别),
  // 不是"语音识别" —— 全项目没有任何 ASR/跟读打分实现。统一从这里取标签, 不再散落。
  const FAM_LABEL = {
    llm: '翻译/讲解',
    tts: '语音合成',
    nlp: '分词 / NLP',
  };

  class ModelsView {
    // N1 (2026-08-12): 向导"模型发现"步的代价告知需要同一份下载目录 (大小单一真相源)
    static get DOWNLOAD_CATALOG() { return DOWNLOAD_CATALOG; }

    constructor(store) {
      this.store = store;
    }    render(container) {
      this.host = container;
      container.innerHTML = '';
      const wrap = el('div', 'models-view');
      // J1 (2026-08-11): 扫描保留但降为次要操作。M4-3 (2026-08-12): 扫描不再一键全登记,
      // 弹窗里路径可见可增删 + 候选列表勾选后再登记。
      const scanBtn = el('button', 'btn-small', '扫描已有模型');
      scanBtn.onclick = () => this._openScanModal();
      // J4 (2026-08-11): 自定义模型 —— 粘 HF 链接添加
      const customBtn = el('button', 'btn-small', '添加自定义模型');
      customBtn.onclick = () => this._openCustomModelForm();
      // L5 (2026-08-11): 页头工具条 —— 按钮成组靠右、组内间距固定, 不再被 space-between 撑开。
      const header = global.AiduPageToolbar
        ? global.AiduPageToolbar.build('模型与依赖', [scanBtn, customBtn])
        : (() => {
            const h = el('div', 'page-header');
            h.appendChild(el('h1', null, '模型与依赖'));
            h.append(scanBtn, customBtn);
            return h;
          })();
      wrap.appendChild(header);

      // UX5 #5 (2026-08-13): 模型目录显示 —— 扫描/下载默认在这些目录进行, 可增删。
      // 与扫描弹窗的默认路径同一份数据 (this._modelDirs)。
      const dirsEl = el('div', 'model-dirs');
      wrap.appendChild(dirsEl);
      this._loadModelDirs(dirsEl);

      const listEl = el('div', 'models-list');
      wrap.appendChild(listEl);
      container.appendChild(wrap);

      AiduModelService.list().then((res) => {
        listEl.innerHTML = '';
        if (!res.ok) { listEl.appendChild(el('div', 'global-error', '读模型列表失败: ' + res.error)); return; }
        const models = res.data || [];
        this._models = models;
        this._renderGrouped(listEl, models);
      }).catch((err) => {
        listEl.innerHTML = '';
        const error = el('div', 'global-error', '读模型列表失败: ' + String(err));
        const retry = el('button', 'btn-small', '重试');
        retry.onclick = () => this.render(this.host);
        listEl.append(error, retry);
      });
    }

    /** UX5 修正 (2026-08-13): 目录路径归一化 (正斜杠 + 去尾部斜杠) —— 同一目录
     *  F:/hf_cache 与 F:\hf_cache 必须判重为同一项, 不能两个都显示。 */
    _normDir(p) {
      return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    }

    /** UX5 #5 (2026-08-13): 模型目录 —— 已登记模型所在目录 + HF 缓存, 可增删。
     *  扫描弹窗 (M4-3①) 与这里共用 this._modelDirs, 一处维护两处生效。 */
    _loadModelDirs(dirsEl) {
      AiduMiscService.runtimeConfig().then((cfg) => {
        const d = (cfg && cfg.ok && cfg.data) || {};
        const modelDir = String(d.llm_model || d.tts_model || '').replace(/[\\/][^\\/]+$/, '');
        const dirs = [];
        const modelDirN = this._normDir(modelDir);
        const hfN = this._normDir(d.hf_cache_dir);
        if (modelDirN) dirs.push(modelDirN);
        if (hfN && !dirs.includes(hfN)) dirs.push(hfN);
        this._modelDirs = dirs;
        this._renderModelDirs(dirsEl);
      }).catch(() => {
        this._modelDirs = [];
        this._renderModelDirs(dirsEl);
      });
    }

    _renderModelDirs(dirsEl) {
      dirsEl.innerHTML = '';
      const sec = el('div', 'model-group');
      sec.appendChild(el('h2', null, '模型目录'));
      sec.appendChild(el('div', 'import-tip',
        '扫描和下载都默认在这些目录进行。选目录 → 扫描已有模型; 没有就下载推荐, 有就看版本与更新。'));
      const rows = el('div', 'model-dir-list');
      (this._modelDirs || []).forEach((p, i) => {
        const row = el('div', 'model-dir-row');
        const code = el('code', 'j0-path', p);
        const rm = el('button', 'btn-small scan-path-rm', '×');
        rm.title = '从扫描/下载目录移除';
        rm.onclick = () => { this._modelDirs.splice(i, 1); this._renderModelDirs(dirsEl); };
        row.append(code, rm);
        rows.appendChild(row);
      });
      sec.appendChild(rows);
      const addBtn = el('button', 'btn-small', '+ 添加目录');
      addBtn.onclick = () => {
        AiduMiscService.libraryDirPick().then((r) => {
          if (r.ok && r.data && !r.data.cancelled && r.data.path) {
            const p = this._normDir(r.data.path);
            if (!this._modelDirs.includes(p)) {
              this._modelDirs.push(p);
              this._renderModelDirs(dirsEl);
            }
          }
        });
      };
      sec.appendChild(addBtn);
      dirsEl.appendChild(sec);
    }

    /** J2 (2026-08-11): 一个功能段的下载弹窗 —— 列出该 family 的候选目录 (磁盘探测)。
     *  判据: 该 family 有没有已登记且文件存在的模型; 有 → 不在这里出现 (已在主列表显示已配置)。 */
    _showDownloadSheet(family) {
      const candidates = DOWNLOAD_CATALOG.filter((c) => c.family === family);
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const famLabel = FAM_LABEL[family] || family;
      const title = el('h2', 'modal-title', `下载${famLabel}模型`);
      const body = el('div', 'book-settings-body');
      const rows = el('div', 'model-download-list');
      candidates.forEach((item) => {
        const row = el('div', 'model-row');
        const name = el('span', 'model-name', item.label + ' · ' + item.name);
        const size = el('span', 'model-meta', `${(item.sizeBytes / 1e6).toFixed(0)} MB`);
        const btn = el('button', 'btn-primary', '下载');
        const actions = el('div', 'model-actions');
        actions.appendChild(btn);
        row.append(name, size, actions);
        rows.appendChild(row);
        this._probeDiskState(item, btn);
      });
      body.appendChild(rows);
      const actions = el('div', 'modal-actions');
      const close = el('button', 'btn-small', '关闭');
      close.onclick = () => ov.remove();
      actions.appendChild(close);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

    /** J2: 同 family 多模型切换 (换一个) */
    _showFamilyModels(family, usable) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const famLabel = FAM_LABEL[family] || family;
      const title = el('h2', 'modal-title', `切换${famLabel}模型`);
      const body = el('div', 'book-settings-body');
      usable.forEach((m) => {
        const row = el('div', 'model-row');
        const name = el('span', 'model-name', this._modelHumanName(m) + (m.active ? ' (当前)' : ''));
        const size = el('span', 'model-meta', `${Math.round(m.size_bytes / 1e6)} MB`);
        const actions = el('div', 'model-actions');
        if (!m.active) {
          const use = el('button', 'btn-small', '设为推荐');
          use.onclick = () => AiduModelService.setRecommended(m.id).then((r) => {
            if (r.ok) { AiduToast.show('已切换', 'success'); ov.remove(); this._reload(); }
          });
          actions.appendChild(use);
        }
        row.append(name, size, actions);
        body.appendChild(row);
      });
      const actions = el('div', 'modal-actions');
      const close = el('button', 'btn-small', '关闭');
      close.onclick = () => ov.remove();
      actions.appendChild(close);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

    /** J4 (2026-08-11): 添加自定义模型 —— 粘 HF 链接 → 规范成 resolve 直链 → 下载并登记。
     *  复用 models_download (通用 URL 下载 + sha256 可选 + 断点续传), 不新写下载流。 */
    _openCustomModelForm() {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', '添加自定义模型');
      const body = el('div', 'book-settings-body');
      const hint = el('div', 'import-tip',
        '粘一个 HuggingFace 模型文件链接 (…/blob/… 页面链接或 …/resolve/… 直链)。blob 会自动转成直链。只支持 HuggingFace 域名。');
      const input = el('input', 'prep-input');
      input.placeholder = 'https://huggingface.co/…/blob/main/xxx.gguf';
      const status = el('div', 'sync-status', '');
      const famRow = el('div', 'prep-row');
      const famSel = el('select', 'prep-select');
      [['llm', '翻译/讲解'], ['tts', '语音合成'], ['nlp', '分词 / NLP']].forEach(([v, l]) => {
        const opt = el('option', null, l); opt.value = v; famSel.appendChild(opt);
      });
      famRow.append(el('span', null, '用途:'), famSel);
      body.append(hint, input, famRow, status);
      const actions = el('div', 'modal-actions');
      const cancel = el('button', 'btn-small', '取消');
      cancel.onclick = () => ov.remove();
      const go = el('button', 'btn-primary', '下载并登记');
      go.onclick = () => {
        const raw = input.value.trim();
        if (!raw) { status.textContent = '先粘一个 HF 链接'; input.focus(); return; }
        go.disabled = true;
        status.textContent = '解析链接…';
        AiduModelService.hfNormalize(raw).then((r) => {
          if (!r.ok) { status.textContent = '无法解析: ' + r.error + ' (请贴 …/resolve/… 直链)'; go.disabled = false; return; }
          const d = r.data || {};
          famSel.value = d.family_hint || famSel.value;
          status.textContent = '已解析: ' + d.file + ' → 开始下载 (文件较大可能需要几分钟)。';
          // 复用通用下载 (sha256 未知 → null; 后台线程不冻结 UI)
          this._modelDir().then((dir) => {
            if (!dir) throw new Error('找不到模型目录');
            const dest = dir.replace(/[\\/]+$/, '') + '/' + d.file;
            const timeout = Math.max(600, 1);
            return AiduModelService.download(d.url, dest, null, timeout).then((dl) => {
              if (!dl.ok) throw new Error(dl.error);
              return this._pollDownload(dl.data.token, go, {
                url: d.url, file: d.file, name: d.file.replace(/\.[^.]+$/, ''),
                version: 'custom', sizeBytes: 0, sha256: '',
              }, dest, famSel.value);
            });
          }).catch((e) => {
            status.textContent = '下载失败: ' + (e && e.message || e);
            go.disabled = false;
          });
        });
      };
      actions.append(cancel, go);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
      input.focus();
    }
    _modelHumanName(m) {
      const base = String(m.model_id || m.id || '');
      const parts = base.split('-').filter(Boolean);
      const brand = parts[0] || '';
      const size = parts[1] || '';
      const quant = String(m.variant || '').toUpperCase() || 'Q4_K_M';
      return `${brand} ${size}`.trim() + (quant ? ' · ' + quant : '');
    }

    /** UX5 #5 (2026-08-13): 版本/更新判定 —— 候选文件 vs DOWNLOAD_CATALOG 已知版本。
     *  无已登记 → 「可下载/可登记」; 已登记且文件在 → 版本 + 「已是最新」/「有新版」;
     *  目录里没有该文件 → 老实说「版本未知, 无法判断」。 */
    _versionStatus(candidate) {
      const family = candidate.family_hint || 'unknown';
      const base = String(candidate.file_name || '');
      const cat = DOWNLOAD_CATALOG.find((x) =>
        x.family === family && (x.file === base || x.name === base.replace(/\.[^.]+$/, '')));
      if (!cat) {
        return { text: '版本未知, 无法判断', cls: 'badge-warn' };
      }
      if (!candidate.registered) {
        return { text: `v${cat.version} · 可下载/可登记`, cls: 'badge-idle' };
      }
      const newer = DOWNLOAD_CATALOG.filter((x) => x.family === cat.family && x.version !== cat.version);
      if (newer.length) {
        return { text: `v${cat.version} · 有新版 v${newer[0].version}, 可更新`, cls: 'badge-warn' };
      }
      return { text: `v${cat.version} · 已是最新`, cls: 'badge-ok' };
    }

    /** 该 family 是否有"已登记且文件存在"的模型 (与 _renderGrouped 的 usableOf 同判据)。 */
    _familyUsable(family) {
      const models = this._models || [];
      return models.some((m) => m.family === family && m.path && String(m.path).trim() !== '');
    }

    /** M4-3③: 存量误登记改家族 (id 含家族, 改家族重建 id; active 保持) */
    _setFamilyModal(m) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', '改家族: ' + (m.model_id || m.id));
      const body = el('div', 'book-settings-body');
      const hint = el('div', 'settings-hint',
        '当前家族: ' + (FAM_LABEL[m.family] || m.family || '未知') + '。改家族会重建模型 id (原 id 移除)。');
      const famSel = el('select', 'prep-select');
      [['llm', '翻译/讲解'], ['tts', '语音合成'], ['nlp', '分词/NLP']].forEach(([v, l]) => {
        const o = el('option', null, l); o.value = v; famSel.appendChild(o);
      });
      famSel.value = ['llm', 'tts', 'nlp'].includes(m.family) ? m.family : 'llm';
      const actions = el('div', 'modal-actions');
      const cancel = el('button', 'btn-small', '取消');
      cancel.onclick = () => ov.remove();
      const save = el('button', 'btn-primary', '保存');
      save.onclick = () => {
        if (famSel.value === m.family) { ov.remove(); return; }
        save.disabled = true;
        save.textContent = '保存中…';
        AiduModelService.setFamily(m.id, famSel.value).then((r) => {
          if (!r.ok) { save.disabled = false; save.textContent = '保存'; AiduToast.show('改家族失败: ' + r.error, 'error'); return; }
          ov.remove();
          AiduToast.show('已改家族为 ' + (FAM_LABEL[famSel.value] || famSel.value), 'success');
          this._reload();
        });
      };
      actions.append(cancel, save);
      body.append(hint, famSel);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

    /** 探测目标路径的磁盘状态 → 把按钮切成 磁盘已有·点此登记 / 下载 (失败一律落 下载, 不阻塞) */
    _probeDiskState(item, btn) {
      this._modelDir().then((dir) => {
        if (!dir) { this._setDownloadBtn(btn, item); return; }
        const dest = dir.replace(/[\\/]+$/, '') + '/' + item.file;
        return AiduModelService.fileCheck(dest, Math.round(item.sizeBytes * 0.5)).then((res) => {
          const d = (res && res.ok && res.data) || {};
          if (d.present && d.healthy) {
            btn.textContent = '磁盘已有 · 点此登记';
            btn.disabled = false;
            btn.title = '文件已在磁盘, 点此登记进注册表 (不会再下载)';
            btn.onclick = () => this._registerExisting(item, dest, btn);
          } else {
            this._setDownloadBtn(btn, item);
          }
        });
      }).catch(() => this._setDownloadBtn(btn, item));
    }

    /** 模型目录 (与 _downloadModel 同一来源: 已配置路径的目录, 否则默认目录) */
    _modelDir() {
      if (!this._modelDirPromise) {
        this._modelDirPromise = AiduMiscService.runtimeConfig().then((cfg) => {
          const d = (cfg && cfg.ok && cfg.data) || {};
          const configured = d.llm_model || d.tts_model;
          return configured ? configured.replace(/[\\/][^\\/]+$/, '') : (d.default_model_dir || '');
        }).catch(() => '');
      }
      return this._modelDirPromise;
    }

    _setDownloadBtn(btn, item) {
      btn.textContent = '下载';
      btn.disabled = false;
      btn.title = '';
      btn.onclick = () => this._downloadModel(item, btn);
    }

    /** D: 磁盘已有 → 登记 (不进下载流) */
    _registerExisting(item, dest, btn) {
      btn.disabled = true;
      btn.textContent = '登记中…';
      AiduModelService.register({
        family: item.family, language: 'en', model_id: item.name, version: item.version,
        variant: item.version, path: dest, source_type: 'local',
        source_ref: item.url, sha256: item.sha256, size_bytes: item.sizeBytes, custom: false,
      }).then((reg) => {
        if (!reg.ok) {
          AiduToast.show('登记失败: ' + reg.error, 'error');
          btn.textContent = '磁盘已有 · 点此登记';
          btn.disabled = false;
          return;
        }
        AiduToast.show('已登记磁盘上的模型: ' + item.name, 'success');
        this._reload();
      });
    }

    /** 后台下载 + 轮询状态 (不冻结 UI) → 完成自动登记 */
    _downloadModel(item, btn) {
      btn.disabled = true;
      btn.textContent = '下载中…';
      this._modelDir().then((dir) => {
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

    _pollDownload(token, btn, item, dest, customFamily) {
      return AiduModelService.downloadStatus(token).then((res) => {
        const d = (res.ok && res.data) || {};
        if (!d.done) {
          // M7 R12: 进度可感知 —— 字节数 + 进度条 (大下载不再"只看到下载中…")
          const readMB = (d.bytes_read || 0) / 1048576;
          const totalMB = (d.total || item.sizeBytes) / 1048576;
          const pct = totalMB > 0 ? Math.min(100, Math.round((readMB / totalMB) * 100)) : 0;
          btn.textContent = `下载中… ${pct}% (${readMB.toFixed(0)}/${totalMB.toFixed(0)} MB)`;
          return new Promise((resolve) => setTimeout(() => resolve(this._pollDownload(token, btn, item, dest, customFamily)), 1000));
        }
        if (!d.ok) throw new Error(d.error || '未知错误');
        // 完成 → 自动登记 (J4: 自定义模型 family 由用户选, custom=true)
        return AiduModelService.register({
          family: customFamily || item.family, language: 'en', model_id: item.name, version: item.version,
          variant: item.version, path: dest, source_type: 'local',
          source_ref: item.url, sha256: item.sha256, size_bytes: item.sizeBytes, custom: !!customFamily,
        }).then((reg) => {
          if (!reg.ok) throw new Error(reg.error);
          AiduToast.show('已下载并登记: ' + item.name, 'success');
          btn.textContent = '已安装';
          this._reload();
        });
      });
    }

    /** J1/J2 (2026-08-11): 按功能分组 —— 每段回答"当前用什么/有没有/要不要补/更新"。
     *  翻译讲解 / 语音合成 / 分词NLP 三段 (L4: nlp 是 spaCy 分词, 不是语音识别)。
     *  一键下载不再是独立区块, 而是每段里没有可用模型时的「去下载」。判据 (J2):
     *  该 family 有没有已登记且文件存在的模型, 有 → 「已配置(名称)」+「换一个」;
     *  没有 → 提供下载。 */
    _renderGrouped(listEl, models) {
      listEl.innerHTML = '';
      const all = (models || []).filter((m) => ['llm', 'tts', 'nlp'].includes(m.family));
      // J2 核心判据: 该 family 是否有"已登记且文件存在"的模型
      const usableOf = (family) => all.filter((m) => m.family === family && m.path && String(m.path).trim() !== '');
      const famLabel = FAM_LABEL;

      const section = (family, tip, missingTip, missingExtra) => {
        const sec = el('div', 'model-group');
        sec.appendChild(el('h2', null, famLabel[family]));
        if (tip) sec.appendChild(el('div', 'import-tip', tip));
        const usable = usableOf(family);
        if (usable.length) {
          // UX5 修正 (2026-08-13): "可用"只给推荐(active)模型 —— 处理时 prep 用的是推荐模型,
          // 不是"任意已登记"。未设推荐时, 已登记模型只是躺在注册表里, 不能自称可用
          // (否则会出现"语音合成=可用, 依赖组件却缺引擎"的自相矛盾, 用户实测撞见)。
          const active = usable.find((m) => m.active);
          if (active) {
            // 已设推荐 → 当前模型名 + 换一个 (J2: 判据不看特定文件名)
            const row = el('div', 'model-row');
            const name = el('span', 'model-name', this._modelHumanName(active) + (active.custom ? ' (自定义)' : ''));
            const badge = el('span', 'book-badge badge-ok', '可用');
            badge.style.marginLeft = '8px';
            name.appendChild(badge);
            const size = el('span', 'model-meta', `${Math.round(active.size_bytes / 1e6)} MB`);
            const actions = el('div', 'model-actions');
            const switchBtn = el('button', 'btn-small', '换一个');
            switchBtn.title = usable.length > 1 ? `另有 ${usable.length - 1} 个同功能模型` : '已登记的模型都在这里';
            switchBtn.onclick = () => this._showFamilyModels(family, usable);
            actions.appendChild(switchBtn);
            row.append(name, size, actions);
            sec.appendChild(row);
          } else {
            // 有登记但没设推荐 → 处理时不会用 (与依赖组件"缺引擎"一致, 不再谎称可用)
            sec.appendChild(el('div', 'settings-hint settings-warn',
              `已登记 ${usable.length} 个, 但都未设为推荐 —— 处理时不会自动使用, 引擎会缺 (见下方依赖组件)。点「换一个」把想用的设为推荐, 或直接下载推荐引擎。`));
            const actions = el('div', 'model-actions');
            const switchBtn = el('button', 'btn-small', '换一个');
            switchBtn.onclick = () => this._showFamilyModels(family, usable);
            actions.appendChild(switchBtn);
            const hasCatalog = DOWNLOAD_CATALOG.some((c) => c.family === family);
            if (hasCatalog) {
              const dl = el('button', 'btn-small btn-primary', '去下载');
              dl.onclick = () => this._showDownloadSheet(family);
              actions.appendChild(dl);
            }
            sec.appendChild(actions);
          }
        } else {
          // 没有可用模型 → 该段的「去下载」
          const missing = el('div', 'settings-hint settings-warn', missingTip || '未配置 —— 处理书籍前需要它。');
          sec.appendChild(missing);
          // M4-1 (2026-08-12): 某功能没有可下载的目录项 → 不渲染「去下载」按钮。
          // 空按钮比没按钮更糟 (nlp 无目录项, 点开是空对话框, 就是用户碰到的那个)。
          const hasCatalog = DOWNLOAD_CATALOG.some((c) => c.family === family);
          if (hasCatalog) {
            const dl = el('button', 'btn-primary', '去下载');
            dl.onclick = () => this._showDownloadSheet(family);
            sec.appendChild(dl);
          }
          // 回答"我现在用的什么" (M4-1: 用户不知道自己在用什么)
          if (missingExtra) sec.appendChild(el('div', 'import-tip', missingExtra));
        }
        listEl.appendChild(sec);
      };

      section('llm', '解释词义、例句翻译、讲解。处理书籍前必须先有这个。', '未配置 —— 翻译/讲解需要它, 否则无法处理书籍。');
      section('tts', '朗读原文/译文。没有语音不影响文字阅读。', '未配置 —— 没有语音合成不影响文字阅读, 需要跟读/听读时再下载。');
      // UX5 #5 (2026-08-13): nlp 段无已登记 nlp 模型时整段隐藏 —— 分词是内置 spaCy
      // 兜底, 不是用户要配置的东西; 有已登记的自定义 NLP 模型才显示 (让用户看到它的状态)。
      if (all.some((m) => m.family === 'nlp')) {
        section('nlp', '分词 / NLP: 分句、词形还原 (lemma)、短语识别, 备料时自动用。未配置时用内置兜底, 不影响阅读。',
          '未配置 —— 用内置兜底分词, 不影响阅读; 需要精确分词时再添加。',
          '当前方案: 内置 spaCy en_core_web_sm (en)。未添加自定义 NLP 模型时就是这个兜底, 无需下载。');
      }

      // 其余已登记模型收进"全部模型"折叠区 (J1: 不再两套并列, 这里是次要的登记清单)
      if (all.length) {
        const sec = el('div', 'model-group');
        const toggle = el('button', 'model-history-toggle', `全部模型 (${all.length}) ▸`);
        toggle.onclick = () => {
          const body = el('div', 'model-all');
          all.forEach((m) => {
            const row = el('div', 'model-row');
            const nameWrap = el('span', 'model-name');
            nameWrap.textContent = this._modelHumanName(m) + (m.custom ? ' (自定义)' : '');
            if (m.active) {
              const badge = el('span', 'book-badge badge-ok', '推荐');
              badge.style.marginLeft = '8px';
              nameWrap.appendChild(badge);
            }
            const size = el('span', 'model-meta', `${Math.round(m.size_bytes / 1e6)} MB · ${m.variant || ''}`);
            const actions = el('div', 'model-actions');
            if (!m.active) {
              const fav = el('button', 'btn-small', '设为推荐');
              fav.onclick = () => AiduModelService.setRecommended(m.id)
                .then((r) => { if (r.ok) { AiduToast.show('已设为推荐', 'success'); this._reload(); } });
              actions.appendChild(fav);
            }
            const del = el('button', 'btn-small btn-danger', '移除');
            del.onclick = () => {
              AiduModal.confirm({
                title: `移除模型 ${m.model_id}?`,
                message: '移除后处理书籍时将不再可用。',
                confirmText: '移除', danger: true,
                onConfirm: () => AiduModelService.remove(m.id).then(() => { this._reload(); AiduToast.show('已移除', 'info'); }),
              });
            };
            actions.appendChild(del);
            // M4-3③: 存量误登记改家族 (whisper/silero 曾被二元判定塞进"语音合成")
            const famBtn = el('button', 'btn-small', '改家族');
            famBtn.title = '误登记到错误的家族时改过来 (如 whisper/silero 曾被当成语音合成)';
            famBtn.onclick = () => this._setFamilyModal(m);
            actions.appendChild(famBtn);
            row.append(nameWrap, size, actions);
            body.appendChild(row);
          });
          toggle.replaceWith(body);
        };
        sec.appendChild(toggle);
        listEl.appendChild(sec);
      }

      if (!all.length) {
        const empty = el('div', 'book-empty', '还没有任何模型。上方按功能提供下载入口。');
        listEl.appendChild(empty);
      }
    }

    /**
     * M4-3 (2026-08-12): 扫描已有模型 —— 弹窗里扫描路径可见可增删 + 候选列表勾选后登记。
     * 修掉的五个问题:
     *   ① 扫描路径不可见、只扫一个目录 → 默认模型目录 + HF 缓存, 可增删
     *   ② 没配 LLM 时 fallback 'C:/' → 没有已知目录就让用户选一个, 绝不扫系统盘
     *   ③ 家族二元瞎猜 → 后端按特征识别 (kokoro/ggml/silero/spacy/gguf), 未识别标黄让用户选
     *   ④ 扫到全自动登记 → 先列候选 (路径/大小/推测家族/是否已登记), 勾选后再登记
     *   ⑤ 0 结果只有一句 toast → 明确列出扫过的路径 + 可点的下一步
     */
    _openScanModal() {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box modal-wide';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', '扫描已有模型');
      const body = el('div', 'book-settings-body');

      const pathList = el('div', 'scan-path-list');
      const statusEl = el('div', 'sync-status', '');
      const resultEl = el('div', 'scan-result');

      const pathsHint = el('div', 'settings-hint',
        '在这些路径下递归找模型文件 (HF 缓存 hub/models--…/snapshots/<sha> 深层布局也覆盖)。');
      const addPathBtn = el('button', 'btn-small', '+ 添加路径');
      addPathBtn.onclick = () => {
        AiduMiscService.libraryDirPick().then((r) => {
          if (r.ok && r.data && !r.data.cancelled && r.data.path) {
            const p = this._normDir(r.data.path);
            if (!this._scanPaths.includes(p)) {
              this._scanPaths.push(p);
              this._renderScanPaths(pathList, resultEl);
            }
          }
        });
      };

      const scanBtn = el('button', 'btn-primary', '扫描');
      scanBtn.onclick = () => this._doScan(pathList, statusEl, resultEl, scanBtn);

      const actions = el('div', 'modal-actions');
      const close = el('button', 'btn-small', '关闭');
      close.onclick = () => ov.remove();
      actions.append(scanBtn, close);

      body.append(pathsHint, pathList, addPathBtn, statusEl, resultEl);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);

      // 初始化扫描路径: 模型目录 + HF 缓存 (M4-3①)。UX5 #5: 与页面顶部"模型目录"
      // 共用 this._modelDirs —— 页面加过目录, 弹窗直接继承, 不重复探测。
      this._scanPaths = (this._modelDirs || []).slice();
      this._scanOv = ov;
      if (this._scanPaths.length) {
        this._renderScanPaths(pathList, resultEl);
      } else {
        AiduMiscService.runtimeConfig().then((cfg) => {
          const d = (cfg && cfg.ok && cfg.data) || {};
          const modelDir = String(d.llm_model || d.tts_model || '').replace(/[\\/][^\\/]+$/, '');
          const modelDirN = this._normDir(modelDir);
          const hfN = this._normDir(d.hf_cache_dir);
          if (modelDirN) this._scanPaths.push(modelDirN);
          if (hfN && !this._scanPaths.includes(hfN)) {
            this._scanPaths.push(hfN);
          }
          if (!this._scanPaths.length) {
            // M4-3②: 没有已知目录 → 让用户选一个, 绝不 fallback 'C:/' 扫系统盘
            statusEl.textContent = '还没有已知的模型目录, 先「+ 添加路径」选一个。';
          }
          this._renderScanPaths(pathList, resultEl);
        });
      }
    }

    _renderScanPaths(pathList, resultEl) {
      pathList.innerHTML = '';
      (this._scanPaths || []).forEach((p, i) => {
        const row = el('div', 'scan-path-row');
        const code = el('code', 'j0-path', p);
        const rm = el('button', 'btn-small scan-path-rm', '×');
        rm.title = '移除这个扫描路径';
        rm.onclick = () => { this._scanPaths.splice(i, 1); this._renderScanPaths(pathList, resultEl); };
        row.append(code, rm);
        pathList.appendChild(row);
      });
      if (!(this._scanPaths || []).length) {
        pathList.appendChild(el('div', 'import-tip', '还没有扫描路径。'));
      }
    }

    async _doScan(pathList, statusEl, resultEl, scanBtn) {
      if (!(this._scanPaths || []).length) {
        statusEl.textContent = '请先添加至少一个扫描路径。';
        return;
      }
      scanBtn.disabled = true;
      // 契约第四条: 正在做什么要说出来 (范围 + 进度)
      statusEl.textContent = '正在扫描 ' + this._scanPaths.length + ' 个目录: ' + this._scanPaths.join(' · ') + ' …';
      resultEl.innerHTML = '';
      const found = [];
      const failed = [];
      for (const p of this._scanPaths) {
        const r = await AiduModelService.scan(p);
        if (r.ok && Array.isArray(r.data)) found.push(...r.data);
        else failed.push(p);
      }
      scanBtn.disabled = false;
      statusEl.textContent = failed.length
        ? '扫描失败: ' + failed.join(' · ') + ' (已跳过)'
        : '扫描完成: ' + found.length + ' 个候选。';
      if (!found.length) {
        // M4-3⑤: 0 结果给可点的下一步, 不只一句 toast
        resultEl.innerHTML = '';
        const msg = el('div', 'book-empty');
        msg.textContent = '在这些路径下没找到模型:\n' + (this._scanPaths || []).map((p) => '· ' + p).join('\n') + '\n你的模型在别处?';
        msg.style.whiteSpace = 'pre-line';
        resultEl.appendChild(msg);
        const btns = el('div', 'prep-empty');
        const pickBtn = el('button', 'btn-small btn-primary', '选择目录扫描…');
        pickBtn.onclick = () => {
          AiduMiscService.libraryDirPick().then((r) => {
            if (r.ok && r.data && !r.data.cancelled && r.data.path) {
              if (!this._scanPaths.includes(r.data.path)) this._scanPaths.push(r.data.path);
              this._renderScanPaths(pathList, resultEl);
              this._doScan(pathList, statusEl, resultEl, scanBtn);
            }
          });
        };
        const customBtn = el('button', 'btn-small', '添加自定义模型');
        customBtn.onclick = () => { if (this._scanOv) this._scanOv.remove(); this._openCustomModelForm(); };
        // UX5 #5 (2026-08-13): 无候选 → 给下载推荐 —— 关掉扫描弹窗, 打开缺失引擎的下载单
        const dlRec = el('button', 'btn-small', '去下载推荐模型');
        dlRec.onclick = () => {
          if (this._scanOv) this._scanOv.remove();
          const target = DOWNLOAD_CATALOG.find((c) => !this._familyUsable(c.family));
          if (target) this._showDownloadSheet(target.family);
        };
        btns.append(pickBtn, customBtn, dlRec);
        resultEl.appendChild(btns);
        return;
      }
      this._renderScanCandidates(resultEl, found, statusEl);
    }

    /** M4-3④: 候选列表 —— 路径/大小/推测家族/是否已登记, 勾选后登记。 */
    _renderScanCandidates(resultEl, found, statusEl) {
      resultEl.innerHTML = '';
      const famLabel = { llm: '翻译/讲解', tts: '语音合成', nlp: '分词/NLP' };
      const head = el('div', 'settings-hint',
        '候选 ' + found.length + ' 个。勾选后点「登记选中」。未识别的先选用途再登记。');
      resultEl.appendChild(head);
      const listEl = el('div', 'scan-candidate-list');
      const checked = new Map(); // path → { c, family }
      let regBtn = null;
      const updateCount = () => {
        if (regBtn) regBtn.textContent = '登记选中的 ' + checked.size + ' 个';
      };
      found.forEach((c) => {
        const row = el('div', 'scan-candidate' + (c.registered ? ' registered' : ''));
        const cb = el('input', 'scan-cb');
        cb.type = 'checkbox';
        cb.disabled = !!c.registered;
        cb.checked = !c.registered;
        const famSel = el('select', 'prep-select scan-fam');
        [['llm', '翻译/讲解'], ['tts', '语音合成'], ['nlp', '分词/NLP']].forEach(([v, l]) => {
          const o = el('option', null, l); o.value = v; famSel.appendChild(o);
        });
        const hint = c.family_hint || 'unknown';
        if (hint === 'llm' || hint === 'tts' || hint === 'nlp') famSel.value = hint;
        // 识别不出 / 识别出但本应用无对应功能 (asr/vad) → 一律「未识别」, 不许自称语音合成
        const known = famLabel[hint];
        const famBadge = el('span', 'book-badge ' + (known ? 'badge-idle' : 'badge-warn'),
          known ? known : '未识别');
        famBadge.title = known ? '' : '识别不出用途 (可能是 whisper/silero 等)。选个用途再登记, 不确定就别勾。';
        const size = el('span', 'model-meta', `${Math.round((c.size_bytes || 0) / 1e6)} MB`);
        const name = el('span', 'scan-fname', c.file_name + (c.registered ? ' (已登记)' : ''));
        const path = el('div', 'scan-cpath', c.path);
        const famCell = el('span', 'scan-fam-cell');
        famCell.append(famBadge);
        if (!c.registered) famCell.appendChild(famSel);
        // UX5 #5 (2026-08-13): 版本/更新判定 —— 候选 vs DOWNLOAD_CATALOG 已知版本
        const verInfo = this._versionStatus(c);
        const verCell = el('span', 'scan-ver-cell');
        verCell.appendChild(el('span', 'book-badge ' + verInfo.cls, verInfo.text));
        row.append(cb, name, size, famCell, verCell);
        row.appendChild(path);
        cb.onchange = () => {
          row.classList.toggle('unchecked', !cb.checked);
          if (cb.checked) checked.set(c.path, { c, family: famSel.value });
          else checked.delete(c.path);
          updateCount();
        };
        famSel.onchange = () => {
          if (checked.has(c.path)) checked.set(c.path, { c, family: famSel.value });
        };
        if (!c.registered) checked.set(c.path, { c, family: famSel.value });
        listEl.appendChild(row);
      });
      resultEl.appendChild(listEl);
      regBtn = el('button', 'btn-primary', '登记选中的 ' + checked.size + ' 个');
      regBtn.onclick = () => {
        if (!checked.size) return;
        regBtn.disabled = true;
        const jobs = [];
        checked.forEach(({ c, family }) => {
          jobs.push(AiduModelService.register({
            family, language: 'en',
            model_id: c.file_name.replace(/\.[^.]+$/, ''),
            version: 'scanned', variant: '', path: c.path,
            source_type: 'local', source_ref: '', sha256: '', size_bytes: c.size_bytes || 0,
            custom: true,
          }));
        });
        Promise.all(jobs).then((rs) => {
          const okN = rs.filter((r) => r && r.ok).length;
          AiduToast.show(`已登记 ${okN} 个模型` + (okN < jobs.length ? ` (${jobs.length - okN} 个失败)` : ''), okN === jobs.length ? 'success' : 'error');
          this._reload();
          if (this._scanOv) this._scanOv.remove();
        }).catch((e) => {
          regBtn.disabled = false;
          AiduToast.show('登记失败: ' + e, 'error');
        });
      };
      resultEl.appendChild(regBtn);
    }

    _reload() {
      // Embedded model center must refresh only its own host, not the whole settings page.
      if (this.host) this.render(this.host);
    }
  }

  global.ModelsView = ModelsView;
})(window);
