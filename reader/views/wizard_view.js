/**
 * views/wizard_view.js —— 首次运行向导 (H3)
 * 6 步: 语言 → 数据目录 → 硬件 → 模型发现 → 依赖清单 → 完成
 * 每步可跳过; 状态持久化, 重启续走。不显示技术名词 (GGUF/CUDA 隐藏为"引擎")。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class WizardView {
    constructor(store) {
      this.store = store;
      this.step = 0;
      this.container = null;
      this.onDone = null; // () => void
    }

    render(container) {
      this.container = container;
      container.innerHTML = '';
      const wrap = el('div', 'wizard-view');
      wrap.appendChild(el('h1', null, '欢迎使用 aidulc 精读工作站'));
      const hint = el('p', 'wizard-hint', '几步设置后, 你就能开始导入和阅读书籍。所有步骤都可以跳过, 以后在设置里补。');
      wrap.appendChild(hint);
      this.body = el('div', 'wizard-body');
      wrap.appendChild(this.body);
      container.appendChild(wrap);
      this._renderStep();
    }

    _renderStep() {
      if (!this.body) return;
      this.body.innerHTML = '';
      const steps = [
        ['语言', this._stepLanguage.bind(this)],
        ['数据目录', this._stepDataDir.bind(this)],
        ['硬件检查', this._stepHardware.bind(this)],
        ['模型发现', this._stepModels.bind(this)],
        ['依赖清单', this._stepDeps.bind(this)],
        ['完成', this._stepDone.bind(this)],
      ];
      const [title, fn] = steps[Math.min(this.step, steps.length - 1)];
      const header = el('h2', null, `第 ${this.step + 1} 步: ${title}`);
      this.body.appendChild(header);
      const content = el('div', 'wizard-content');
      this.body.appendChild(content);
      fn(content);

      // 底部导航
      const nav = el('div', 'wizard-nav');
      if (this.step > 0) {
        const back = el('button', 'btn-small', '上一步');
        back.onclick = () => { this.step--; this._renderStep(); };
        nav.appendChild(back);
      }
      const skip = el('button', 'btn-small', '跳过');
      skip.onclick = () => this._advance();
      nav.appendChild(skip);
      this.body.appendChild(nav);
    }

    _advance() {
      this.step++;
      if (this.step >= 6) {
        AiduModelService.wizardFinish().then(() => this.onDone && this.onDone());
        return;
      }
      AiduModelService.wizardSubmit(this.step, 'in_progress');
      this._renderStep();
    }

    _stepLanguage(content) {
      const p = el('p', null, '你主要读什么语言的书? 这会决定推荐的翻译/讲解/语音引擎。');
      content.appendChild(p);
      const langs = [
        ['en', '英文 (推荐, 当前完全支持)'],
        ['ja', '日文 (即将支持)'],
        ['other', '其他 (即将支持)'],
      ];
      langs.forEach(([code, label]) => {
        const row = el('label', 'wizard-option');
        const radio = el('input', null);
        radio.type = 'radio';
        radio.name = 'wizard-lang';
        radio.value = code;
        if (code === 'en') radio.checked = true;
        const disabled = code !== 'en';
        if (disabled) { radio.disabled = true; row.classList.add('disabled'); }
        row.append(radio, document.createTextNode(label));
        content.appendChild(row);
      });
      const next = el('button', 'btn-primary', '下一步');
      next.onclick = () => this._advance();
      content.appendChild(next);
    }

    _stepDataDir(content) {
      // 易用性审查: 不要求用户指定目录, 纯信息提示 (默认位置自动管理)
      content.appendChild(el('p', null, '书库、模型和音频都保存在应用自己的数据目录里, 不需要你操心。'));
      content.appendChild(el('div', 'wizard-info', '你随时可以在"设置"里查看存放位置。'));
      const next = el('button', 'btn-primary', '下一步');
      next.onclick = () => this._advance();
      content.appendChild(next);
    }

    _stepHardware(content) {
      content.appendChild(el('p', null, '正在检查你的电脑...'));
      AiduModelService.hardware('C:\\').then((res) => {
        content.innerHTML = '';
        if (!res.ok) { content.appendChild(el('p', 'global-error', '检查失败: ' + res.error)); return; }
        const gpu = res.data.gpu ? '检测到 NVIDIA 显卡, 将使用加速引擎' : '未检测到 NVIDIA 显卡, 将使用兼容模式';
        const freeGB = Math.round(res.data.disk_free_bytes / 1e9);
        content.appendChild(el('p', null, gpu));
        content.appendChild(el('p', null, `磁盘可用: ${freeGB} GB`));
        const next = el('button', 'btn-primary', '下一步');
        next.onclick = () => this._advance();
        content.appendChild(next);
      });
    }

    _stepModels(content) {
      content.appendChild(el('p', null, '扫描已有模型文件...'));
      // 易用性审查: 从运行时配置读模型目录, 不硬编码开发机路径
      AiduMiscService.runtimeConfig().then((cfg) => {
        const dir = cfg && cfg.ok && cfg.data && cfg.data.llm_model
          ? cfg.data.llm_model.replace(/[\\/][^\\/]+$/, '')  // 模型文件所在目录
          : '';
        return AiduModelService.scan(dir || 'C:/');
      }).then((res) => {
        content.innerHTML = '';
        if (!res.ok) { content.appendChild(el('p', 'global-error', '扫描失败: ' + res.error)); return; }
        const found = res.data || [];
        if (found.length === 0) {
          content.appendChild(el('p', null, '没有找到可复用的模型文件, 下一步会显示引擎状态。'));
        } else {
          // F16 (2026-08-08): 扫描命中即自动登记, 不再只是展示 —— 否则下一步的"已就绪"
          // 是假承诺, 导入时照样 preflight 报缺引擎。
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
          content.appendChild(el('p', null, `找到 ${found.length} 个可复用的模型文件, 已自动登记:`));
          Promise.all(jobs).then(() => {
            found.slice(0, 8).forEach(m => {
              content.appendChild(el('div', 'wizard-found', `✓ ${m.file_name} (${Math.round(m.size_bytes / 1e6)} MB)`));
            });
          });
        }
        const next = el('button', 'btn-primary', '下一步');
        next.onclick = () => this._advance();
        content.appendChild(next);
      });
    }

    _stepDeps(content) {
      content.appendChild(el('p', null, '正在检查本机引擎状态...'));
      AiduMiscService.componentsHealth().then((res) => {
        content.innerHTML = '';
        if (!res.ok) { content.appendChild(el('p', 'global-error', '检查失败: ' + res.error)); return; }
        const list = res.data || [];
        const byId = {};
        list.forEach((c) => { byId[c.id] = c; });
        const rows = [
          ['翻译/讲解引擎', byId.llm],
          ['语音引擎', byId.tts],
          ['词法引擎', byId.spacy],
          ['文档处理', byId.pymupdf],
        ];
        // F16 (2026-08-08): 不再硬编码"已就绪" —— 用真实健康状态, 缺的明确说缺
        const missing = [];
        rows.forEach(([name, c]) => {
          const ok = c && c.healthy;
          if (!ok) missing.push(name);
          content.appendChild(el('div', 'wizard-deps' + (ok ? '' : ' wizard-deps-missing'),
            `${name}: ${ok ? '✓ 已就绪' : (c ? c.detail : '未检测到')}`));
        });
        if (missing.length) {
          content.appendChild(el('p', 'settings-warn',
            `还需要 ${missing.join('、')}。可以先继续, 之后在"模型中心"里配置或下载。`));
        }
        const next = el('button', 'btn-primary', '完成设置');
        next.onclick = () => {
          AiduModelService.wizardFinish().then(() => this.onDone && this.onDone());
        };
        content.appendChild(next);
      });
    }

    _stepDone(content) {
      content.appendChild(el('p', null, '设置完成! 现在可以导入第一本书开始阅读。'));
      const btn = el('button', 'btn-primary', '进入书库');
      // Bug fix (审查确认): 完成页也必须标记向导 done, 否则下次启动重新拦截
      btn.onclick = () => {
        AiduModelService.wizardFinish().then(() => this.onDone && this.onDone());
      };
      content.appendChild(btn);
    }
  }

  global.WizardView = WizardView;
})(window);
