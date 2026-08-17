/**
 * views/prep/retry_dialog.js —— 「重新处理…」对话框
 *
 * 治理 (2026-08-17, 照 views/settings/*_tab.js 的先例): 从 prep_view.js 拆出。
 * prep_view 本身是"任务列表 + 进度"这一个域, 这个对话框(4 个下拉 + 重跑范围单选
 * + 联动推导)是独立一域, 塞在一起让 prep_view.js 越过了 file-size 基线。
 * 拆出来之后 prep_view 只留一行委托, 现有调用点和 smoke 测试都不用改。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

    /** 手动重跑 (2026-08-13): 「重跑…」对话框 — 重新选模型 (3 下拉) + 重跑范围 (单选)。
     * 点「开始重跑」→ AiduJobService.retryCustom(id, llmId, ttsId, nlpId, forceStages, profileId)。
     * 模型下拉: 默认「保持当前」(书级绑定/推荐解析), 选项 = 已登记模型 (AiduModelService.list)。
     * 重跑范围: 自动(只跑失败/未完成) / 从翻译 / 从讲解 / 从语音 / 全部, 语义与
     * prep checkpoint.clear_stages 的 FORCE_STAGE_CASCADE 对齐 (翻译级联讲解, 语音级联对齐)。
     */
function showRetryDialog(view, job) {
      const famLabels = { llm: '翻译引擎', tts: '语音引擎', nlp: '分词' };
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', `重新处理 — ${job.book_path.split(/[\\/]/).pop()}`);
      const body = el('div', 'book-settings-body');
      let scopeTouched = false; // 用户是否手动动过"重跑范围"(动过就不再被下拉联动覆盖)

      body.appendChild(el('div', 'preview-meta', '先改设置 (模型/学习档案, 保持当前 = 沿用原来的), 重跑范围会自动调到够用的最小范围, 也可以自己改。'));
      // 模型下拉 (默认保持当前 = 空串)
      const mkSelect = (fam) => {
        const wrap = el('div', 'retry-field');
        wrap.appendChild(el('label', null, famLabels[fam] || fam));
        const sel = document.createElement('select');
        sel.className = 'retry-select';
        const keep = document.createElement('option');
        keep.value = '';
        keep.textContent = '保持当前 (书级绑定/推荐)';
        sel.appendChild(keep);
        (global.AiduModelService.list ? (global.AiduModelService.list() || Promise.resolve({ ok: true, data: [] })) : Promise.resolve({ ok: true, data: [] }))
          .then((res) => {
            const models = (res.ok && res.data) || [];
            models.filter((m) => m.family === fam).forEach((m) => {
              const opt = document.createElement('option');
              opt.value = m.id;
              opt.textContent = (m.model_id || m.id) + (m.active ? ' (推荐)' : '');
              sel.appendChild(opt);
            });
          })
          .catch(() => {});
        wrap.appendChild(sel);
        return { wrap, sel };
      };
      const llm = mkSelect('llm');
      const tts = mkSelect('tts');
      const nlp = mkSelect('nlp');
      body.append(llm.wrap, tts.wrap, nlp.wrap);

      // STDIMPORT (2026-08-17): 学习档案也能重选 —— 用户的真实诉求是"就地改讲解设置
      // 再重跑, 只重跑讲解", 之前这个对话框只能换模型, 改档案得回书库重新创建译本
      // (等于重跑整本)。换档案不改 book_id (Rust 侧 job_retry_custom 的注释说明了原因)。
      const profWrap = el('div', 'retry-field');
      profWrap.appendChild(el('label', null, '学习档案'));
      const profSel = document.createElement('select');
      profSel.className = 'retry-select';
      const keepProf = document.createElement('option');
      keepProf.value = '';
      keepProf.textContent = '保持当前';
      profSel.appendChild(keepProf);
      profWrap.appendChild(profSel);
      body.appendChild(profWrap);
      let profiles = [];
      AiduBridge.profiles.list().then((res) => {
        profiles = (res.ok && res.data) || [];
        profiles.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name + (p.id === job.profile_id ? ' (当前)' : '');
          profSel.appendChild(opt);
        });
      }).catch(() => {});

      // 重跑范围 (单选) — force_stages 语义与 FORCE_STAGE_CASCADE 对齐
      const scopeWrap = el('div', 'retry-field');
      scopeWrap.appendChild(el('label', null, '重跑范围'));
      const scopes = [
        { v: '', t: '自动', d: '只补失败/未完成的句子 (最省时间)' },
        { v: 'translate', t: '从翻译', d: '重跑翻译+讲解' },
        { v: 'explain', t: '从讲解', d: '重跑讲解' },
        { v: 'tts', t: '从语音', d: '重跑语音+对齐' },
        { v: 'all', t: '全部', d: '重跑翻译+讲解+语音+对齐' },
      ];
      const radios = scopes.map((s) => {
        const row = el('label', 'retry-scope-row');
        const r = document.createElement('input');
        r.type = 'radio';
        r.name = 'retry-scope';
        r.value = s.v;
        r.checked = s.v === '';
        r.addEventListener('change', () => {
          radios.forEach((x) => { x.checked = (x === r); });
          scopeTouched = true; // 用户自己选过之后, 不再被下拉联动覆盖
        });
        row.appendChild(r);
        row.appendChild(el('span', null, s.t + ' — ' + s.d));
        scopeWrap.appendChild(row);
        return r;
      });
      body.appendChild(scopeWrap);

      // 下拉变化 → 自动把重跑范围调到"够用的最小范围"(AiduRerunScope 纯逻辑,
      // 配对测试在 reader/tests/rerun_scope.test.js)。用户手动选过就不再覆盖。
      const syncScope = () => {
        if (scopeTouched) return;
        const scopeApi = global.AiduRerunScope || globalThis.AiduRerunScope;
        const v = scopeApi.suggest({
          oldProfile: profiles.find((p) => p.id === job.profile_id) || null,
          newProfile: profSel.value ? profiles.find((p) => p.id === profSel.value) || null : null,
          llmChanged: !!llm.sel.value,
          ttsChanged: !!tts.sel.value,
          nlpChanged: !!nlp.sel.value,
        });
        radios.forEach((r) => { r.checked = (r.value === v); });
      };
      [llm.sel, tts.sel, nlp.sel, profSel].forEach((s) => s.addEventListener('change', syncScope));

      const actions = el('div', 'modal-actions');
      const startBtn = el('button', 'btn-small btn-primary', '开始重跑');
      startBtn.onclick = () => {
        const sel = radios.find((r) => r.checked);
        // 重跑范围 → force_stages (与 checkpoint FORCE_STAGE_CASCADE 语义一致:
        // 翻译级联讲解, 语音级联对齐; 空 = 自动只跑失败/未完成)
        const FORCE_MAP = {
          translate: ['translate'],
          explain: ['explain'],
          tts: ['tts'],
          all: ['translate', 'explain', 'tts', 'align'],
        };
        const forceStages = (sel && FORCE_MAP[sel.value]) || null;
        startBtn.disabled = true;
        startBtn.textContent = '重排中…';
        AiduJobService.retryCustom(
          job.id,
          llm.sel.value || null,
          tts.sel.value || null,
          nlp.sel.value || null,
          forceStages,
          profSel.value || null,
        ).then((r) => {
          if (!r.ok) { startBtn.disabled = false; startBtn.textContent = '开始重跑'; AiduToast.show('重跑失败: ' + r.error, 'error'); return; }
          ov.remove();
          AiduToast.show('已重新排队', 'success');
          view._refreshJobs();
        });
      };
      const close = el('button', 'btn-small', '关闭');
      close.onclick = () => ov.remove();
      actions.append(startBtn, close);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

  global.AiduPrepRetryDialog = { show: showRetryDialog };
})(typeof window !== 'undefined' ? window : globalThis);
