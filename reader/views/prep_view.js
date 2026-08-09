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
    queued: '排队中', retry_failed: '重试中',
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

    /** F33 (2026-08-08): 路由离开时注销事件订阅, 不残留对游离 DOM 的更新/重复拉取 */
    cleanup() {
      if (this._unlisteners) {
        this._unlisteners.forEach((u) => u && u());
        this._unlisteners = null;
      }
      this._listEl = null;
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
        // M7 R32: 按批次分组 (导入多本书成一个批次 → 组头展示), 未分组任务归"单本"
        const groups = {};
        const order = [];
        jobs.forEach((j) => {
          const key = j.batch_id || '__single__';
          if (!groups[key]) { groups[key] = []; order.push(key); }
          groups[key].push(j);
        });
        order.forEach((key) => {
          const group = groups[key];
          if (key !== '__single__') {
            // M7 R35: 组头完成率 (done/partial = 完成)
            const done = group.filter((j) => j.status === 'done' || j.status === 'partial').length;
            const head = el('div', 'prep-batch-head',
              `批次 ${String(key).replace(/^batch-/, '').slice(0, 16)} · ${done}/${group.length} 完成`);
            listEl.appendChild(head);
          }
          group.forEach((job) => listEl.appendChild(this._buildTaskRow(job)));
        });
      });
    }

    /** 构建单任务行 (暂停/继续/重试/移除/打开书籍 + 进度 + 阶段条 + 失败详情) */
    _buildTaskRow(job) {
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
        // R3: 暂停是 job 状态词 (resume 续跑), 2026-08-10 补齐 (此前漏 → 显示英文 paused)
        paused: { t: '已暂停', cls: 'st-warn' },
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
        // UX 审计 (2026-08-09): 破坏性操作先告知代价 —— 移除运行中任务会立刻停止并丢进度。
        const fileName = String(job.book_path || '').split(/[\\/]/).pop() || job.id;
        const warn = job.status === 'running'
          ? '任务正在处理中，移除会立即停止处理并丢弃当前进度。'
          : job.status === 'queued'
            ? '任务还在排队，移除后这本书不会再进入处理。'
            : '任务记录将从列表移除。';
        AiduModal.confirm({
          title: `移除任务《${fileName}》?`,
          message: warn,
          confirmText: '移除',
          danger: true,
          onConfirm: () => AiduJobService.remove(job.id).then((r) => {
            if (!r.ok) { AiduToast.show('移除失败: ' + r.error, 'error'); return; }
            this._refreshJobs();
            AiduToast.show('已移除任务', 'info');
          }),
        });
      };
      actions.appendChild(btnRemove);
      // G6: 任务完成后 "打开书籍" 入口
      if (job.status === 'done' || job.status === 'partial') {
        const btnOpen = el('button', 'btn-small btn-primary', '打开书籍');
        btnOpen.onclick = () => {
          // 阶段7 (F1): 优先用 job 关联的 edition_id(后端完成时已 attach), 不重算 book_id。
          // 旧逻辑按输出目录名 + profile 重算, 与 Rust book_id_from_path 的 lowercase 规则
          // 不同步, 输出目录一旦含字母会静默算错。edition_id 才是可靠真相。
          const bookId = job.edition_id || (() => {
            const dir = job.output_dir.replace(/\\/g, '/');
            const name = dir.split('/').pop() || dir;
            const profile = job.profile_id || 'default';
            return `${name.replace(/[^a-zA-Z0-9_]/g, '_')}_${profile}`;
          })();
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
      // I-C: 失败可读 —— 结构化失败详情 (阶段+句数+原因) + 详情按钮 (M7 R24)
      if (job.status === 'failed' || job.status === 'partial') {
        const fail = el('div', 'prep-failure', (job.error || (job.status === 'partial' ? '部分句子有失败阶段, 可重试失败句。' : '任务失败 (无详情)')));
        row.appendChild(fail);
        const detailBtn = el('button', 'btn-small', '查看详情');
        detailBtn.onclick = () => this._showJobDetail(job, detailBtn);
        fail.appendChild(detailBtn);
      }
      return row;
    }

    /** M7 R24: 任务详情模态 —— quality_report 的 error/阶段统计/失败句, 失败原因可读 */
    _showJobDetail(job, btn) {
      btn.disabled = true;
      btn.textContent = '读取中…';
      AiduJobService.detail(job.id).then((res) => {
        btn.disabled = false;
        btn.textContent = '查看详情';
        if (!res.ok) { AiduToast.show('读详情失败: ' + res.error, 'error'); return; }
        const qr = (res.data && res.data.quality_report) || null;
        const ov = document.createElement('div');
        ov.className = 'modal-overlay';
        const box = document.createElement('div');
        box.className = 'modal-box';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        const title = el('h2', 'modal-title', `任务详情 — ${job.book_path.split(/[\\/]/).pop()}`);
        const body = el('div', 'book-settings-body');
        if (qr && qr.error) body.appendChild(el('div', 'prep-failure', '错误: ' + qr.error));
        if (qr && qr.summary) body.appendChild(el('div', 'preview-meta', '摘要: ' + qr.summary));
        if (qr && qr.stages) {
          const stageList = el('div', 'vocab-steps');
          Object.entries(qr.stages).forEach(([k, v]) => {
            const s = (v && typeof v === 'object') ? v : {};
            const done = s.done || 0;
            const failed = s.failed || 0;
            stageList.appendChild(el('div', 'vocab-step', `${k}: ${done} 完成${failed ? `, ${failed} 失败` : ''}`));
          });
          body.appendChild(stageList);
        }
        const failedN = (qr && Array.isArray(qr.failedSentences)) ? qr.failedSentences.length : null;
        if (failedN != null) body.appendChild(el('div', 'preview-meta', `失败句数: ${failedN}`));
        // M7 R26: 原始日志尾部 (调试/诊断用)
        const logTail = res.data && res.data.run_log_tail;
        if (logTail) {
          const pre = document.createElement('pre');
          pre.className = 'job-log-tab';
          pre.textContent = logTail;
          body.appendChild(pre);
        }
        if (!qr && !logTail) body.appendChild(el('div', 'preview-meta', '没有 quality_report (可能是任务在写报告前中断)。' + (res.data && res.data.error ? '任务错误: ' + res.data.error : '')));
        const actions = el('div', 'modal-actions');
        // 阶段6 设计交付 §03: 失败动作含"复制日志" (反馈排查贴给开发者)
        if (logTail) {
          const copyBtn = el('button', 'btn-small', '复制日志');
          copyBtn.onclick = () => {
            navigator.clipboard.writeText(logTail).then(() => {
              AiduToast.show('日志已复制到剪贴板', 'success');
            }).catch(() => { AiduToast.show('复制失败, 请手动选中复制', 'error'); });
          };
          actions.appendChild(copyBtn);
        }
        const close = el('button', 'btn-small', '关闭');
        close.onclick = () => ov.remove();
        actions.appendChild(close);
        box.append(title, body, actions);
        ov.appendChild(box);
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
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
      // 返回 Promise (2026-08-10): 冒烟测试要等它完成后断言
      return Promise.all([AiduJobService.listBatches(), AiduJobService.list()]).then(([bres, jres]) => {
        if (!bres.ok) return;
        const jobs = (jres.ok && jres.data) || [];
        let batchEl = this._listEl.querySelector('.batch-summary');
        if (!batchEl) {
          batchEl = el('div', 'batch-summary');
          this._listEl.prepend(batchEl);
        }
        batchEl.innerHTML = '';
        (bres.data || []).slice(0, 5).forEach(b => {
          // 批次状态词与 DB 实际写入值逐个对上 (batches_repo: created|running|completed|partial|failed|canceled)。
          // 2026-08-10 修: 此前映射写错成 done (jobs 的状态词), DB 写的是 completed → 批次行显示英文。
          // 别和 jobs 那套 (queued|running|done|failed|paused) 互相抄。
          const statusText = { created: '已创建', running: '处理中', completed: '完成', partial: '部分完成', failed: '失败', canceled: '已取消' }[b.status] || b.status;
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
      const pctLabel = row.querySelector('.prep-pct');
      // UX 审计 (2026-08-09): 进度条与百分比标签用同一个数值更新 —— 后端 stage_progress
      // /stage_done 事件已带全书完成度 p.progress, 实时刷新不再"条按阶段比例、标签按全书
      // 进度"两套数字打架。
      const setFill = (pct) => {
        const v = Math.max(0, Math.min(100, Math.round(pct)));
        fill.style.width = v + '%';
        if (pctLabel) pctLabel.textContent = v + '%';
      };
      switch (p.type) {
        case 'stage_start':
        case 'stage_progress':
          if (p.type === 'stage_progress' && p.progress != null) {
            setFill(p.progress);
          } else if (p.type === 'stage_progress' && p.total > 0) {
            setFill((p.current / p.total) * 100);
          }
          status.textContent = stageLabel(p.stage || '') +
            (p.current != null ? ` ${p.current}/${p.total}` : '');
          break;
        case 'stage_done':
          status.textContent = stageLabel(p.stage || '') + ' ✓';
          if (p.progress != null) setFill(p.progress);
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
