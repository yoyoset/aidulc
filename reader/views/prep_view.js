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
      // I6 (2026-08-11): 页面标题统一为「处理中」(顶栏也叫处理中, 不再叫"阅读准备")
      header.appendChild(el('h1', null, '处理中'));
      const sub = el('div', 'prep-subtitle', '书籍导入在"书库"页完成; 这里负责处理队列、暂停/继续与失败修复。');
      header.appendChild(sub);
      // R3: 全局暂停/继续 —— I7 (2026-08-11): 无活跃任务时禁用 (点了没暂停 = 假反馈)
      const ctrl = el('div', 'prep-controls');
      const pauseAllBtn = el('button', 'btn-small', '全部暂停');
      pauseAllBtn.onclick = () => AiduJobService.pauseAll().then(() => { AiduToast.show('已全部暂停', 'info'); this._refreshJobs(); });
      const resumeAllBtn = el('button', 'btn-small btn-primary', '全部继续');
      resumeAllBtn.onclick = () => AiduJobService.resumeAll().then(() => { AiduToast.show('已全部继续', 'success'); this._refreshJobs(); });
      ctrl.append(pauseAllBtn, resumeAllBtn);
      this._pauseAllBtn = pauseAllBtn;
      this._resumeAllBtn = resumeAllBtn;
      header.appendChild(ctrl);

      // 任务列表 (I1: 三段式 — 进行中 / 排队中 / 最近完成)
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
          this._refreshJobs();
        }),
      ];
      this._refreshJobs();
    }

    /** F33 (2026-08-08): 路由离开时注销事件订阅, 不残留对游离 DOM 的更新/重复拉取 */
    cleanup() {
      if (this._unlisteners) {
        this._unlisteners.forEach((u) => u && u());
        this._unlisteners = null;
      }
      this._listEl = null;
    }

    /** I1/I2/I4/I7 (2026-08-11): 处理中页三段式 —— 进行中 / 排队中 / 最近完成。
     *  批次降级为分组标题 (不再有独立进度条列表); 完成满一天的批次进「查看历史」。
     *  徽章口径 (I5): running+queued+paused 三种都算活跃。 */
    _refreshJobs() {
      return Promise.all([AiduJobService.list(), AiduJobService.listBatches()]).then(([res, bres]) => {
        if (!res.ok) return;
        const listEl = this._listEl;
        listEl.innerHTML = '';
        const jobs = res.data || [];
        const batches = (bres.ok && bres.data) || [];
        const now = Date.now();

        // I5: 活跃任务 = running+queued+paused (与顶栏徽章同口径)
        const activeCount = jobs.filter((j) => ['running', 'queued', 'paused'].includes(j.status)).length;
        // I7: 无活跃任务 → 全局按钮禁用 (避免"已全部暂停"但什么都没暂停的假反馈)
        if (this._pauseAllBtn) this._pauseAllBtn.disabled = activeCount === 0;
        if (this._resumeAllBtn) this._resumeAllBtn.disabled = activeCount === 0;

        if (jobs.length === 0) {
          // I7 (2026-08-11): 空态文案 + 去书库导入入口
          const empty = el('div', 'book-empty', '这里还没有任务。去书库导入一本书, 会在这里排队处理。');
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

        // 批次 id → 人话 (I4): 「N 本书 · 今天 14:22」, 原始 id 进 title 悬浮
        const batchInfo = (id) => {
          const b = batches.find((x) => x.id === id);
          if (!b) return { label: '任务', title: id };
          const d = new Date(b.created_at);
          const sameDay = d.toDateString() === new Date(now).toDateString();
          const when = sameDay
            ? '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
            : d.toLocaleDateString();
          return { label: `${b.total_books} 本书 · ${when}`, title: id };
        };

        // 三段归类 (I1): running→进行中, queued/paused→排队中, 其余终态→最近完成
        const running = jobs.filter((j) => j.status === 'running');
        const queued = jobs.filter((j) => ['queued', 'paused'].includes(j.status));
        // I2: 最近完成只显示今天的; 更早的进「查看历史」
        const todayDone = jobs.filter((j) => ['done', 'partial', 'failed', 'canceled'].includes(j.status));
        const recent = todayDone.filter((j) => {
          const t = j.updated_at || j.created_at || 0;
          return new Date(t).toDateString() === new Date(now).toDateString();
        });
        const history = todayDone.filter((j) => !recent.includes(j));

        const section = (title, items) => {
          const sec = el('div', 'prep-section');
          sec.appendChild(el('div', 'prep-section-title', title));
          items.forEach((j) => sec.appendChild(this._buildTaskRow(j)));
          return sec;
        };
        // 批次作为组头 (I1): 同一批的归到一起, 组头显示人话
        const groupByBatch = (items) => {
          const groups = {};
          const order = [];
          items.forEach((j) => {
            const key = j.batch_id || '__single__';
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(j);
          });
          const out = [];
          order.forEach((key) => {
            const group = groups[key];
            if (key !== '__single__') {
              const info = batchInfo(key);
              const head = el('div', 'prep-batch-head', info.label);
              head.title = info.title;
              out.push(head);
            }
            group.forEach((j) => out.push(this._buildTaskRow(j)));
          });
          return out;
        };

        if (running.length || queued.length) {
          const activeSec = el('div', 'prep-section');
          activeSec.appendChild(el('div', 'prep-section-title', '进行中'));
          groupByBatch(running).forEach((n) => activeSec.appendChild(n));
          if (queued.length) {
            const qTitle = el('div', 'prep-section-title', '排队中');
            // K16 (2026-08-14): 严格顺序执行是显存安全的刻意设计 (LLM+TTS 同驻会撑爆
            // 12GB 显存, 见 pipeline/runner.py:124-127), 之前没有任何文案说明, 用户
            // 体验上等同于一个没解释的限制。
            const hint = el('span', 'prep-queue-hint', ' ⓘ 一次只跑一本');
            hint.title = '同时运行多本书会让翻译模型和语音模型同时占用显存, 容易爆显存, 所以任务严格排队顺序执行。';
            qTitle.appendChild(hint);
            activeSec.appendChild(qTitle);
            groupByBatch(queued).forEach((n) => activeSec.appendChild(n));
          }
          listEl.appendChild(activeSec);
        }
        if (recent.length) {
          listEl.appendChild(section('今天完成', recent));
        }
        if (history.length) {
          const histBtn = el('button', 'prep-history-toggle', `查看历史 (${history.length})`);
          histBtn.onclick = () => {
            const body = el('div', 'prep-history');
            history.forEach((j) => body.appendChild(this._buildTaskRow(j)));
            histBtn.replaceWith(body);
          };
          listEl.appendChild(histBtn);
        }
      });
    }

    /** I8 (2026-08-11): profile id → 档案名 (default → 成人自读), 不把内部 id 上屏 */
    _profileName(id) {
      if (!id || id === 'default') return '成人自读';
      if (id === 'kid') return '陪小孩读';
      return id;
    }

    /** 构建单任务行 (暂停/继续/重试/移除/打开书籍 + 进度 + 阶段条 + 失败详情) */
    _buildTaskRow(job) {
      const row = el('div', 'prep-task');
      row.dataset.jobId = job.id;
      const header = el('div', 'prep-task-header');
      // I8: 书名走 G5 清洗 (剥来源站后缀/扩展名); 档案显示名字不显示 (default)
      const rawName = String(job.book_path || '').split(/[\\/]/).pop() || job.id;
      const parsed = global.AiduTitleCleanup ? global.AiduTitleCleanup.parseBookTitle(rawName) : { title: rawName, author: null };
      const title = el('span', 'prep-task-title', `${parsed.title} · ${this._profileName(job.profile_id)}`);
      title.title = rawName;
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
        // K14 (2026-08-14): "取消"跟"暂停"是不同的终态——暂停可继续, 取消落 failed
        // 不可续跑(但保留在历史里能看/能整个重跑, 不是"移除"那种直接从列表删掉)。
        const btnCancel = el('button', 'btn-small', '取消');
        btnCancel.title = '停止这个任务, 不可继续(区别于"暂停"); 记录仍保留, 可以整个重跑。';
        btnCancel.onclick = () => {
          AiduModal.confirm({
            title: `取消任务《${job.book_path ? job.book_path.split(/[\\/]/).pop() : job.id}》?`,
            message: '取消后不能像"暂停"那样继续, 但记录保留在列表里, 之后可以整个重跑。',
            confirmText: '取消任务', danger: true,
            onConfirm: () => AiduJobService.cancel(job.id).then((r) => {
              if (!r.ok) { AiduToast.show('取消失败: ' + r.error, 'error'); return; }
              AiduToast.show('已取消', 'info');
              this._refreshJobs();
            }),
          });
        };
        actions.appendChild(btnCancel);
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
        // 手动重跑 (2026-08-13): 选错模型/想重做某阶段时, 重新选模型 + 指定重跑范围
        const btnRerun = el('button', 'btn-small', '重跑…');
        btnRerun.title = '重新选模型或指定重跑范围 (比如只重跑语音) —— 比「重试失败句」更细。';
        btnRerun.onclick = () => this._showRetryDialog(job);
        actions.appendChild(btnRerun);
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
        // UX5 修正 (2026-08-13): 模型类失败 → 给「去修模型」入口 (用户实测: TTS 引擎错,
        // 任务失败后没有入口去改模型设置再重跑)。错误信息里带模型/TTS/引擎关键词就显示。
        const errText = String(job.error || '');
        if (/(模型|TTS|voices|config|引擎|缺少|模型文件)/.test(errText)) {
          const btnFix = el('button', 'btn-small btn-primary', '去修模型');
          btnFix.title = '这个失败和模型有关。去模型中心检查/更换推荐模型后, 再回来点「重试失败句」。';
          // K17 (2026-08-14): 之前跳去"设置→依赖组件"tab, 那里只有版本检查、没有下载能力。
          // 改跳"模型中心"(#/models), 有 catalog 一键下载单; 能从报错文本猜出是哪个家族
          // (llm/tts) 就带上 focus, 直接弹下载单。
          const family = /TTS|voices|语音/.test(errText) ? 'tts' : (/翻译|LLM/.test(errText) ? 'llm' : '');
          btnFix.onclick = () => {
            window.location.hash = '#/models' + (family ? '?focus=' + family : '');
          };
          actions.appendChild(btnFix);
        }
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
      // K20 (2026-08-14): 长任务(翻译/讲解一本长篇小说可能要跑数小时)之前只有百分比,
      // 用户只能猜"还要 5 分钟"还是"还要 5 小时"。用已耗时/已完成度线性外推(不是精确
      // 预测, 各阶段耗时本来就不均匀, 只给量级参考); 刚开始(<5%)样本太少估不准, 不显示。
      const eta = this._formatEta(job, pct);
      if (eta) pctLabel.textContent += ` · ${eta}`;
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

    /** 手动重跑 (2026-08-13): 「重跑…」对话框 — 重新选模型 (3 下拉) + 重跑范围 (单选)。
     * 点「开始重跑」→ AiduJobService.retryCustom(id, llmId, ttsId, nlpId, forceStages)。
     * 模型下拉: 默认「保持当前」(书级绑定/推荐解析), 选项 = 已登记模型 (AiduModelService.list)。
     * 重跑范围: 自动(只跑失败/未完成) / 从翻译 / 从讲解 / 从语音 / 全部, 语义与
     * prep checkpoint.clear_stages 的 FORCE_STAGE_CASCADE 对齐 (翻译级联讲解, 语音级联对齐)。
     */
    _showRetryDialog(job) {
      const famLabels = { llm: '翻译引擎', tts: '语音引擎', nlp: '分词' };
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = el('h2', 'modal-title', `重跑 — ${job.book_path.split(/[\\/]/).pop()}`);
      const body = el('div', 'book-settings-body');

      body.appendChild(el('div', 'preview-meta', '重新选模型 (可选, 保持当前 = 沿用书级绑定/推荐), 并选择重跑范围。'));
      // 模型下拉 (默认保持当前 = 空串)
      const mkSelect = (fam) => {
        const wrap = el('div', 'retry-field');
        wrap.appendChild(el('label', null, famLabels[fam] || fam));
        const sel = document.createElement('select');
        sel.className = 'retry-select';
        const keep = document.createElement('option');
        keep.value = '';
        keep.textContent = '保持当前 (书级绑定/推荐)';
        sel.appendChild(keep);
        (global.AiduModelService.list ? (global.AiduModelService.list() || Promise.resolve({ ok: true, data: [] })) : Promise.resolve({ ok: true, data: [] }))
          .then((res) => {
            const models = (res.ok && res.data) || [];
            models.filter((m) => m.family === fam).forEach((m) => {
              const opt = document.createElement('option');
              opt.value = m.id;
              opt.textContent = (m.model_id || m.id) + (m.active ? ' (推荐)' : '');
              sel.appendChild(opt);
            });
          })
          .catch(() => {});
        wrap.appendChild(sel);
        return { wrap, sel };
      };
      const llm = mkSelect('llm');
      const tts = mkSelect('tts');
      const nlp = mkSelect('nlp');
      body.append(llm.wrap, tts.wrap, nlp.wrap);

      // 重跑范围 (单选) — force_stages 语义与 FORCE_STAGE_CASCADE 对齐
      const scopeWrap = el('div', 'retry-field');
      scopeWrap.appendChild(el('label', null, '重跑范围'));
      const scopes = [
        { v: '', t: '自动', d: '只重跑失败/未完成的句子 (和「重试失败句」一致)' },
        { v: 'translate', t: '从翻译', d: '重跑翻译+讲解' },
        { v: 'explain', t: '从讲解', d: '重跑讲解' },
        { v: 'tts', t: '从语音', d: '重跑语音+对齐' },
        { v: 'all', t: '全部', d: '重跑翻译+讲解+语音+对齐' },
      ];
      const radios = scopes.map((s) => {
        const row = el('label', 'retry-scope-row');
        const r = document.createElement('input');
        r.type = 'radio';
        r.name = 'retry-scope';
        r.value = s.v;
        r.checked = s.v === '';
        r.addEventListener('change', () => {
          radios.forEach((x) => { x.checked = (x === r); });
        });
        row.appendChild(r);
        row.appendChild(el('span', null, s.t + ' — ' + s.d));
        scopeWrap.appendChild(row);
        return r;
      });
      body.appendChild(scopeWrap);

      const actions = el('div', 'modal-actions');
      const startBtn = el('button', 'btn-small btn-primary', '开始重跑');
      startBtn.onclick = () => {
        const sel = radios.find((r) => r.checked);
        // 重跑范围 → force_stages (与 checkpoint FORCE_STAGE_CASCADE 语义一致:
        // 翻译级联讲解, 语音级联对齐; 空 = 自动只跑失败/未完成)
        const FORCE_MAP = {
          translate: ['translate'],
          explain: ['explain'],
          tts: ['tts'],
          all: ['translate', 'explain', 'tts', 'align'],
        };
        const forceStages = (sel && FORCE_MAP[sel.value]) || null;
        startBtn.disabled = true;
        startBtn.textContent = '重排中…';
        AiduJobService.retryCustom(
          job.id,
          llm.sel.value || null,
          tts.sel.value || null,
          nlp.sel.value || null,
          forceStages,
        ).then((r) => {
          if (!r.ok) { startBtn.disabled = false; startBtn.textContent = '开始重跑'; AiduToast.show('重跑失败: ' + r.error, 'error'); return; }
          ov.remove();
          AiduToast.show('已重新排队', 'success');
          this._refreshJobs();
        });
      };
      const close = el('button', 'btn-small', '关闭');
      close.onclick = () => ov.remove();
      actions.append(startBtn, close);
      box.append(title, body, actions);
      ov.appendChild(box);
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
      document.body.appendChild(ov);
    }

    /** K20 (2026-08-14): 已耗时/已完成度线性外推剩余时间。只对 running 且进度落在
     *  [5%, 95%) 时显示——太早样本不够, 接近完成时线性外推容易因收尾阶段变慢而报错。 */
    _formatEta(job, pct) {
      if (job.status !== 'running' || pct < 5 || pct >= 95 || !job.created_at) return '';
      const elapsedMs = Date.now() - job.created_at;
      if (elapsedMs <= 0) return '';
      const totalMs = elapsedMs / (pct / 100);
      const remainMs = totalMs - elapsedMs;
      if (remainMs <= 0) return '';
      const mins = Math.round(remainMs / 60000);
      if (mins < 1) return '约剩 <1 分钟';
      if (mins < 60) return `约剩 ${mins} 分钟`;
      return `约剩 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
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

    /** I1 (2026-08-11): 批次进度并入 _refreshJobs (作为组头人话标签), 原独立批次摘要条已撤。 */

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
