/**
 * views/library/edition_profile_modal.js —— "为原书创建译本"配置模态 (阶段4 BOOK_WORKFLOW)
 *
 * 治理 (2026-08-31): 从 library_view.js 拆出 (原 `_chooseEditionProfile`, 160 行)。
 *
 * 流程: source → 配置面板(档案/语言/模型) → 开始备料 → edition。
 * 面板必须配置完成才允许开始; preflight 失败**留在面板**显示原因和下一步, 不关窗
 * ——"后台失败但用户以为成功"是要优先排除的最差情况。
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
   * @param {object} book 原书
   * @param {object} deps {
   *   profiles: Array,                       // 学习档案列表 (与书设置弹窗同一数据源)
   *   storedProfile(): string,               // 上次选的档案 (预填)
   *   saveProfile(id): void,                 // 记住本次选择
   *   startPrep(book, profileId, cbs): Promise, // 真正发起备料 (含 preflight)
   *   onStarted(): void,                     // 已入队, 通知视图刷新
   * }
   */
  function showEditionProfileModal(book, deps) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = el('div', 'modal-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('h2', 'modal-title', `为《${book.title || book.id}》创建译本`);
    // 阶段2 (BOOK_WORKFLOW): 说清原书 vs 译本边界 —— 原书只是来源, 译本才是可读成品。
    const hint = el('div', 'settings-hint',
      '译本是从这本原书生成的可阅读版本。配置好档案、语言和模型后, 系统会生成译文、讲解和音频。' +
      '同一本原书可以用不同参数生成多个译本; 相同参数重新生成会覆盖原译本。');
    const body = el('div', 'book-settings-body');

    // 档案
    body.appendChild(el('div', 'settings-hint', '学习档案'));
    const profileSelect = el('select', 'prep-select');
    (deps.profiles || [{ id: 'default', name: '成人自读' }]).forEach((p) => {
      const opt = el('option', null, p.name || p.id);
      opt.value = p.id;
      profileSelect.appendChild(opt);
    });
    // 默认与预填 (UX 审计 2026-08-09): 回填上次选的档案, 能自动填的不让用户重选
    const lastProfile = deps.storedProfile && deps.storedProfile();
    if (lastProfile && (deps.profiles || []).some((p) => p.id === lastProfile)) {
      profileSelect.value = lastProfile;
    }
    body.appendChild(profileSelect);

    // 语言 (source → target)
    body.appendChild(el('div', 'settings-hint', '语言'));
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
    body.appendChild(langRow);

    // 模型 (阶段4: 不配置就用全局推荐; 统一从后端 models_list 取状态)
    body.appendChild(el('div', 'settings-hint', '模型 (不选就跟随模型中心的全局推荐)'));
    const modelRow = el('div', 'prep-row');
    const llmSel = el('select', 'prep-select');
    const ttsSel = el('select', 'prep-select');
    modelRow.append(llmSel, ttsSel);
    body.appendChild(modelRow);

    // preflight 结果区 (失败显示原因 + 下一步, 不关面板)
    const result = el('div', 'prep-preflight-result');
    result.style.display = 'none';

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn-small', '取消');
    const start = el('button', 'btn-small btn-primary', '开始备料');
    actions.append(cancel, start);
    box.append(title, hint, body, result, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);

    function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    cancel.onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);

    // 载入档案/模型状态 (阶段4: 四个状态已扫描/已登记/可用/已绑定由后端返回, 前端只渲染)
    body.appendChild(el('div', 'settings-loading', '加载中…'));
    Promise.all([AiduModelService.list(), AiduModelService.bookBinding(book.id)])
      .then(([listRes, bindRes]) => {
        const loading = body.querySelector('.settings-loading');
        if (loading) loading.remove();
        const models = (listRes.ok && Array.isArray(listRes.data)) ? listRes.data : [];
        const bind = (bindRes.ok && bindRes.data) || {};
        srcSel.value = bind.source_language || 'en';

        const llmOpt = el('option', null, '跟随全局推荐'); llmOpt.value = '';
        llmSel.appendChild(llmOpt);
        models.filter((m) => m.family === 'llm').forEach((m) => {
          const opt = el('option', null, m.model_id); opt.value = m.id;
          opt.title = '已登记' + (m.recommended ? ' · 全局推荐' : '');
          llmSel.appendChild(opt);
        });
        const ttsOpt = el('option', null, '跟随全局推荐'); ttsOpt.value = '';
        ttsSel.appendChild(ttsOpt);
        models.filter((m) => m.family === 'tts').forEach((m) => {
          const opt = el('option', null, m.model_id); opt.value = m.id;
          opt.title = '已登记' + (m.recommended ? ' · 全局推荐' : '');
          ttsSel.appendChild(opt);
        });
        if (bind.llm_id) llmSel.value = bind.llm_id;
        if (bind.tts_id) ttsSel.value = bind.tts_id;
        if (models.filter((m) => m.family === 'llm').length === 0 ||
            models.filter((m) => m.family === 'tts').length === 0) {
          body.appendChild(el('div', 'settings-hint settings-warn',
            '模型中心还没有完整的模型组合。请先到模型中心配置翻译引擎和语音引擎, 再回来创建译本。'));
        }
        // 档案/语言/模型三节控件在初始阶段已按标题顺序挂好 (UX 审计 2026-08-09),
        // 异步回调只负责往模型下拉里填选项与告警, 不再重复 append 控件。
      }).catch((e) => {
        const loading = body.querySelector('.settings-loading');
        if (loading) loading.remove();
        body.appendChild(el('div', 'global-error', '加载配置失败: ' + e));
      });

    // 阶段4: 配置完成前不创建 edition; preflight 失败留在面板显示原因和下一步
    start.onclick = () => {
      start.disabled = true;
      start.textContent = '正在检查…';
      result.style.display = 'none';
      // 先持久化书级模型绑定 (不同模型 = 不同 edition 的参数快照来源)
      AiduModelService.bindBook(
        book.id, srcSel.value, tgtSel.value, llmSel.value || null, ttsSel.value || null, null
      ).then((bindRes) => {
        if (!bindRes.ok) {
          start.disabled = false; start.textContent = '开始备料';
          result.style.display = '';
          result.className = 'prep-preflight-result prep-failure';
          result.textContent = '保存模型配置失败: ' + bindRes.error + '。请重试。';
          return;
        }
        const profileId = profileSelect.value;
        // 默认与预填 (UX 审计 2026-08-09): 记住本次选的档案, 下次自动预选
        if (deps.saveProfile) deps.saveProfile(profileId);
        return deps.startPrep(book, profileId, {
          onSkipped: (reasons) => {
            // preflight 未通过: 留在面板, 显示原因 + 下一步
            start.disabled = false;
            start.textContent = '开始备料';
            result.style.display = '';
            result.className = 'prep-preflight-result prep-failure';
            result.textContent = '暂时无法开始: ' + reasons.join('; ');
            const goModels = el('button', 'btn-small btn-primary', '去模型中心');
            // K17 (2026-08-14): 报错里带具体是哪个引擎缺失时, 直接跳转+弹出对应家族的
            // 下载单, 不用用户自己在模型中心里找。
            const joined = reasons.join('; ');
            const family = /翻译引擎|LLM/.test(joined) ? 'llm' : (/语音引擎|语音模型|TTS/.test(joined) ? 'tts' : '');
            goModels.onclick = () => { close(); window.location.hash = '#/models' + (family ? '?focus=' + family : ''); };
            result.appendChild(goModels);
          },
          onStarted: () => {
            close();
            AiduToast.show('已加入处理队列, 完成后自动生成译本', 'success');
            if (deps.onStarted) deps.onStarted();
          },
        });
      }).catch((e) => {
        start.disabled = false; start.textContent = '开始备料';
        result.style.display = '';
        result.className = 'prep-preflight-result prep-failure';
        result.textContent = '开始失败: ' + e;
      });
    };
    cancel.focus();
  }

  global.AiduEditionProfileModal = { showEditionProfileModal };
})(window);
