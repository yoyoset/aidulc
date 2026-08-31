/**
 * views/library/book_settings_modal.js —— 书设置弹窗 (P3 + L10)
 *
 * 治理 (2026-08-31): 从 library_view.js 拆出 (原 `_openBookSettings`, 129 行)。
 *
 * 内容: 学习档案 + 语言 + 模型覆盖 (默认跟随全局推荐)。
 * L10 (2026-08-11): 档案选择与创建译本弹窗同一份数据源, 表单按「档案 → 语言 → 模型」
 * 竖排。明确说明这个弹窗改的是**这本书下次生成时**的默认参数, 不影响已生成的译本。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * @param {object} book
   * @param {object} deps {
   *   profiles: Array,
   *   storedProfile(): string,
   *   onSaved(): void,   // 保存成功后通知视图刷新
   * }
   */
  function showBookSettingsModal(book, deps) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('h2', 'modal-title', `书设置 — ${book.title || book.id}`);
    const body = el('div', 'book-settings-body');
    // L10: 一句话点明边界 —— 改的是下次生成的默认参数, 不动已生成译本。
    body.appendChild(el('div', 'settings-hint settings-warn',
      '这里改的是这本书「下次生成译本」时的默认参数。已生成的译本不受影响。'));

    // 学习档案 (与创建译本弹窗同数据源)
    const profileLabel = el('div', 'settings-hint', '学习档案');
    const profileSelect = el('select', 'prep-select');
    (deps.profiles || [{ id: 'default', name: '成人自读' }]).forEach((p) => {
      const opt = el('option', null, p.name || p.id);
      opt.value = p.id;
      profileSelect.appendChild(opt);
    });
    profileSelect.value = book.profile_id || (deps.storedProfile && deps.storedProfile()) || 'default';

    const langLabel = el('div', 'settings-hint', '语言');
    const langRow = el('div', 'prep-row');
    const srcSel = el('select', 'prep-select');
    [['en', '英文'], ['ja', '日文 (即将支持)']].forEach(([c, l]) => {
      const opt = el('option', null, l); opt.value = c;
      if (c !== 'en') opt.disabled = true;
      srcSel.appendChild(opt);
    });
    const tgtSel = el('select', 'prep-select');
    [['zh-CN', '中文']].forEach(([c, l]) => {
      const opt = el('option', null, l); opt.value = c;
      tgtSel.appendChild(opt);
    });
    langRow.append(srcSel, tgtSel);

    const modelHint = el('div', 'settings-hint', '模型 (不配置就用模型中心的全局推荐)');
    const llmRow = el('div', 'prep-row');
    const llmSel = el('select', 'prep-select');
    const ttsSel = el('select', 'prep-select');

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'btn-small', '取消');
    const saveBtn = el('button', 'btn-small btn-primary', '保存');
    actions.append(cancelBtn, saveBtn);

    function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    body.append(profileLabel, profileSelect, langLabel, langRow, modelHint, llmRow);
    box.append(title, body, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);

    // 加载: 当前绑定 + 可用模型 (四态: loading/error/success)
    body.prepend(el('div', 'settings-loading', '加载中…'));
    Promise.all([
      AiduModelService.bookBinding(book.id),
      AiduModelService.list(),
    ]).then(([bindRes, listRes]) => {
      body.querySelector('.settings-loading').remove();
      if (!bindRes.ok || !listRes.ok) {
        // F18 (2026-08-08): 原实现 `appendChild(el(...).textContent && null)` 恒为 null,
        // 必然抛 TypeError 落入 catch, 错误详情与重试入口都丢失。直接挂错误块。
        body.appendChild(el('div', 'global-error',
          '加载失败: ' + ((bindRes.error) || (listRes.error) || '未知错误')));
        const retry = el('button', 'btn-small', '重试');
        retry.onclick = () => { ov.remove(); showBookSettingsModal(book, deps); };
        body.appendChild(retry);
        return;
      }
      const bind = bindRes.data || {};
      const models = listRes.data || [];
      srcSel.value = bind.source_language || 'en';

      const llmOpt = el('option', null, '跟随全局推荐'); llmOpt.value = '';
      llmSel.appendChild(llmOpt);
      models.filter((m) => m.family === 'llm').forEach((m) => {
        const opt = el('option', null, m.model_id); opt.value = m.id;
        llmSel.appendChild(opt);
      });
      const ttsOpt = el('option', null, '跟随全局推荐'); ttsOpt.value = '';
      ttsSel.appendChild(ttsOpt);
      models.filter((m) => m.family === 'tts').forEach((m) => {
        const opt = el('option', null, m.model_id); opt.value = m.id;
        ttsSel.appendChild(opt);
      });
      if (bind.llm_id) llmSel.value = bind.llm_id;
      if (bind.tts_id) ttsSel.value = bind.tts_id;
      if (models.filter((m) => m.family === 'llm').length === 0 ||
          models.filter((m) => m.family === 'tts').length === 0) {
        body.appendChild(el('div', 'settings-hint settings-warn',
          '模型中心还没有完整的模型组合。请先到模型中心配置翻译引擎和语音引擎。'));
      }
      llmRow.append(llmSel, ttsSel);
    }).catch((e) => {
      const loading = body.querySelector('.settings-loading');
      if (loading) loading.remove();
      body.appendChild(el('div', 'global-error', '加载失败: ' + e));
    });

    cancelBtn.onclick = close;
    saveBtn.onclick = () => {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      // L10: 档案持久化 (影响下次生成) + 模型绑定, 两步都成功才算保存
      const profileId = profileSelect.value;
      const profileSave = AiduLibraryService.setBookProfile(book.id, profileId);
      const modelSave = AiduModelService.bindBook(
        book.id, srcSel.value, tgtSel.value,
        llmSel.value || null, ttsSel.value || null, null
      );
      Promise.all([profileSave, modelSave]).then(([pr, mr]) => {
        if (!pr.ok) {
          saveBtn.disabled = false; saveBtn.textContent = '保存';
          body.appendChild(el('div', 'global-error', '保存档案失败: ' + pr.error));
          return;
        }
        if (!mr.ok) {
          saveBtn.disabled = false; saveBtn.textContent = '保存';
          body.appendChild(el('div', 'global-error', '保存模型配置失败: ' + mr.error));
          return;
        }
        close();
        AiduToast.show('已保存《' + (book.title || '') + '》的设置', 'success');
        if (deps.onSaved) deps.onSaved();
      });
    };
    cancelBtn.focus();
  }

  global.AiduBookSettingsModal = { showBookSettingsModal };
})(window);
