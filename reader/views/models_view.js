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

  class ModelsView {
    constructor(store) {
      this.store = store;
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'models-view');
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '模型中心'));
      const scanBtn = el('button', 'btn-primary', '扫描已有模型');
      scanBtn.onclick = () => this._scanAndRegister();
      header.appendChild(scanBtn);
      wrap.appendChild(header);

      const listEl = el('div', 'models-list');
      wrap.appendChild(listEl);
      container.appendChild(wrap);

      AiduModelService.list().then((res) => {
        listEl.innerHTML = '';
        if (!res.ok) { listEl.appendChild(el('div', 'global-error', '读模型列表失败: ' + res.error)); return; }
        this._renderGrouped(listEl, res.data || []);
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
      // 重新渲染当前容器
      this.render(document.querySelector('.app-view'));
    }
  }

  global.ModelsView = ModelsView;
})(window);
