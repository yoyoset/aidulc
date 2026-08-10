/**
 * app.js —— 手机端 UI 控制器 (V7, 2026-08-09)
 * 只依赖 adapter (browserAdapter) + MobileCore; 不依赖 window.__TAURI__。
 * 交互 (设计稿 01b):
 *   - 整卡热区点击翻面 (单向不可逆)
 *   - 背面: 左滑 = 忘了(1), 右滑 = 记得(3)
 *   - 下滑 = 退出复习保留进度
 *   - 长按单词 = 弹操作 (移出生词本/标记已掌握/编辑释义)
 *   - 评分区底部 120px 内, 按钮 56px 高; 翻面后 250ms 才可评分
 *   - 评分后 3 秒可撤销
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const adapter = window.AidulcMobileAdapters.browserAdapter();
  const app = window.makeAidulcMobileApp(adapter);
  const C = window.MobileCore;

  // 复习会话状态
  let queue = [];
  let index = 0;
  let done = 0;
  let flipLock = null;
  let undoStack = null;
  let currentEntry = null;
  let touchStart = null;
  let swipeTimer = null;

  // ---------- 视图切换 ----------
  function show(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  // ---------- 入口 ----------
  async function loadEntry() {
    const words = await app.loadWords();
    const now = Date.now();
    const q = C.buildQueue(words, now);
    queue = q.order;
    index = 0;
    done = 0;
    $('today-num').textContent = q.order.length;
    const c = q.counts || {};
    $('today-chips').innerHTML =
      `<span class="chip">新词 ${c.new}/${c.newTotal || 0}</span>` +
      `<span class="chip">学习中 ${c.learning || 0}</span>` +
      `<span class="chip">复习 ${c.review || 0}</span>`;
    renderWordList(words);
    $('btn-start').disabled = q.order.length === 0;
    updateSyncChip();
  }

  function renderWordList(words) {
    const list = $('word-list');
    list.innerHTML = '';
    words.forEach((w) => {
      const row = document.createElement('div');
      row.className = 'word-row';
      const head = document.createElement('div');
      head.className = 'word-row-head';
      head.innerHTML = `<span class="w-word">${escapeHtml(w.word)}</span><span class="w-meaning">${escapeHtml(w.meaning || '—')}</span>`;
      const sub = document.createElement('div');
      sub.className = 'w-sub';
      sub.textContent = (w.context ? w.context : '') + (w.edition_id ? ' · 《' + w.edition_id + '》' : '');
      row.append(head, sub);
      list.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 同步 ----------
  async function updateSyncChip() {
    // 状态: 已同步 / N 条待推 / 离线 / 失败 (四态)
    const pending = await adapter.storage.getPending();
    const url = await adapter.storage.getWorkerUrl();
    const token = await adapter.storage.getToken();
    const chip = $('sync-chip');
    if (!url || !token) { chip.textContent = '未配置'; chip.className = 'sync-chip s-unconfig'; return; }
    if (pending.length > 0) { chip.textContent = pending.length + ' 条待推'; chip.className = 'sync-chip s-pending'; }
    else { chip.textContent = '已同步'; chip.className = 'sync-chip s-synced'; }
  }

  // ---------- 配对 (P0-C, 2026-08-10) ----------
  // 桌面端二维码: https://aidulc-mobile.pages.dev/#t=<token>&u=<worker_url>
  // 解析 fragment → { token, workerUrl }。URLSearchParams 自动 decode `u=`。
  function parsePairingHash() {
    try {
      const h = location.hash || '';
      if (!h || h === '#') return null;
      const params = new URLSearchParams(h.replace(/^#\??/, ''));
      const token = params.get('t');
      const workerUrl = params.get('u');
      if (!token) return null;
      return { token, workerUrl };
    } catch (e) {
      return null;
    }
  }

  async function openSettings() {
    const url = await adapter.storage.getWorkerUrl();
    const token = await adapter.storage.getToken();
    $('pair-url').value = url || '';
    $('pair-secret').value = '';
    $('pair-status').textContent = (url && token) ? '当前已连接, 可用 ROOT_SECRET/邀请码 换绑。' : '未配置。填 Worker URL + ROOT_SECRET(给自己) 或 6 位码(别人给你)。';
    show('view-settings');
  }

  async function connectPair() {
    const url = $('pair-url').value.trim();
    const secret = $('pair-secret').value.trim();
    const isCode = /^\d{6}$/.test(secret);
    const status = $('pair-status');
    if (!url) { status.textContent = '先填 Worker URL'; return; }
    status.textContent = '连接中…';
    const r = await app.authDevice({
      workerUrl: url,
      rootSecret: isCode ? undefined : (secret || undefined),
      code: isCode ? secret : undefined,
      deviceName: '手机',
    });
    if (r.ok) {
      status.textContent = '已连接: ' + (r.user_name || r.user_id) + ' · ' + (r.device_id || '');
      updateSyncChip();
      loadEntry();
    } else {
      status.textContent = '连接失败: ' + (r.error || '未知错误');
    }
  }

  async function clearPair() {
    await adapter.storage.setToken(null);
    await adapter.storage.setWorkerUrl(null);
    await adapter.storage.setDeviceName(null);
    $('pair-status').textContent = '已清除本地凭据, 当前未配置。';
    $('pair-url').value = '';
    $('pair-secret').value = '';
    updateSyncChip();
    loadEntry();
  }

  async function doSync(auto) {
    const chip = $('sync-chip');
    chip.textContent = '同步中…';
    const r = await app.sync();
    if (r.ok) {
      chip.textContent = '已同步';
      chip.className = 'sync-chip s-synced';
      if (auto) { /* 自动补推后刷新入口 */ loadEntry(); }
    } else if (r.offline) {
      chip.textContent = '离线';
      chip.className = 'sync-chip s-offline';
    } else {
      chip.textContent = '同步失败';
      chip.className = 'sync-chip s-failed';
    }
  }

  // ---------- 复习会话 ----------
  function startReview() {
    const words = queue;
    if (!words.length) return;
    index = 0; done = 0;
    flipLock = new C.FlipLock();
    undoStack = new C.UndoStack();
    show('view-review');
    renderCard();
  }

  function renderCard() {
    if (index >= queue.length) {
      finishReview();
      return;
    }
    currentEntry = queue[index];
    flipLock.next();
    $('card').classList.remove('flipped');
    $('card-front').classList.remove('hidden');
    $('card-back').classList.add('hidden');
    $('front-word').textContent = currentEntry.word;
    $('front-phonetic').textContent = currentEntry.phonetic || '';
    $('front-context').textContent = currentEntry.context || '';
    $('back-word').textContent = currentEntry.word;
    $('back-phonetic').textContent = currentEntry.phonetic || '';
    $('back-meaning').textContent = currentEntry.meaning || '—';
    $('back-pos').textContent = currentEntry.pos || '';
    $('back-context').textContent = currentEntry.context || '';
    // V4/冲突 6: 手机无书包, "跳到原文"不可用 → 点它提示"在电脑上打开" (桌面保留跳转)
    $('ba-hint').classList.add('hidden');
    $('review-count').textContent = `${done} / ${queue.length}`;
    $('progress-fill').style.width = (queue.length ? (done / queue.length) * 100 : 0) + '%';
    // 评分区: 未翻面禁用
    document.querySelectorAll('.grade-btn').forEach((b) => b.classList.add('disabled'));
    document.querySelectorAll('.gtime').forEach((t) => (t.textContent = ''));
    // 调度器预览按钮时间 (不许前端写死)
    const s = { stage: currentEntry.stage, interval_ms: currentEntry.interval_ms || 0, ease_factor: currentEntry.ease_factor, reviews: currentEntry.reviews || 0 };
    const opts = C.intervalOptions(s, Date.now());
    opts.forEach((o) => {
      const t = $(`#grade-row .gtime[data-t="${o.grade}"]`);
      if (t) t.textContent = o.human;
    });
    hideUndo();
  }

  function flip() {
    if (!flipLock || flipLock.isFlipped()) return; // 单向
    const now = Date.now();
    flipLock.flip(now);
    $('card').classList.add('flipped');
    $('card-front').classList.add('hidden');
    $('card-back').classList.remove('hidden');
    // 250ms 后解锁评分
    setTimeout(() => {
      if (flipLock && flipLock.canGrade(Date.now())) {
        document.querySelectorAll('.grade-btn').forEach((b) => b.classList.remove('disabled'));
      }
    }, C.GRADE_LOCK_MS);
  }

  async function grade(g) {
    if (!flipLock || !flipLock.canGrade(Date.now())) return;
    const entry = currentEntry;
    if (!entry) return;
    const before = Object.assign({}, entry);
    const now = Date.now();
    const s = { stage: entry.stage, interval_ms: entry.interval_ms || 0, ease_factor: entry.ease_factor, reviews: entry.reviews || 0 };
    const o = C.applyGrade(s, g, now);
    const updated = C.applyOutcome(entry, o);
    // 本地先写 + 待推
    await app.saveLocal(updated);
    undoStack.push({ entry, before }, now);
    done++; index++;
    renderCard();     // 先渲染下一张 (renderCard 内会 hideUndo)
    showUndo(updated); // 再显示撤销条 (3 秒窗口)
  }

  // ---------- 撤销 (3 秒) ----------
  function showUndo(entry) {
    $('undo-bar').classList.remove('hidden');
    $('undo-bar').dataset.entry = entry.lemma;
    if (swipeTimer) clearTimeout(swipeTimer);
    swipeTimer = setTimeout(hideUndo, C.UNDO_WINDOW_MS);
  }
  function hideUndo() {
    $('undo-bar').classList.add('hidden');
  }

  async function undo() {
    const top = undoStack ? undoStack.undo(Date.now()) : null;
    if (!top) { hideUndo(); return; }
    // 恢复: 把 before 写回本地 + 待推 (撤销也是本地变更, 要重新同步)
    await app.saveLocal(top.before);
    if (index > 0) index--;
    done = Math.max(0, done - 1);
    if (index < queue.length) queue[index] = top.entry;
    else queue.push(top.entry);
    flipLock.next();
    hideUndo();
    renderCard();
  }

  // ---------- 退出 (下滑 / ×) 保留进度 ----------
  function exitReview() {
    show('view-entry');
    loadEntry(); // 进度保留: 重算队列
  }

  function finishReview() {
    $('card').innerHTML = '<div class="done-msg">今日队列完成 · 复习 ' + done + ' 词</div>';
    setTimeout(() => {
      show('view-entry');
      loadEntry();
      doSync(false);
    }, 1200);
  }

  // ---------- 长按操作 ----------
  function openActionSheet() {
    $('action-sheet').classList.remove('hidden');
  }
  function closeActionSheet() {
    $('action-sheet').classList.add('hidden');
  }

  // ---------- 触摸 (整卡翻面 / 左右滑评分 / 下滑退出 / 长按) ----------
  function bindTouch() {
    const card = $('card');
    let startX = 0, startY = 0, longPress = null;
    card.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      longPress = setTimeout(() => { longPress = null; openActionSheet(); }, 500);
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (longPress) { clearTimeout(longPress); longPress = null; }
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 8) {
        card.style.transform = `translateX(${dx}px) rotate(${dx * 0.03}deg)`;
      }
    }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (longPress) { clearTimeout(longPress); longPress = null; }
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      card.style.transform = '';
      const adx = Math.abs(dx), ady = Math.abs(dy);
      // 下滑 = 退出
      if (ady > 80 && ady > adx) { exitReview(); return; }
      // 左滑 = 忘了(1), 右滑 = 记得(3) (仅背面)
      if (flipLock && flipLock.isFlipped() && adx > 70 && adx > ady) {
        if (dx < 0) grade(1); else grade(3);
        return;
      }
      // 短点 = 翻面
      if (adx < 10 && ady < 10) flip();
    }, { passive: true });
    card.addEventListener('click', () => {
      // 鼠标兜底 (测试/桌面)
      if (window.matchMedia && window.matchMedia('(pointer:fine)').matches) flip();
    });
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('btn-start').onclick = startReview;
    $('review-x').onclick = exitReview;
    $('undo-bar').onclick = undo;
    document.querySelectorAll('.grade-btn').forEach((b) => {
      b.onclick = () => grade(Number(b.dataset.grade));
    });
    $('act-remove').onclick = async () => {
      if (currentEntry) {
        const words = await app.loadWords();
        const rest = words.filter((w) => w.lemma !== currentEntry.lemma);
        await adapter.storage.setWords(rest);
        closeActionSheet();
        loadEntry();
      }
    };
    $('act-mastered').onclick = async () => {
      if (currentEntry) {
        const now = Date.now();
        const updated = C.applyOutcome(currentEntry, { stage: 'mastered', interval_ms: C.DAY_8 * 30, ease_factor: currentEntry.ease_factor, reviews: (currentEntry.reviews || 0) + 1, next_review: now + C.DAY_8 * 30, last_review: now, last_grade: 4 });
        await app.saveLocal(updated);
        closeActionSheet();
        renderCard();
      }
    };
    $('act-edit').onclick = () => {
      closeActionSheet();
      const word = currentEntry && currentEntry.word;
      const meaning = prompt('编辑释义 (' + word + '):', currentEntry && currentEntry.meaning || '');
      if (meaning != null && currentEntry) {
        currentEntry.meaning = meaning;
        currentEntry.updated_at = Date.now();
        app.saveLocal(currentEntry);
        renderCard();
      }
    };
    $('act-cancel').onclick = closeActionSheet;
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
      };
    });
    $('sync-chip').onclick = () => doSync(false);
    // P0-C (2026-08-10): 设置页 —— 手动配对 (Worker URL + ROOT_SECRET/6 位码) + 清凭据
    $('settings-back').onclick = () => show('view-entry');
    $('pair-connect').onclick = connectPair;
    $('pair-clear').onclick = clearPair;
    $('nav-mybooks').onclick = () => show('view-entry');
    $('nav-vocab').onclick = () => show('view-entry');
    $('nav-settings').onclick = openSettings;
    // 冲突 6: 手机端"跳到原文/再看一句"都不可用 (无书包) → 提示在电脑上打开 (桌面保留跳转)
    const sourceActionHint = () => {
      $('ba-hint').classList.remove('hidden');
      setTimeout(() => $('ba-hint').classList.add('hidden'), 2500);
    };
    const disabledItems = document.querySelectorAll('.ba-item.ba-disabled');
    disabledItems.forEach((it) => (it.onclick = sourceActionHint));
    $('ba-another').onclick = sourceActionHint;
  }

  // ---------- 启动 ----------
  // P1-E (2026-08-10): 更新提示改为 Service Worker 生命周期驱动。
  // 删掉 P0 的 localStorage 版本比对 (结构上不可能正确: 能读到 BUILD_VERSION 常量时新版本
  // 早已生效, 点击只是写 localStorage + reload, 页面本来就是新的 → 视觉上毫无变化;
  // 首次访问 seen===null 还会误报"有更新")。
  const BUILD_VERSION = (typeof self !== 'undefined' && self.AIDULC_BUILD_VERSION) ||
    (typeof window !== 'undefined' && window.AIDULC_BUILD_VERSION) || 'dev';

  // 注册 SW + 监听更新:
  //   - updatefound → 新 worker 进入 installing; 此时 navigator.serviceWorker.controller
  //     存在 = 确实是"更新"(首次安装时 controller 为空) → 才显示提示条。
  //   - 点提示条 → reg.waiting.postMessage(SKIP_WAITING) → sw.js 收到后 self.skipWaiting()
  //     接管 → controllerchange → 这里 reload, 真正切到新版本。
  //   - 全新设备首次打开: updatefound 时 controller 为空 → 不显示。
  function setupServiceWorker() {
    if (typeof navigator === 'undefined' || typeof navigator.serviceWorker === 'undefined') return;
    const banner = document.getElementById('update-banner');
    let updateTriggered = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 只在新版接管后刷新 (首次安装 controller 从 null → worker 也会触发, 但那次不是"点刷新")
      if (updateTriggered) location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        if (!navigator.serviceWorker.controller) return; // 首次安装, 不是更新
        if (!banner) return;
        banner.classList.remove('hidden');
        banner.onclick = () => {
          updateTriggered = true;
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          else location.reload(); // 新 worker 已直接激活 (异常路径) → 刷新即可
        };
      });
    }).catch(() => { /* SW 注册失败不阻断使用 (离线/隐私模式) */ });
  }

  async function boot() {
    bindTouch();
    bindEvents();
    await app.init();
    // P0-C (2026-08-10): 扫码配对 —— 解析 #t=<token>&u=<worker_url>, 存进 IndexedDB 后
    // 立即 history.replaceState 把 token 从地址栏剥掉 (不残留可复制的密钥)。
    const pair = parsePairingHash();
    if (pair) {
      await app.applyPairing(pair);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      updateSyncChip();
    }
    setupServiceWorker();
    // 尝试自动补推 (离线静默失败, 不打扰)
    await app.sync().catch(() => {});
    await loadEntry();
  }

  // 让 app 暴露内部 (测试 / 调试用)
  window.mobileApp = { app, adapter, C, boot, setupServiceWorker, BUILD_VERSION, parsePairingHash, loadEntry, startReview, grade, undo, exitReview, connectPair, openSettings, clearPair, get state() { return { index, done, queue: queue.slice(), currentEntry }; } };

  boot();
})();
