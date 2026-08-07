/**
 * views/prep_view.js —— 备料台: 文件选择/拖拽导入 + 任务行 + 阶段进度 (P1)
 * P1: 接入主界面; 移除/重试/打开目录按钮接真实命令。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** 阶段名 → 中文 (易用性: 用户看不懂 parse/translate) */
  const STAGE_LABELS = {
    parse: '解析', nlp: '分词', translate: '翻译', explain: '讲解',
    tts: '语音', align: '对齐', pack: '打包', spawn_error: '启动失败',
  };
  function stageLabel(stage) {
    return STAGE_LABELS[stage] || stage;
  }

  class PrepView {
    constructor(store) {
      this.store = store;
      this.onOpenBook = null; // (book) => void (任务完成后 "打开")
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'prep-view');

      const header = el('div', 'page-header');
      header.appendChild(el('h1', null, '阅读准备'));
      const sub = el('div', 'prep-subtitle', '书籍导入在"书库"页完成; 这里负责处理队列、暂停/继续与失败修复。');
      header.appendChild(sub);
      // R3: 全局暂停/继续
      const ctrl = el('div', 'prep-controls');
      const pauseAllBtn = el('button', 'btn-small', '全部暂停');
      pauseAllBtn.onclick = () => AiduJobService.pauseAll().then(() => { AiduToast.show('已全部暂停', 'info'); this._refreshJobs(); });
      const resumeAllBtn = el('button', 'btn-small btn-primary', '全部继续');
      resumeAllBtn.onclick = () => AiduJobService.resumeAll().then(() => { AiduToast.show('已全部继续', 'success'); this._refreshJobs(); });
      ctrl.append(pauseAllBtn, resumeAllBtn);
      header.appendChild(ctrl);

      // 任务列表
      const listEl = el('div', 'prep-list');
      this._listEl = listEl;

      wrap.append(header, listEl);
      container.appendChild(wrap);

      // 订阅任务进度 (Bug fix 审查确认: 注销旧订阅, 每次 render 叠加 4 个 listener)
      if (this._unlisteners) { this._unlisteners.forEach(u => u && u()); }
      this._unlisteners = [
        AiduBridge.listen('job-progress', (ev) => {
          const p = ev.payload || {};
          this._updateTask(p);
        }),
        AiduBridge.listen('library-changed', () => {
          this._refreshLibrary();
        }),
        AiduBridge.listen('job-list-changed', () => {
          this._refreshJobs();
        }),
        AiduBridge.listen('batch-progress', () => {
          this._refreshBatches();
        }),
      ];
      this._refreshJobs();
      this._refreshBatches();
    }

    _refreshJobs() {
      AiduJobService.list().then((res) => {
        if (!res.ok) return;
        // 重建任务列表 (持久任务 P4), 保留批次摘要区
        const listEl = this._listEl;
        const batchSummary = listEl.querySelector('.batch-summary');
        listEl.innerHTML = '';
        if (batchSummary) listEl.appendChild(batchSummary);
        const jobs = res.data || [];
        if (jobs.length === 0) {
          // 苹果级空态: 引导下一步 (去书库导入)
          const empty = el('div', 'book-empty');
          empty.textContent = '这里还没有任务。去书库导入一本书, 会在这里排队处理。';
          const goLib = el('button', 'btn-small btn-primary', '去书库导入');
          goLib.onclick = () => {
            if (window.AiduRouter) {
              const hash = window.location.hash;
              window.location.hash = '#/library';
              if (hash === '#/library') window.location.reload();
            }
          };
          const emptyWrap = el('div', 'prep-empty');
          emptyWrap.append(empty, goLib);
          listEl.appendChild(emptyWrap);
          return;
        }
        jobs.forEach((job) => {
          const row = el('div', 'prep-task');
          row.dataset.jobId = job.id;
          const header = el('div', 'prep-task-header');
          const title = el('span', 'prep-task-title', `${job.book_path.split(/[\\/]/).pop()} (${job.profile_id})`);
          // 易用性审查: 状态显示中文 (用户看不懂 running/done)
          const statusMeta = {
            queued: { t: '排队中', cls: 'st-idle' },
            running: { t: job.stage ? `${stageLabel(job.stage)} ${job.current}/${job.total}` : '处理中', cls: 'st-busy' },
            done: { t: '完成', cls: 'st-ok' },
            failed: { t: '失败', cls: 'st-err' },
            canceled: { t: '已取消', cls: 'st-idle' },
            partial: { t: '部分完成', cls: 'st-warn' },
          }[job.status] || { t: job.status, cls: 'st-idle' };
          const status = el('span', 'prep-task-status ' + statusMeta.cls, statusMeta.t);
          const actions = el('div', 'prep-task-actions');
          // R3: 暂停/继续 (处理中/排队可暂停, 已暂停可继续)
          if (job.status === 'running' || job.status === 'queued') {
            const btnPause = el('button', 'btn-small', '暂停');
            btnPause.onclick = () => {
              AiduJobService.pause(job.id).then((r) => {
                if (!r.ok) { AiduToast.show('暂停失败: ' + r.error, 'error'); return; }
                AiduToast.show('已暂停, 可从断点继续', 'info');
                this._refreshJobs();
              });
            };
            actions.appendChild(btnPause);
          }
          if (job.status === 'paused') {
            const btnResume = el('button', 'btn-small btn-primary', '继续');
            btnResume.onclick = () => {
              AiduJobService.resume(job.id).then((r) => {
                if (!r.ok) { AiduToast.show('继续失败: ' + r.error, 'error'); return; }
                AiduToast.show('已继续', 'success');
                this._refreshJobs();
              });
            };
            actions.appendChild(btnResume);
          }
          // 失败行: 重试失败句可见 (苹果级: 失败必有恢复路径)
          if (job.status === 'failed' || job.status === 'partial') {
            const btnRetry = el('button', 'btn-small', '重试失败句');
            btnRetry.onclick = () => {
              btnRetry.disabled = true;
              btnRetry.textContent = '重试中…';
              AiduJobService.retryFailed(job.id).then((r) => {
                if (!r.ok) { btnRetry.disabled = false; btnRetry.textContent = '重试失败句'; AiduToast.show('重试失败: ' + r.error, 'error'); return; }
                AiduToast.show('已重新排队', 'success');
                this._refreshJobs();
              });
            };
            actions.appendChild(btnRetry);
          }
          const btnRemove = el('button', 'btn-small', '移除');
          btnRemove.onclick = () => {
            AiduJobService.remove(job.id).then(() => { this._refreshJobs(); AiduToast.show('已移除任务', 'info'); });
          };
          actions.appendChild(btnRemove);
          // G6: 任务完成后 "打开书籍" 入口
          if (job.status === 'done' || job.status === 'partial') {
            const btnOpen = el('button', 'btn-small btn-primary', '打开书籍');
            btnOpen.onclick = () => {
              // 从书包目录生成 book_id 并打开 (与 Rust book_id_from_path 同规则)
              const dir = job.output_dir.replace(/\\/g, '/');
              const name = dir.split('/').pop() || dir;
              const profile = job.profile_id || 'default';
              const bookId = `${name.replace(/[^a-zA-Z0-9_]/g, '_')}_${profile}`;
              if (this.onOpenBook) this.onOpenBook(bookId, job.output_dir);
            };
            actions.insertBefore(btnOpen, actions.firstChild);
          }
          header.append(title, status, actions);
          const bar = el('div', 'prep-bar');
          const fill = el('div', 'prep-bar-fill');
          // v9: 全书完成度 (后端阶段权重算好, 前端只显示)
          const pct = job.progress != null ? Math.round(job.progress) : (job.total > 0 ? Math.round((job.current / job.total) * 100) : 0);
          fill.style.width = pct + '%';
          bar.appendChild(fill);
          // 任务行百分比文本 (苹果级: 进度可见)
          const pctLabel = el('span', 'prep-pct', `${pct}%`);
          bar.appendChild(pctLabel);
          row.append(header, bar);
          // R5: 阶段流水条 (识别→分词→翻译→讲解→语音→对齐→排版)
          row.appendChild(this._stagePipeline(job));
          // I-C: 失败可读 —— 结构化失败详情 (阶段+句数+原因)
          if (job.status === 'failed') {
            const fail = el('div', 'prep-failure', (job.error || '任务失败 (无详情)'));
            row.appendChild(fail);
          }
          listEl.appendChild(row);
        });
      });
    }

    /** R5: 7 阶段流水条 — 已完成✓ 当前高亮+进度 未到置灰 */
    _stagePipeline(job) {
      const stages = ['parse', 'nlp', 'translate', 'explain', 'tts', 'align', 'pack'];
      const labels = ['识别', '分词', '翻译', '讲解', '语音', '对齐', '排版'];
      const currentIdx = stages.indexOf(job.stage);
      const pipe = el('div', 'stage-pipe');
      stages.forEach((s, i) => {
        const seg = el('span', 'stage-seg');
        if (i < currentIdx) {
          seg.className += ' stage-done';
          seg.textContent = '✓ ' + labels[i];
        } else if (i === currentIdx && (job.status === 'running' || job.status === 'queued')) {
          seg.className += ' stage-cur';
          seg.textContent = labels[i] + (job.total > 0 ? ` ${job.current}/${job.total}` : '');
        } else if (i === currentIdx && job.status === 'paused') {
          seg.className += ' stage-cur';
          seg.textContent = '⏸ ' + labels[i];
        } else if (job.status === 'done') {
          seg.className += ' stage-done';
          seg.textContent = '✓ ' + labels[i];
        } else {
          seg.className += ' stage-wait';
          seg.textContent = labels[i];
        }
        pipe.appendChild(seg);
        if (i < stages.length - 1) pipe.appendChild(el('span', 'stage-arrow', '→'));
      });
      return pipe;
    }

    _refreshBatches() {
      // 批次进度 = 批内 job 句进度聚合 (单本处理中也实时显示, 不再是 0%)
      Promise.all([AiduJobService.listBatches(), AiduJobService.list()]).then(([bres, jres]) => {
        if (!bres.ok) return;
        const jobs = (jres.ok && jres.data) || [];
        let batchEl = this._listEl.querySelector('.batch-summary');
        if (!batchEl) {
          batchEl = el('div', 'batch-summary');
          this._listEl.prepend(batchEl);
        }
        batchEl.innerHTML = '';
        (bres.data || []).slice(0, 5).forEach(b => {
          const statusText = { created: '已创建', running: '处理中', done: '完成', partial: '部分完成', failed: '失败', canceled: '已取消' }[b.status] || b.status;
          const batchJobs = jobs.filter(j => j.batch_id === b.id);
          let sumC = 0, sumT = 0;
          batchJobs.forEach(j => { sumC += j.current || 0; sumT += j.total || 0; });
          // 整本完成计数 + 句进度聚合
          const booksTotal = b.total_books || batchJobs.length || 0;
          const booksDone = b.done_books + b.failed_books;
          const pct = sumT > 0 ? Math.round((sumC / sumT) * 100)
            : (booksTotal > 0 ? Math.round((booksDone / booksTotal) * 100) : 0);
          const row = el('div', 'batch-row');
          const info = el('span', null,
            `批次 ${b.id.slice(-8)} · ${booksDone}/${booksTotal} 本 · ${statusText} · ${pct}%`);
          row.appendChild(info);
          const pbar = el('div', 'prep-bar');
          const pfill = el('div', 'prep-bar-fill');
          pfill.style.width = pct + '%';
          pbar.appendChild(pfill);
          row.appendChild(pbar);
          batchEl.appendChild(row);
        });
      });
    }

    _updateTask(p) {
      const jobId = p.jobId;
      // G2 修复: 按 jobId 匹配任务行 (不能永远更新最后一行 — 审查确认的 bug)
      const row = Array.from(this._listEl.querySelectorAll('.prep-task'))
        .find(r => r.dataset.jobId === jobId);
      if (!row) { this._refreshJobs(); return; }
      const status = row.querySelector('.prep-task-status');
      const fill = row.querySelector('.prep-bar-fill');
      if (!status || !fill) return;
      switch (p.type) {
        case 'stage_start':
        case 'stage_progress':
          if (p.type === 'stage_progress' && p.total > 0) {
            fill.style.width = Math.round((p.current / p.total) * 100) + '%';
          }
          status.textContent = `${p.stage || ''} ${p.current != null ? p.current + '/' + p.total : '…'}`;
          break;
        case 'stage_done':
          status.textContent = (p.stage || '') + ' ✓';
          break;
        case 'error':
          status.textContent = '失败';
          break;
        case 'job_done':
          status.textContent = '完成';
          fill.style.width = '100%';
          break;
      }
    }

    _refreshLibrary() {
        AiduLibraryService.list().then((res) => {
        if (res.ok) this.store.set({ books: res.data });
      });
    }
  }

  global.PrepView = PrepView;
})(window);
