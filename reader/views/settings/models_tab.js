/**
 * views/settings/models_tab.js —— 设置页「模型与依赖」tab 里的"依赖组件"小节
 * 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 从 settings_view.js 拆出。
 * 模型列表本身由已有的 ModelsView 类渲染(settings_view.js 里 new ModelsView().render()),
 * 这里只是同一个 pane 下追加的"依赖组件"(prep/ffmpeg/PyMuPDF/CUDA)健康检查小节。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 推荐模型一改, 依赖组件那几行要跟着刷新 (不能继续显示旧的"兜底用 Sakura")。
  let activeCompSec = null;
  if (global.window && typeof global.window.addEventListener === 'function') {
    global.window.addEventListener('aidulc:models-changed', () => {
      if (activeCompSec && activeCompSec.pane) activeCompSec.render(activeCompSec.pane);
    });
  }

  class SettingsModelsCompSec {
    /** @param {HTMLElement} pane 挂载点(「模型与依赖」tab 的 pane, 追加在 ModelsView 之后) */
    render(pane) {
            this.pane = pane;
            activeCompSec = this;
            if (this.compSec && this.compSec.parentNode) this.compSec.parentNode.removeChild(this.compSec);
            // J3 (2026-08-11): 依赖并入「模型与依赖」tab —— 组件健康检查 (prep/ffmpeg/PyMuPDF/
            // CUDA) 与模型同页呈现, 不再藏在"系统与书库"里。
            const compSec = el('div', 'settings-section');
            this.compSec = compSec;
            compSec.appendChild(el('h2', null, '依赖组件'));
            const compList = el('div', 'component-list');
            compSec.appendChild(compList);
            pane.appendChild(compSec);
            // S0 (2026-08-10): 探测侧车可能耗时 (异步命令 + 5 秒超时), 先出"检测中…",
            // 结果到了再填充 —— 不阻塞设置页渲染; 失败也显示原因 (后台失败必须可见)。
            compList.appendChild(el('div', 'component-row', '检测中…'));
            // 2026-11-10: 同时取模型列表, 把"健康检查通过"翻译成"实际选中的是哪个模型"。
            // 只看 OK (4250.3 MB) 用户不知道那是 Sakura, 也看不出没设推荐。
            const modelsP = (global.AiduModelService && global.AiduModelService.list)
              ? global.AiduModelService.list().catch(() => ({ ok: false, data: [] }))
              : Promise.resolve({ ok: false, data: [] });
            Promise.all([AiduMiscService.componentsHealth(), modelsP]).then(([res, mres]) => {
              compList.innerHTML = '';
              if (!res.ok) { compList.appendChild(el('div', 'global-error', '检查失败: ' + res.error)); return; }
              const models = (mres && mres.ok && Array.isArray(mres.data)) ? mres.data : [];
              const activeOf = (family) => models.find((m) => m.family === family && m.active);
              const fallbackOf = (family) => models.find((m) => m.family === family);
              const labelOf = (m) => (global.AiduModelActiveCard
                ? global.AiduModelActiveCard.labelFor(m)
                : ((m && (m.model_id || m.id)) || ''));
              (res.data || []).forEach(c => {
                // J3 (2026-08-11): 当前版本 · 状态 · 操作 (有版本显示, 无则省略)
                const ver = c.version ? ' · 当前 ' + c.version : '';
                const row = el('div', 'component-row',
                  `${c.name}: ${c.healthy ? '✓ ' : '✗ '}${c.detail}${ver}`);
                row.className += c.healthy ? ' component-ok' : ' component-bad';
                // J3: 更新渠道 —— 有渠道的给"检查更新/安装"入口, 无渠道的老实显示文字 (不放假按钮)
                if (c.healthy) {
                  const ch = el('span', 'component-channel', '[' + (c.update_channel || '无更新渠道') + ']');
                  ch.style.marginLeft = '8px';
                  ch.style.opacity = '.7';
                  ch.style.fontSize = '0.78rem';
                  row.appendChild(ch);
                  // M4-2 (2026-08-12): 本地文件类模型标"无更新渠道"时, 补一句可操作的下一步 ——
                  // 光知道"没渠道"用户不知道下一步干什么。
                  if ((c.update_channel || '无更新渠道') === '无更新渠道' && ['llm', 'tts', 'spacy'].includes(c.id)) {
                    const how = el('span', 'component-how', '要换新版: 下载后用「添加自定义模型」指向新文件, 再设为推荐。');
                    how.style.marginLeft = '8px';
                    how.style.opacity = '.7';
                    how.style.fontSize = '0.78rem';
                    row.appendChild(how);
                  }
                }
                // 2026-11-10: LLM/TTS 行补上"当前实际用哪个模型" —— 否则
                // "LLM 模型 ✓ OK (4250.3 MB)" 用户根本不知道那是 Sakura, 也看不出没设推荐。
                if (c.id === 'llm' || c.id === 'tts') {
                  const active = activeOf(c.id);
                  const fallback = fallbackOf(c.id);
                  const actual = active || fallback;
                  if (actual) {
                    const who = el('span', 'component-model',
                      (active ? ' 当前推荐：' : ' 未设推荐，兜底用：') + labelOf(actual));
                    who.style.marginLeft = '8px';
                    row.appendChild(who);
                    const warn = (global.AiduModelActiveCard && global.AiduModelActiveCard.whyBad)
                      ? global.AiduModelActiveCard.whyBad(c.id, actual) : '';
                    if (warn) row.appendChild(el('div', 'settings-warn', warn));
                    if (!active) {
                      const go = el('button', 'btn-small', '去设推荐');
                      go.style.marginLeft = '8px';
                      go.onclick = () => {
                        const card = document.querySelector && document.querySelector('.model-active-card');
                        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      };
                      row.appendChild(go);
                    }
                  } else {
                    row.appendChild(el('span', 'settings-warn', ' 未登记模型'));
                  }
                }
                // R3.4/J3: 文档解析器缺失 → 一键安装按钮 (这是真实渠道)
                if (c.id === 'pymupdf' && !c.healthy) {
                  const btn = el('button', 'btn-small', '一键安装');
                  btn.style.marginLeft = '8px';
                  btn.onclick = () => {
                    btn.disabled = true;
                    btn.textContent = '安装中…';
                    AiduMiscService.docParserInstall().then((r) => {
                      const installed = r.ok && r.data && r.data.ok;
                      btn.textContent = installed ? '✓ 已安装' : '安装失败';
                      if (!installed) row.title = (r.data && r.data.detail) || r.error || '';
                    });
                  };
                  row.appendChild(btn);
                }
                compList.appendChild(row);
              });
            });
    }
  }

  global.SettingsModelsCompSec = SettingsModelsCompSec;
})(window);
