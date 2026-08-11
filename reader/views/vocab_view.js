/**
 * views/vocab_view.js —— 生词本 (I-B)
 * 列表 + 搜索 + 统计 + 删除 + 导出 JSON; profile 隔离
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class VocabView {
    constructor(store) {
      this.store = store;
      this.profileId = 'default';
      this.entries = [];
      this.filter = 'all'; // all | new | learning | review | mastered
      this.selected = new Set(); // H3: 批量选择的 lemma
      this.router = null; // 由 main.js setRouter 注入
    }

    /** L3 (2026-08-11): 注入路由实例 —— 「开始复习」需要"同路由强制重渲染"进专注模式 */
    setRouter(router) {
      this.router = router;
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'vocab-view');
      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '生词本'));

      // F27 (2026-08-08): .aidu-data 备份/恢复 —— 用户需求 item 9 的 UI 出口,
      // 此前 transfer_export/import 命令注册了但零前端调用。
      const backupBtn = el('button', 'btn-small', '备份');
      backupBtn.title = '导出词典+生词为 .aidu-data 文件, 可跨设备迁移/恢复';
      backupBtn.onclick = () => this._backup();
      const restoreBtn = el('button', 'btn-small', '恢复');
      restoreBtn.title = '从 .aidu-data 备份文件恢复词典与生词 (按时间合并, 新的覆盖旧的)';
      restoreBtn.onclick = () => this._restore();
      const exportBtn = el('button', 'btn-small', '导出 JSON');
      exportBtn.onclick = () => this._export();
      header.append(backupBtn, restoreBtn, exportBtn);
      wrap.appendChild(header);

      // 搜索 + 筛选
      const toolbar = el('div', 'vocab-toolbar');
      const searchInput = el('input', 'prep-input');
      searchInput.placeholder = '搜索生词…';
      searchInput.oninput = () => this._renderList();
      const filterSel = el('select', 'prep-select');
      ['all:全部', 'new:新词', 'learning:学习中', 'review:复习中', 'mastered:已掌握'].forEach(f => {
        const opt = el('option', null, f.split(':')[1]);
        opt.value = f.split(':')[0];
        filterSel.appendChild(opt);
      });
      filterSel.onchange = () => { this.filter = filterSel.value; this._renderList(); };
      const statsEl = el('span', 'vocab-stats');
      toolbar.append(searchInput, filterSel, statsEl);
      // H5 (2026-08-11): 按词频批量剔除 —— 一次性收拾存量 (either/lead 这类高频词不该背)。
      // dry-run 先给数字, 确认后执行 (后端备份 + 单事务)。
      const freqBtn = el('button', 'btn-small', '剔除最常见词');
      freqBtn.title = '把最常见的高频词 (either/lead/...) 批量移出生词本 —— 5.4 小时队列里一半是这类词, 毁掉复习。先预览将影响多少条, 确认后才删。';
      freqBtn.onclick = () => this._removeCommonWords();
      toolbar.appendChild(freqBtn);
      // H4 (2026-08-11): 存量打散 —— 首次导入的 1424 词 next_review 全在过去, 今日队列 1291 词
      // ≈323 分钟。按加入顺序摊到未来 N 天 (每天 ~40 词), 而不是全堆在今天。先 H5 剔词再打散。
      const spreadBtn = el('button', 'btn-small', '打散存量到期');
      spreadBtn.title = '把已到期的存量词 (next_review 在过去) 按加入顺序摊到未来 N 天, 今天只留每日可承受量。5.4 小时 → 约 40 分钟/天。';
      spreadBtn.onclick = () => this._spreadBacklog();
      toolbar.appendChild(spreadBtn);
      wrap.appendChild(toolbar);

      const listEl = el('div', 'vocab-list');
      wrap.appendChild(listEl);
      // H3: 批量选择条 (勾选词后出现, 在词表上方)
      const batchBar = el('div', 'vocab-batch-bar hidden');
      wrap.insertBefore(batchBar, listEl);
      this.batchBarEl = batchBar;
      // M7 R34: 近 14 天每日新增条形图 (坚持可见)
      this.chartEl = el('div', 'vocab-chart-wrap');
      wrap.insertBefore(this.chartEl, listEl);
      // H1 (2026-08-11): 生词本 = 上半「今日队列」卡 + 下半「词表」。
      // 点「开始复习」进入专注模式 (隐藏顶栏与词表, 只留三栏)。
      const todayCard = el('div', 'vocab-today-card');
      wrap.insertBefore(todayCard, listEl);
      this.todayCardEl = todayCard;
      container.appendChild(wrap);

      this.searchInput = searchInput;
      this.filterSel = filterSel;
      this.listEl = listEl;
      this.statsEl = statsEl;
      this._load();
    }

    /** H1: 今日队列卡 —— 上半 (N 词待复习 + 开始复习), 数据来自 review core 同规则 */
    _renderTodayCard() {
      if (!this.todayCardEl) return;
      const now = Date.now();
      const q = global.AiduReviewCore ? global.AiduReviewCore.buildQueue(this.entries, now) : null;
      const due = q ? (q.counts.review || 0) + (q.counts.learning || 0) + (q.counts.new || 0) : this.entries.length;
      const estMin = Math.ceil((q ? q.order.length : 0) * 15 / 60);
      this.todayCardEl.innerHTML = '';
      const head = el('div', 'vocab-today-head');
      head.appendChild(el('div', 'vocab-today-title', '今日队列'));
      const meta = el('span', 'vocab-today-meta', `${due} 词待复习${estMin ? ' · 约 ' + estMin + ' 分钟' : ''}`);
      head.appendChild(meta);
      this.todayCardEl.appendChild(head);
      const startBtn = el('button', 'btn-primary', '开始复习');
      startBtn.title = '进入专注模式: 隐藏顶栏与词表, 只留三栏; Esc 退出, 进度保留';
      startBtn.onclick = () => {
        if (global.AiduStore) {
          global.AiduStore.set({ reviewFocus: true });
          // L3 (2026-08-11): 不能再靠 location.hash 赋同值触发路由 —— 当前 hash 已经就是
          // #/vocab, 赋同值不触发 hashchange, 点「开始复习」就什么都不发生。
          // 直接走 router.navigate('vocab') (同路由时强制 dispatch 重渲染进专注模式)。
          if (this.router) {
            this.router.navigate('vocab');
          } else {
            // 兜底: 无路由引用时主动派发一次 hashchange 模拟 (旧实现完全不动)
            window.dispatchEvent(new Event('hashchange'));
          }
        } else {
          window.location.hash = '#/review';
        }
      };
      startBtn.disabled = due === 0;
      this.todayCardEl.appendChild(startBtn);
    }

    _load() {
      // M 系列: 走 service (生词本数据源是 vocab_all)
      AiduDictionaryService.vocabAll(this.profileId).then((res) => {
        if (!res.ok) { this.listEl.innerHTML = '<div class="global-error">加载失败: ' + res.error + '</div>'; return; }
        this.entries = res.data || [];
        this._renderStats();
        this._renderChart();
        this._renderTodayCard();
        this._renderList();
      });
    }

    /** M7 R34: 近 14 天每日新增条形图 (纯 CSS, 无图表库) */
    _renderChart() {
      if (!this.chartEl) return;
      this.chartEl.innerHTML = '';
      if (!this.entries.length) return;
      const buckets = AiduVocabStats.dailyBuckets(this.entries, 14);
      const max = Math.max(1, ...buckets.map((b) => b.count));
      const chart = el('div', 'vocab-chart');
      chart.title = '近 14 天每日新增生词';
      // 阶段6 设计交付 §04: 只有当天用强调色, 其余中性灰 (一屏一色)。
      // dailyBuckets 最后一个元素就是今天 (i=0)。
      buckets.forEach((b, bi) => {
        const bar = el('div', 'vocab-chart-bar');
        if (bi === buckets.length - 1) bar.classList.add('today');
        bar.style.height = Math.max(2, Math.round((b.count / max) * 42)) + 'px';
        bar.title = new Date(b.day).toLocaleDateString() + ' 新增 ' + b.count;
        chart.appendChild(bar);
      });
      this.chartEl.appendChild(chart);
    }

    _renderStats() {
      const total = this.entries.length;
      const counts = { new: 0, learning: 0, review: 0, mastered: 0 };
      this.entries.forEach((e) => { counts[e.stage] = (counts[e.stage] || 0) + 1; });
      // M7 R5: 掌握度概览 —— 四阶段计数 pill, 让"学到哪了"可见
      this.statsEl.innerHTML = '';
      this.statsEl.textContent = `共 ${total} 词 · `;
      const stages = [['new', '新词', 's-new'], ['learning', '学习中', 's-learning'],
        ['review', '复习中', 's-review'], ['mastered', '已掌握', 's-mastered']];
      stages.forEach(([k, l, cls]) => {
        const pill = el('span', 'vocab-stage-pill ' + cls, `${l} ${counts[k] || 0}`);
        this.statsEl.appendChild(pill);
      });
    }

    _renderList() {
      const q = (this.searchInput.value || '').toLowerCase();
      const filter = this.filter;
      // H3 (2026-08-11): 「已掌握」默认不在「全部」里占位 —— 设计的筛选本就把它单列。
      // "全部" = 还在学/还没学的词; 已掌握只通过"已掌握"筛选看。
      const items = this.entries.filter(e => {
        if (filter === 'all') {
          if (e.stage === 'mastered') return false;
        } else if (e.stage !== filter) return false;
        if (q && !(e.word + ' ' + e.meaning).toLowerCase().includes(q)) return false;
        return true;
      });
      this.listEl.innerHTML = '';
      // H3: 批量选择条 (勾选词后出现)
      this._renderBatchBar();
      if (!items.length) {
        // 苹果级空态: 三步引导 (下一步做什么)
        const empty = el('div', 'book-empty',
          this.entries.length === 0
            ? '生词本还是空的。三步加入生词:'
            : (filter === 'all' && this.entries.every((e) => e.stage === 'mastered'))
              ? '全部词都已掌握 🎉 用「已掌握」筛选回顾。'
              : '没有符合条件的生词。');
        if (this.entries.length === 0) {
          const steps = el('div', 'vocab-steps');
          ['① 打开一本就绪的书', '② 点句子里的单词, 查看释义', '③ 点"加入生词本"'].forEach(s => {
            steps.appendChild(el('div', 'vocab-step', s));
          });
          const goRead = el('button', 'btn-small btn-primary', '去书库选书');
          goRead.onclick = () => { window.location.hash = '#/library'; };
          const wrap2 = el('div', 'prep-empty');
          wrap2.append(empty, steps, goRead);
          this.listEl.appendChild(wrap2);
        } else {
          this.listEl.appendChild(empty);
        }
        return;
      }
      items.forEach(e => {
        // H3: 单行压缩 —— 词 · 释义 · 阶段 · 到期; 原句默认收起 (点行展开)。
        const row = el('div', 'vocab-row' + (this.selected.has(e.lemma) ? ' selected' : ''));
        const head = el('div', 'vocab-row-head');
        const check = el('input', 'vocab-check');
        check.type = 'checkbox';
        check.checked = this.selected.has(e.lemma);
        check.title = '批量选择';
        check.onclick = (ev) => { ev.stopPropagation(); this._toggleSelect(e.lemma); };
        const word = el('span', 'vocab-word', e.word);
        const meaning = el('span', 'vocab-meaning', e.meaning || '—');
        const stageLabel = { new: '新词', learning: '学习中', review: '复习中', mastered: '已掌握' }[e.stage] || e.stage;
        const stage = el('span', 'vocab-stage', stageLabel);
        const added = el('span', 'vocab-added',
          new Date(e.added_at || Date.now()).toLocaleDateString());
        // H3: 行尾 ⋯ 菜单 (维护动作): 移出生词本 / 标记已掌握 / 编辑释义 / 在阅读器中打开
        const menuBtn = el('button', 'vocab-menu-btn', '⋯');
        menuBtn.title = '更多操作';
        menuBtn.onclick = (ev) => { ev.stopPropagation(); this._openRowMenu(e, row); };
        head.append(check, word, meaning, stage, added, menuBtn);
        row.appendChild(head);
        // 原句: 默认收起 (点行展开)
        const hasCtx = e.context && String(e.context).trim();
        if (hasCtx) {
          const ctx = el('div', 'vocab-context collapsed', String(e.context).trim());
          row.appendChild(ctx);
          head.onclick = () => {
            row.classList.toggle('expanded');
            ctx.classList.toggle('collapsed');
          };
        } else {
          head.onclick = () => row.classList.toggle('expanded');
        }
        this.listEl.appendChild(row);
      });
    }

    /** H3: 批量选择条 —— 勾选词后出现: 批量移出 / 批量标记已掌握 */
    _renderBatchBar() {
      if (!this.batchBarEl) return;
      if (!this.selected.size) { this.batchBarEl.classList.add('hidden'); return; }
      this.batchBarEl.classList.remove('hidden');
      this.batchBarEl.innerHTML = '';
      this.batchBarEl.appendChild(el('span', 'vocab-batch-count', `已选 ${this.selected.size} 词`));
      const removeBtn = el('button', 'btn-small btn-danger', '批量移出');
      removeBtn.onclick = () => {
        AiduModal.confirm({
          title: `移出 ${this.selected.size} 个生词?`,
          message: '这些词将从生词本移除。',
          confirmText: '移出',
          danger: true,
          onConfirm: () => this._batchAction((lemma) => AiduDictionaryService.vocabRemove(this.profileId, lemma)),
        });
      };
      const masterBtn = el('button', 'btn-small', '批量标记已掌握');
      masterBtn.onclick = () => {
        AiduModal.confirm({
          title: `把 ${this.selected.size} 个词标记为已掌握?`,
          message: '已掌握的词不再进今日队列, 可在筛选里查看。',
          confirmText: '标记',
          onConfirm: () => this._batchAction((lemma) => {
            const entry = this.entries.find((e) => e.lemma === lemma);
            if (!entry) return Promise.resolve({ ok: true });
            const now = Date.now();
            const updated = Object.assign({}, entry, {
              stage: 'mastered', updated_at: now, next_review: now + 30 * 86400000,
            });
            return AiduDictionaryService.srsRestore(this.profileId, updated);
          }),
        });
      };
      const clearBtn = el('button', 'btn-small', '取消选择');
      clearBtn.onclick = () => { this.selected.clear(); this._renderList(); };
      this.batchBarEl.append(removeBtn, masterBtn, clearBtn);
    }

    /** H3: 批量动作顺序执行, 完成后重载 */
    async _batchAction(fn) {
      const lemmas = Array.from(this.selected);
      for (const l of lemmas) {
        const r = await fn(l);
        if (!r.ok) { AiduToast.show('批量操作中断: ' + r.error, 'error'); break; }
      }
      this.selected.clear();
      AiduToast.show(`已处理 ${lemmas.length} 词`, 'success');
      this._load();
    }

    _toggleSelect(lemma) {
      if (this.selected.has(lemma)) this.selected.delete(lemma);
      else this.selected.add(lemma);
      this._renderList();
    }

    /** H3: 行尾 ⋯ 菜单 —— 维护动作不进满宽按钮 */
    _openRowMenu(e, row) {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'vocab-menu';
      box.setAttribute('role', 'menu');
      const items = [
        ['移出生词本', () => {
          AiduModal.confirm({
            title: `删除生词 ${e.word}?`,
            message: '这个词将从生词本移除。',
            confirmText: '删除', danger: true,
            onConfirm: () => AiduDictionaryService.vocabRemove(this.profileId, e.lemma)
              .then(() => { this._load(); AiduToast.show('已移出 ' + e.word, 'info'); }),
          });
        }],
        ['标记已掌握', () => {
          const now = Date.now();
          const updated = Object.assign({}, e, { stage: 'mastered', updated_at: now, next_review: now + 30 * 86400000 });
          AiduDictionaryService.srsRestore(this.profileId, updated).then((r) => {
            if (!r.ok) { AiduToast.show('失败: ' + r.error, 'error'); return; }
            AiduToast.show('已标记已掌握: ' + e.word, 'success');
            this._load();
          });
        }],
        ['编辑释义', () => {
          const input = document.createElement('input');
          input.type = 'text';
          input.value = e.meaning || '';
          const m = global.AiduModal.confirm({
            title: `编辑释义: ${e.word}`,
            message: '',
            confirmText: '保存',
            onConfirm: () => {
              const updated = Object.assign({}, e, { meaning: input.value, updated_at: Date.now() });
              return AiduDictionaryService.srsRestore(this.profileId, updated).then((r) => {
                if (r.ok) { AiduToast.show('释义已更新', 'success'); this._load(); }
                return r;
              });
            },
          });
          const msg = m.box && m.box.querySelector('.modal-message');
          if (msg) { msg.textContent = ''; msg.appendChild(input); input.focus(); }
        }],
        ['在阅读器中打开', () => {
          if (!e.edition_id) { AiduToast.show('这个词没有来源定位, 无法打开', 'info'); return; }
          if (global.AiduStore && global.AiduRouter) {
            global.AiduStore.set({ currentBook: { id: e.edition_id, title: e.edition_id } });
            global.AiduStore.set({ readerBackRoute: 'vocab' });
            global.AiduStore.set({ vocabJump: { chapter: e.chapter_index, sentence: e.sentence_index } });
            window.location.hash = '#/reader';
          }
        }],
      ];
      items.forEach(([label, fn]) => {
        const it = el('button', 'vocab-menu-item', label);
        it.onclick = () => { ov.remove(); fn(); };
        box.appendChild(it);
      });
      ov.appendChild(box);
      ov.addEventListener('click', (ev) => { if (ev.target === ov) ov.remove(); });
      document.body.appendChild(ov);
      if (row) row.classList.add('menu-open');
    }

    /** H5 (2026-08-11): 词频批量剔除 —— dry-run 先给数字, 用户确认后执行 */
    _removeCommonWords() {
      const topN = 3000;
      AiduDictionaryService.vocabCommonPreview(this.profileId, topN).then((res) => {
        if (!res.ok) { AiduToast.show('读取失败: ' + res.error, 'error'); return; }
        const d = res.data || {};
        if (!d.count) {
          AiduToast.show('没有命中最常见 ' + d.top_n + ' 词的条目', 'info');
          return;
        }
        const samples = (d.lemmas || []).slice(0, 8).join(' · ');
        AiduModal.confirm({
          title: `剔除最常见 ${d.top_n} 词?`,
          message: `将移出 ${d.count} 条最常见的词 (如 ${samples}${(d.lemmas || []).length > 8 ? ' …' : ''})。\n\n执行前自动备份, 完成后告诉你备份位置。只影响当前档案 "${this.profileId}"。`,
          confirmText: '剔除 ' + d.count + ' 条',
          danger: true,
          onConfirm: () => AiduDictionaryService.vocabRemoveCommon(this.profileId, topN).then((r) => {
            if (!r.ok) { throw new Error(r.error); }
            const rm = r.data || {};
            AiduToast.show(`已剔除 ${rm.removed} 条最常见词`, 'success');
            if (rm.backup_path) {
              setTimeout(() => AiduToast.show('备份: ' + rm.backup_path, 'info'), 1200);
            }
            this._load();
            return;
          }),
        });
      });
    }

    /** H4 (2026-08-11): 存量打散 —— dry-run 先给数字 (今天 1291 → 摊成每天 ~40), 确认后执行 */
    _spreadBacklog() {
      const cap = 40;
      AiduDictionaryService.vocabBacklogPreview(this.profileId, cap).then((res) => {
        if (!res.ok) { AiduToast.show('读取失败: ' + res.error, 'error'); return; }
        const d = res.data || {};
        if (!d.backlog_count) {
          AiduToast.show('没有存量到期词, 无需打散', 'info');
          return;
        }
        const before = d.today_before;
        const after = d.today_after;
        const mins = Math.ceil(before * 15 / 60);
        const minsAfter = Math.ceil(after * 15 / 60);
        AiduModal.confirm({
          title: `打散 ${d.backlog_count} 个存量到期词?`,
          message: `今天到期 ${before} 词 (约 ${mins} 分钟)。打散后今天只留 ${after} 词 (约 ${minsAfter} 分钟), 其余按加入顺序摊到未来 ${d.days} 天。\n\n执行前自动备份, 完成后告诉你备份位置。`,
          confirmText: `打散 (今天 ${before} → ${after})`,
          danger: true,
          onConfirm: () => AiduDictionaryService.vocabBacklogSpread(this.profileId, cap).then((r) => {
            if (!r.ok) { throw new Error(r.error); }
            const s = r.data || {};
            AiduToast.show(`已打散 ${s.spread} 词到未来 ${s.days} 天`, 'success');
            if (s.backup_path) {
              setTimeout(() => AiduToast.show('备份: ' + s.backup_path, 'info'), 1200);
            }
            this._load();
            return;
          }),
        });
      });
    }

    _export() {
      const n = this.entries.length;
      const data = JSON.stringify(this.entries, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aidulc-vocab-${this.profileId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      AiduToast.show(`已导出 ${n} 个生词`, 'success');
    }

    /** F27: 备份为 .aidu-data (词典+生词, 跨设备迁移格式) */
    _backup() {
      AiduBridge.transfer.exportData().then((r) => {
        if (!r.ok) { AiduToast.show('备份失败: ' + r.error, 'error'); return; }
        const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'aidulc-aidu-data.json';
        a.click();
        URL.revokeObjectURL(url);
        AiduToast.show('已备份为 aidulc-aidu-data.json', 'success');
      });
    }

    /** F27: 从 .aidu-data 恢复 (按 updatedAt 合并, 新的覆盖旧的) */
    _restore() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.aidu-data';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          let backup;
          try { backup = JSON.parse(reader.result); }
          catch (e) { AiduToast.show('备份文件不是有效的 JSON', 'error'); return; }
          AiduBridge.transfer.importData(backup).then((r) => {
            if (!r.ok) { AiduToast.show('恢复失败: ' + r.error, 'error'); return; }
            const d = r.data || {};
            const bits = [];
            if (d.imported_vocab) bits.push(d.imported_vocab + ' 个生词');
            if (d.imported_dictionary) bits.push(d.imported_dictionary + ' 条词典');
            if (d.imported_highlights) bits.push(d.imported_highlights + ' 条摘录');
            AiduToast.show('已恢复' + (bits.length ? ' ' + bits.join(' · ') : ''), 'success');
            this._load();
          });
        };
        reader.readAsText(file);
      };
      input.click();
    }
  }

  global.VocabView = VocabView;
})(window);
