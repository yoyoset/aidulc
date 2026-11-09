/**
 * views/settings/model_active_card.js —— 当前全局推荐模型摘要 (2026-11-10)
 *
 * 背景: 模型页只有每个功能段里的「换一个 / 去下载」, 没有一处直接回答
 * 「处理这本书时到底会用哪个模型」。用户扫描登记 4 个 LLM 后一个都没设推荐,
 * 系统按"最近登记"兜底选中了 Sakura (日文/中文模型), 依赖组件却只显示
 * "LLM 模型 OK (4250 MB)" —— 看起来一切正常, 实际选错了模型。
 *
 * 这个卡片把三行真实生效的引擎摆到最上面, 并在没有推荐时明确写出"兜底会用谁、
 * 为什么可能不合适", 再给一个一键设置推荐组合的按钮。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtSize(m) {
    const n = Number(m && m.size_bytes) || 0;
    return n > 0 ? `${Math.round(n / 1e6)} MB` : '';
  }

  /** 人话模型名: 不把内部 id 直接甩给用户, 尤其要把日文/中文/英文版说清楚。 */
  function labelFor(m) {
    if (!m) return '未登记';
    const id = String(m.model_id || m.id || '');
    if (m.family === 'llm') {
      if (/sakura/i.test(id)) return 'Sakura（日文/中文翻译模型）';
      if (/Qwen3-4B-Instruct-2507/i.test(id)) return 'Qwen3-4B-Instruct-2507（英文推荐）';
      if (/Qwen3-14B/i.test(id)) return 'Qwen3-14B（英文，质量更高/更慢）';
      if (/Qwen3/i.test(id)) return id + '（英文）';
      return id;
    }
    if (m.family === 'tts') {
      if (/v1[_.-]?1[-_.]?zh/i.test(id)) return 'Kokoro v1.1-zh（中文语音）';
      if (/kokoro-v1_0/i.test(id)) return 'Kokoro v1.0（英文语音）';
      return id;
    }
    if (m.family === 'nlp') return 'spaCy / NLP';
    return id;
  }

  /** 明确写出这个模型为什么可能不适合当前用途。 */
  function whyBad(family, m) {
    if (!m) return '';
    const id = String(m.model_id || '');
    if (family === 'llm' && /sakura/i.test(id)) {
      return '⚠ 这是日文/中文翻译模型，英文书建议改选 Qwen3-4B-Instruct-2507。';
    }
    if (family === 'tts' && /v1[_.-]?1[-_.]?zh/i.test(id)) {
      return '⚠ 这是中文语音模型；英文书建议用 Kokoro v1.0。';
    }
    if (family === 'tts' && m.complete === false) {
      return '⚠ 缺 config.json 或 voices/，处理到语音阶段会失败。';
    }
    return '';
  }

  /** 从候选里选一个最适合本项目的模型; 没有候选返回 null。 */
  function pickRecommended(models, family) {
    const list = (models || []).filter((m) => m && m.family === family && m.path);
    if (!list.length) return null;
    if (family === 'llm') {
      return list.find((m) => /Qwen3-4B-Instruct-2507/i.test(String(m.model_id || '')))
        || list.find((m) => /Qwen3-4B/i.test(String(m.model_id || '')))
        || list.find((m) => /Qwen3/i.test(String(m.model_id || '')) && !/sakura/i.test(String(m.model_id || '')))
        || list[0];
    }
    if (family === 'tts') {
      const complete = list.filter((m) => m.complete !== false);
      return complete.find((m) => /kokoro-v1_0/i.test(String(m.model_id || ''))
          && /models--hexgrad--Kokoro-82M/i.test(String(m.path || '')))
        || complete.find((m) => /kokoro-v1_0/i.test(String(m.model_id || '')))
        || complete[0]
        || list[0];
    }
    return list[0];
  }

  function render(host, models, opts) {
    if (!host) return;
    host.innerHTML = '';
    const list = Array.isArray(models) ? models : [];
    const options = opts || {};
    const card = el('div', 'model-active-card');
    card.appendChild(el('h2', null, '当前全局推荐（处理书籍时实际使用）'));
    card.appendChild(el('div', 'import-tip',
      '学习档案只决定讲解深度/音色/语速/高亮粒度，不决定模型。下面三行才是真正会用到的引擎。'));

    const rows = el('div', 'model-active-rows');
    let needsFix = false;
    const addRow = (family, label) => {
      const active = list.find((m) => m.family === family && m.active);
      const fallback = list.find((m) => m.family === family);
      const candidate = pickRecommended(list, family);
      const row = el('div', 'model-active-row');
      row.appendChild(el('div', 'model-active-label', label));
      const value = el('div', 'model-active-value');

      if (family === 'nlp' && !active && !fallback) {
        value.appendChild(el('span', null, '内置 spaCy en_core_web_sm（无需设置）'));
      } else if (active) {
        value.appendChild(el('strong', null, labelFor(active)));
        const size = fmtSize(active);
        if (size) value.appendChild(el('span', 'model-meta', ' · ' + size));
        value.appendChild(el('span', 'book-badge badge-ok', '已设置推荐'));
        const warn = whyBad(family, active);
        if (warn) {
          value.appendChild(el('div', 'model-active-warn', warn));
        }
      } else if (fallback) {
        value.appendChild(el('span', 'settings-warn', '未设置推荐；系统会兜底用：'));
        value.appendChild(el('strong', null, labelFor(fallback)));
        const size = fmtSize(fallback);
        if (size) value.appendChild(el('span', 'model-meta', ' · ' + size));
        const warn = whyBad(family, fallback);
        if (warn) {
          value.appendChild(el('div', 'model-active-warn', warn));
        }
      } else {
        value.appendChild(el('span', 'settings-warn', '未登记任何可用模型'));
      }

      row.appendChild(value);
      if (!active && candidate && (family === 'llm' || family === 'tts')) needsFix = true;
      if (!active && candidate) {
        const btn = el('button', 'btn-small btn-primary', '设为推荐');
        btn.onclick = () => {
          if (typeof options.onSetRecommended === 'function') {
            options.onSetRecommended(candidate, btn);
          }
        };
        row.appendChild(btn);
      }
      rows.appendChild(row);
    };

    addRow('llm', '翻译 / 讲解');
    addRow('tts', '语音合成');
    addRow('nlp', '分词 / NLP');
    card.appendChild(rows);

    if (needsFix) {
      const fix = el('button', 'btn-primary', '一键使用推荐组合（Qwen3-4B + Kokoro 英文版）');
      fix.onclick = () => {
        if (typeof options.onFixAll !== 'function') return;
        fix.disabled = true;
        fix.textContent = '设置中…';
        Promise.resolve(options.onFixAll()).catch(() => {
          fix.disabled = false;
          fix.textContent = '一键使用推荐组合（Qwen3-4B + Kokoro 英文版）';
        });
      };
      card.appendChild(fix);
    }
    host.appendChild(card);
  }

  global.AiduModelActiveCard = { render, pickRecommended, labelFor, whyBad };
})(window);
