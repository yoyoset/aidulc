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

      const exportBtn = el('button', 'btn-small', '导出 JSON');
      exportBtn.onclick = () => this._export();
      header.appendChild(exportBtn);
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
      wrap.appendChild(toolbar);

      const listEl = el('div', 'vocab-list');
      wrap.appendChild(listEl);
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
        this._renderList();
      });
    }

    _renderStats() {
      const total = this.entries.length;
      this.statsEl.textContent = `共 ${total} 词`;
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
        const word = el('span', 'vocab-word', e.word);
        const meaning = el('span', 'vocab-meaning', e.meaning || '—');
        const stageLabel = { new: '新词', learning: '学习中', review: '复习中', mastered: '已掌握' }[e.stage] || e.stage;
        const stage = el('span', 'vocab-stage', stageLabel);
        const added = el('span', 'vocab-added',
          new Date(e.added_at || Date.now()).toLocaleDateString());
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
        row.append(word, meaning, stage, added, del);
        this.listEl.appendChild(row);
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
  }

  global.VocabView = VocabView;
})(window);
