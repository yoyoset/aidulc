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
      // M7 R34: 近 14 天每日新增条形图 (坚持可见)
      this.chartEl = el('div', 'vocab-chart-wrap');
      wrap.insertBefore(this.chartEl, listEl);
      container.appendChild(wrap);

      this.searchInput = searchInput;
      this.filterSel = filterSel;
      this.listEl = listEl;
      this.statsEl = statsEl;
      this._load();
    }

    _load() {
      // M 系列: 走 service (生词本数据源是 vocab_all)
      AiduDictionaryService.vocabAll(this.profileId).then((res) => {
        if (!res.ok) { this.listEl.innerHTML = '<div class="global-error">加载失败: ' + res.error + '</div>'; return; }
        this.entries = res.data || [];
        this._renderStats();
        this._renderChart();
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
      const items = this.entries.filter(e => {
        if (filter !== 'all' && e.stage !== filter) return false;
        if (q && !(e.word + ' ' + e.meaning).toLowerCase().includes(q)) return false;
        return true;
      });
      this.listEl.innerHTML = '';
      if (!items.length) {
        // 苹果级空态: 三步引导 (下一步做什么)
        const empty = el('div', 'book-empty',
          this.entries.length === 0
            ? '生词本还是空的。三步加入生词:'
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
        const row = el('div', 'vocab-row');
        const head = el('div', 'vocab-row-head');
        const word = el('span', 'vocab-word', e.word);
        const meaning = el('span', 'vocab-meaning', e.meaning || '—');
        const stageLabel = { new: '新词', learning: '学习中', review: '复习中', mastered: '已掌握' }[e.stage] || e.stage;
        const stage = el('span', 'vocab-stage', stageLabel);
        const added = el('span', 'vocab-added',
          new Date(e.added_at || Date.now()).toLocaleDateString());
        head.append(word, meaning, stage, added);
        row.appendChild(head);
        // 阶段6 设计交付 §04: 来源句上下文 —— 原句, 左侧 2px 强调竖线 (苹果级: 词脱离句子背不下来)
        if (e.context && String(e.context).trim()) {
          const ctx = el('div', 'vocab-context', String(e.context).trim());
          row.appendChild(ctx);
        }
        const del = el('button', 'btn-small btn-danger', '删除');
        del.onclick = () => {
          AiduModal.confirm({
            title: `删除生词 ${e.word}?`,
            message: '这个词将从生词本移除。',
            confirmText: '删除',
            danger: true,
            onConfirm: () => AiduDictionaryService.vocabRemove(this.profileId, e.lemma)
              .then(() => { this._load(); AiduToast.show('已删除 ' + e.word, 'info'); }),
          });
        };
        row.appendChild(del);
        this.listEl.appendChild(row);
      });
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
