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

      // N1: 完成页用三个"下一步"选择替代底部导航, 不再显示跳过
      if (this.step >= steps.length - 1) return;
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
      // UX5 #4 (2026-08-13): 书库位置 = 数据根 —— 首次默认推荐 我的文档/aidulc
      // (可见、可预期), 显示完整结构引导; 用户可改 (走整根迁移)。
      content.appendChild(el('p', null, '书库、模型和音频都保存在一个数据根目录里。推荐放在「我的文档」下, 随时可见。'));
      const recBox = el('div', 'wizard-info');
      const recPath = el('code', 'j0-path', '读取中…');
      recPath.id = 'wizard-recommended-root';
      const hint = el('div', 'wizard-hint', '');
      recBox.append(recPath, hint);
      content.appendChild(recBox);
      // 完整结构引导 (每行一项说明)
      const struct = el('div', 'wizard-struct');
      const rows = [
        ['data.db', '数据库 (词库/进度/书签)'],
        ['jobs_out/', '书库 (生成的成品)'],
        ['models/', '模型下载目录'],
        ['backups/', '迁移与操作备份'],
        ['logs/', '日志'],
      ];
      rows.forEach(([name, desc]) => {
        const row = el('div', 'wizard-struct-row');
        row.appendChild(el('code', null, name));
        row.appendChild(el('span', null, ' — ' + desc));
        struct.appendChild(row);
      });
      content.appendChild(struct);

      // 用推荐位置 / 保持当前默认
      const useRec = el('button', 'btn-primary', '使用推荐位置');
      const keep = el('button', 'btn-small', '保持当前默认');
      const status = el('div', 'sync-status', '');
      const actions = el('div', 'prep-empty');
      actions.append(useRec, keep, status);
      content.appendChild(actions);

      const loadRec = () => AiduMiscService.dataRootRecommended().then((r) => {
        const path = (r.ok && r.data && r.data.path) || '';
        recPath.textContent = path || '我的文档/aidulc (探测失败, 将用系统默认)';
        recPath.title = path;
        return path;
      });
      loadRec();

      useRec.onclick = () => {
        useRec.disabled = true;
        status.textContent = '正在设置书库位置…';
        AiduMiscService.dataRootRecommended().then((r) => {
          const path = (r.ok && r.data && r.data.path) || '';
          if (!path) { status.textContent = '探测推荐位置失败, 保持默认。'; useRec.disabled = false; return; }
          // 与当前根一致 → 无需迁移
          return AiduMiscService.libraryDirGet().then((cur) => {
            if (cur.ok && cur.data === path) {
              status.textContent = '书库位置已是「' + path + '」';
              useRec.textContent = '✓ 已使用推荐位置';
              return;
            }
            return AiduMiscService.libraryDirPickAndSet(path).then((m) => {
              if (!m.ok) { status.textContent = '设置失败: ' + m.error; useRec.disabled = false; return; }
              const d = m.data || {};
              if (d.cancelled) { status.textContent = '已取消, 保持当前位置。'; useRec.disabled = false; return; }
              status.textContent = '已设置书库位置为「' + d.new_dir + '」。重启后生效, 现在可以继续。';
              useRec.textContent = '✓ 已设置推荐位置';
            });
          });
        });
      };
      keep.onclick = () => { status.textContent = '保持当前默认位置, 随时可在设置里更改。'; this._advance(); };

      const next = el('button', 'btn-primary', '下一步');
      next.onclick = () => this._advance();
      content.appendChild(next);
    }

    _stepHardware(content) {
      content.appendChild(el('p', null, '正在检查你的电脑...'));
      // UX 审计 (2026-08-09): 磁盘空间要查"书库实际所在盘", 不能硬编码 C:\
      // (书库可迁移到其它盘, 否则用户看到的可用空间和真实写入盘无关, 数字不可信)。
      AiduMiscService.libraryDirGet().then((r) => {
        const dir = (r && r.ok && r.data) ? r.data : 'C:\\';
        return AiduModelService.hardware(dir);
      }).then((res) => {
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
      // N1 (2026-08-12): 用户在投入前有权知道完整代价 —— 总下载量与单书耗时量级。
      // 用模型中心的下载目录 (同一份 sizeBytes), 不硬编码数字。
      const cat = (global.ModelsView && global.ModelsView.DOWNLOAD_CATALOG) || [];
      if (cat.length) {
        const totalGB = (cat.reduce((s, c) => s + (c.sizeBytes || 0), 0) / 1e9).toFixed(1);
        content.appendChild(el('div', 'wizard-cost',
          `先知道代价再投入: 若从零开始, 完整模型约需下载 ${totalGB} GB (翻译/讲解 + 语音引擎)。` +
          '处理一本书通常要几十分钟 (视篇幅与显卡), 进度在处理时可见。'));
      } else {
        content.appendChild(el('div', 'wizard-cost', '模型下载量暂估不出 (没有已知的下载目录项)。'));
      }
      // 易用性审查: 从运行时配置读模型目录, 不硬编码开发机路径
      AiduMiscService.runtimeConfig().then((cfg) => {
        const dir = cfg && cfg.ok && cfg.data && cfg.data.llm_model
          ? cfg.data.llm_model.replace(/[\\/][^\\/]+$/, '')  // 模型文件所在目录
          : '';
        // M4-3② (2026-08-12): 没有已知模型目录不扫 'C:/', 直接显示"可跳过, 之后在模型中心扫描"
        return dir ? AiduModelService.scan(dir) : Promise.resolve({ ok: true, data: [] });
      }).then((res) => {
        content.innerHTML = '';
        if (!res.ok) { content.appendChild(el('p', 'global-error', '扫描失败: ' + res.error)); return; }
        const found = res.data || [];
        // 重新挂代价告知 (扫描清空了 content)
        if (cat.length) {
          const totalGB = (cat.reduce((s, c) => s + (c.sizeBytes || 0), 0) / 1e9).toFixed(1);
          content.appendChild(el('div', 'wizard-cost',
            `若从零开始, 完整模型约需下载 ${totalGB} GB。处理一本书通常要几十分钟 (视篇幅与显卡)。`));
        }
        if (found.length === 0) {
          content.appendChild(el('p', null, '没有找到可复用的模型文件, 下一步会显示引擎状态。模型可在之后「模型中心」扫描或下载。'));
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
          // UX 审计 (2026-08-09): 指引别指错地方 —— 模型缺了去"模型中心"(设置内 tab),
          // 文档解析器(PyMuPDF)靠设置里"组件健康检查"的一键安装, 不能都指向"模型中心"。
          content.appendChild(el('p', 'settings-warn',
            `还需要 ${missing.join('、')}。可以先继续, 之后在"设置"里补齐：模型在"模型中心"配置/下载, 文档解析器可一键安装。`));
        }
        const next = el('button', 'btn-primary', '完成设置');
        next.onclick = () => {
          AiduModelService.wizardFinish().then(() => this.onDone && this.onDone());
        };
        content.appendChild(next);
      });
    }

    _stepDone(content) {
      content.appendChild(el('p', null, '设置完成! 接下来想做什么?'));
      // N1 (2026-08-12): 完成页给"下一步做什么"的三选一, 不再把人扔进空书库。
      const choices = el('div', 'wizard-choices');
      const mk = (label, desc, onClick, opts) => {
        const row = el('button', 'wizard-choice' + (opts && opts.disabled ? ' disabled' : ''));
        row.type = 'button';
        row.appendChild(el('span', 'wizard-choice-label', label));
        if (desc) row.appendChild(el('span', 'wizard-choice-desc', desc));
        if (opts && opts.disabled) {
          row.disabled = true;
          row.title = opts.disabledReason || '';
          row.appendChild(el('span', 'wizard-choice-soon', opts.disabledReason || ''));
        } else if (onClick) {
          row.onclick = () => { AiduModelService.wizardFinish().then(() => onClick()); };
        }
        choices.appendChild(row);
      };
      mk('① 导入我自己的书', '把 EPUB / TXT 拖进书库, 生成可阅读的译本。', () => this.onDone && this.onDone());
      // UX5 #7 (2026-08-13): R1 内置样书 —— 从「即将支持」变为可用, 点击导入样书进书库
      mk('② 先看一本内置样书', '导入官方示例书 (无音频文本样书), 立即体验阅读与查词。', () => {
        AiduBridge.invoke('sample_book_import').then((r) => {
          if (!r.ok) {
            if (typeof AiduToast !== 'undefined') AiduToast.show('样书导入失败: ' + r.error, 'error');
            return;
          }
          if (typeof AiduToast !== 'undefined') AiduToast.show('已导入样书, 在书库里可以打开阅读', 'success');
          // 进书库, 样书已在其中 (可点开阅读)
          if (this.onDone) this.onDone();
        });
      });
      mk('③ 先去配模型', '检查/下载翻译与语音模型, 提前备好。', () => {
        // M2 同款教训: 用 store 实例 (this.store), 不是 global.AiduStore (那是类, 没有 set)
        if (this.store) this.store.set({ settingsTab: 'models' });
        window.location.hash = '#/settings';
      });
      content.appendChild(choices);
    }
  }

  global.WizardView = WizardView;
})(window);
