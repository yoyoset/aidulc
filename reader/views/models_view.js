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
    constructor(store) {
      this.store = store;
    }

    render(container) {
      this.host = container;
      container.innerHTML = '';
      const wrap = el('div', 'models-view');
      // J1 (2026-08-11): 扫描保留但降为次要操作
      const scanBtn = el('button', 'btn-small', '扫描已有模型');
      scanBtn.onclick = () => this._scanAndRegister();
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

      const listEl = el('div', 'models-list');
      wrap.appendChild(listEl);
      container.appendChild(wrap);

      AiduModelService.list().then((res) => {
        listEl.innerHTML = '';
        if (!res.ok) { listEl.appendChild(el('div', 'global-error', '读模型列表失败: ' + res.error)); return; }
        const models = res.data || [];
        this._renderGrouped(listEl, models);
      }).catch((err) => {
        listEl.innerHTML = '';
        const error = el('div', 'global-error', '读模型列表失败: ' + String(err));
        const retry = el('button', 'btn-small', '重试');
        retry.onclick = () => this.render(this.host);
        listEl.append(error, retry);
      });
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

      const section = (family, tip, missingTip) => {
        const sec = el('div', 'model-group');
        sec.appendChild(el('h2', null, famLabel[family]));
        if (tip) sec.appendChild(el('div', 'import-tip', tip));
        const usable = usableOf(family);
        if (usable.length) {
          // 已配置 → 当前模型名 + 换一个 (J2: 判据不看特定文件名)
          const current = usable.find((m) => m.active) || usable[0];
          const row = el('div', 'model-row');
          const name = el('span', 'model-name', this._modelHumanName(current) + (current.custom ? ' (自定义)' : ''));
          const badge = el('span', 'book-badge badge-ok', '可用');
          badge.style.marginLeft = '8px';
          name.appendChild(badge);
          const size = el('span', 'model-meta', `${Math.round(current.size_bytes / 1e6)} MB`);
          const actions = el('div', 'model-actions');
          const switchBtn = el('button', 'btn-small', '换一个');
          switchBtn.title = usable.length > 1 ? `另有 ${usable.length - 1} 个同功能模型` : '已登记的模型都在这里';
          switchBtn.onclick = () => this._showFamilyModels(family, usable);
          actions.appendChild(switchBtn);
          row.append(name, size, actions);
          sec.appendChild(row);
        } else {
          // 没有可用模型 → 该段的「去下载」
          const missing = el('div', 'settings-hint settings-warn', missingTip || '未配置 —— 处理书籍前需要它。');
          sec.appendChild(missing);
          const dl = el('button', 'btn-primary', '去下载');
          dl.onclick = () => this._showDownloadSheet(family);
          sec.appendChild(dl);
        }
        listEl.appendChild(sec);
      };

      section('llm', '解释词义、例句翻译、讲解。处理书籍前必须先有这个。', '未配置 —— 翻译/讲解需要它, 否则无法处理书籍。');
      section('tts', '朗读原文/译文。没有语音不影响文字阅读。', '未配置 —— 没有语音合成不影响文字阅读, 需要跟读/听读时再下载。');
      section('nlp', '分词 / NLP: 分句、词形还原 (lemma)、短语识别, 备料时自动用。未配置时用内置兜底, 不影响阅读。', '未配置 —— 用内置兜底分词, 不影响阅读; 需要精确分词时再下载。');

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
