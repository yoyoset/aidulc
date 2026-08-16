/**
 * views/settings/profiles_tab.js —— 设置页「学习档案」tab (M6)
 * 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 settings_view.js 拆出。
 * VOICES/PALETTES 仍是 SettingsView 的静态成员(见该文件), 这里在调用时按运行时全局引用
 * (脚本加载顺序不影响, 因为只在 render 实际执行时才读取, 不在模块解析期读取)。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsProfilesTab {
    /** @param {HTMLElement} pane 挂载点(「学习档案」tab 的 pane) */
    render(pane) {
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
             pane.appendChild(profSec);
            this._renderProfiles(profList);
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
          // K33 (2026-08-16): 讲解策略不是"不讲"时才有意义展示字数上限
          const maxCharsPart = p.explain_strategy !== 'none'
            ? ` · ≤${p.explain_max_chars != null ? p.explain_max_chars : 150}字`
            : '';
          const meta = el('div', 'profile-meta', `${strategy}${maxCharsPart} · ${voiceName} · ${p.speed}x · ${gran}`);
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

      // K33 (2026-08-16, 用户拍板"讲解深度分档不够, 要能调字数和触发门槛"): 讲解字数上限——
      // 替代之前硬编码在提示词里的"讲得啰嗦一点没关系"(实测 Wonder 一书讲解中位数 512 字符,
      // 是原文的 10.7 倍, 且大部分内容跑题、拖慢生成速度, 见 docs/GOAL_2026-08-16_PERF.md)。
      const maxCharsRow = el('label', 'settings-row', '讲解字数上限');
      const maxCharsSel = el('select', null);
      [[50, '50 字(极简)'], [100, '100 字'], [150, '150 字(默认)'], [200, '200 字'], [300, '300 字(详细)']].forEach(([v, l]) => {
        const opt = el('option', null, l);
        opt.value = String(v);
        if ((p.explain_max_chars != null ? p.explain_max_chars : 150) === v) opt.selected = true;
        maxCharsSel.appendChild(opt);
      });
      maxCharsRow.appendChild(maxCharsSel);

      // K33: 讲解触发门槛——原文长度低于这个字符数的句子不生成讲解, 直接跳过
      // (比如 "Crack!"/"Click." 这类拟声词/极短句, 查词就够, 不需要一段讲解)。
      const minCharsRow = el('label', 'settings-row', '讲解触发门槛');
      const minCharsSel = el('select', null);
      [[0, '全部句子都讲'], [30, '原文 ≥30 字才讲'], [50, '原文 ≥50 字才讲'], [80, '原文 ≥80 字才讲']].forEach(([v, l]) => {
        const opt = el('option', null, l);
        opt.value = String(v);
        if ((p.explain_min_sentence_chars != null ? p.explain_min_sentence_chars : 0) === v) opt.selected = true;
        minCharsSel.appendChild(opt);
      });
      minCharsRow.appendChild(minCharsSel);

      const voiceHint = el('div', 'import-tip', '音色可选列表取决于已装语音模型; 处理时若报错会提示具体原因。');
      form.append(nameRow, strategyRow, voiceRow, speedRow, granRow, maxCharsRow, minCharsRow, voiceHint);

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
          explain_max_chars: parseInt(maxCharsSel.value, 10),
          explain_min_sentence_chars: parseInt(minCharsSel.value, 10),
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

  global.SettingsProfilesTab = SettingsProfilesTab;
})(window);
