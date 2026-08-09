/**
 * _smoke_views.mjs —— 视图层改动冒烟测试 (node 直跑, 非 vitest)
 * 与 _smoke_dom.mjs 同一约定: 最小 DOM stub 驱动视图代码路径, 不引入 jsdom。
 * 覆盖 UX 审计 (2026-08-09) 落地改动的关键路径:
 *   - prep_view 移除任务确认 (running/queued/done 三态文案 + 调 job_remove)
 *   - settings_view 外部直达"模型中心" tab (一次性意图, 用后清除)
 *   - library_view 导入卡: 无隐藏 <input type=file>, 点击只触发一次 pickFiles
 *   - library_view 创建译本弹窗: 档案/语言/模型三节标题与控件一一对应 (A1 回归,
 *     曾因"只删重复挂载"误删唯一挂载点导致控件不渲染, 本测试可抓到)
 * 运行: node tests/_smoke_views.mjs (已接入 scripts/check.ps1)
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function makeElement(tag) {
  const classes = new Set();
  const children = [];
  const attrs = {};
  const el = {
    tagName: tag.toUpperCase(), nodeType: 1, dataset: {},
    _children: children,
    style: { setProperty: () => {}, removeProperty: () => {}, cssText: '' },
    textContent: '', title: '', id: '', value: '',
    parentNode: null, innerHTML: '', onclick: null,
    disabled: false, checked: false, files: [], type: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const h = classes.has(c); const w = f === undefined ? !h : !!f; if (w) classes.add(c); else classes.delete(c); return w; },
      contains: (c) => classes.has(c),
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    appendChild(child) {
      if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((c) => c !== child);
      child.parentNode = el; children.push(child); return child;
    },
    append(...ns) { ns.forEach((n) => el.appendChild(n)); },
    prepend(child) {
      if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((c) => c !== child);
      child.parentNode = el; children.unshift(child); return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((c) => c !== child);
      child.parentNode = el;
      const i = ref ? children.indexOf(ref) : -1;
      if (i >= 0) children.splice(i, 0, child); else children.push(child);
      return child;
    },
    removeChild(child) { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); child.parentNode = null; return child; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
        if (el.dataset[camel] !== undefined) return String(el.dataset[camel]);
      }
      return k in attrs ? attrs[k] : null;
    },
    querySelector: (sel) => queryAll(el, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(el, sel),
    addEventListener() {}, removeEventListener() {}, focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}
function matches(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  let rest = sel.trim();
  if (rest[0] && rest[0] !== '.' && rest[0] !== '[') {
    const m = rest.match(/^([a-zA-Z]+)/);
    if (!m) return false;
    if (node.tagName !== m[1].toUpperCase()) return false;
    rest = rest.slice(m[1].length).trim();
  }
  const tokens = rest.match(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g) || [];
  for (const tk of tokens) {
    if (tk[0] === '.') { if (!node.classList.contains(tk.slice(1))) return false; }
    else {
      const m = tk.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/); if (!m) return false;
      const val = node.getAttribute(m[1]);
      if (m[2] === undefined) { if (val === null) return false; } else if (val !== m[2]) return false;
    }
  }
  return true;
}
function queryAll(rootNode, sel) {
  const out = [];
  const walk = (n) => { for (const c of n._children || []) { if (matches(c, sel)) out.push(c); walk(c); } };
  walk(rootNode);
  return out;
}

globalThis.document = {
  createElement: (tag) => makeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  body: makeElement('body'),
  documentElement: makeElement('html'),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.location = { hash: '#/library' };
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.setInterval = () => ({ unref: () => {} });

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function load(rel) { eval(readFileSync(join(root, rel), 'utf8')); }

// ---- 服务 stub (视图只在调用时引用) ----
globalThis.AiduToast = { show: () => {} };
let confirmCaptured = null;
const calls = { remove: [], pickFiles: [] };
globalThis.AiduJobService = {
  list: async () => ({ ok: true, data: [] }),
  remove: async (id) => { calls.remove.push(id); return { ok: true }; },
  pause: async () => ({ ok: true }), resume: async () => ({ ok: true }),
  pauseAll: async () => ({ ok: true }), resumeAll: async () => ({ ok: true }),
  retryFailed: async () => ({ ok: true }), detail: async () => ({ ok: true, data: {} }),
  listBatches: async () => ({ ok: true, data: [] }),
};
globalThis.AiduBridge = {
  invoke: async () => ({ ok: true, data: null }),
  listen: () => () => {},
  pickFiles: async () => { calls.pickFiles.push(1); return { ok: true, data: ['C:/a.epub'] }; },
  openPath: async () => ({ ok: true }),
  library: { list: async () => ({ ok: true, data: [] }), open: async () => ({ ok: true, data: {} }), remove: async () => ({ ok: true }), register: async () => ({ ok: true }) },
  bookpack: { load: async () => ({ ok: true, data: {} }), loadChapter: async () => ({ ok: true, data: {} }), readAudio: async () => ({ ok: true, data: [] }), readImage: async () => ({ ok: true, data: {} }) },
  profiles: { list: async () => ({ ok: true, data: [] }), upsert: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  settings: { get: async () => ({ ok: true, data: {} }), upsert: async () => ({ ok: true }) },
  reading: { save: async () => ({ ok: true }), get: async () => ({ ok: true, data: null }) },
  transfer: { exportData: async () => ({ ok: true, data: {} }), importData: async () => ({ ok: true, data: {} }) },
  highlights: { list: async () => ({ ok: true, data: [] }), save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
};
globalThis.AiduLibraryService = {
  list: async () => ({ ok: true, data: [] }), open: async () => ({ ok: true }),
  remove: async () => ({ ok: true }), loadBookpack: async () => ({ ok: true, data: {} }),
  loadBookpackChapter: async () => ({ ok: true, data: {} }),
  readAudioRange: async () => ({ ok: true, data: { data_b64: '', read: 0, total: 0, end: true } }),
  preview: async () => ({ ok: true, data: {} }), exportBook: async () => ({ ok: true, data: {} }),
  importBook: async () => ({ ok: true, data: {} }),
  // V4: 背单词右栏书名查询
  editionLookup: async (id) => ({ ok: true, data: { id, title: '雪国', chapter_count: 12 } }),
};
globalThis.AiduImportService = {
  getProfile: async () => ({ id: 'default', name: '成人自读', explain_strategy: 'brief', voice: 'af_heart', speed: 1.0, highlight_granularity: 'sentence' }),
  buildProfile: () => ({ id: 'default' }),
  buildModels: async () => ({}),
  importBooks: async (paths) => ({ ok: true, data: { registered: paths, skipped: [] } }),
  startPrep: async () => ({ ok: true, data: {} }),
};
globalThis.AiduModelService = {
  list: async () => ({ ok: true, data: [] }), bookBinding: async () => ({ ok: true, data: {} }),
  bindBook: async () => ({ ok: true }), register: async () => ({ ok: true }),
  setRecommended: async () => ({ ok: true }), remove: async () => ({ ok: true }),
  scan: async () => ({ ok: true, data: [] }), download: async () => ({ ok: true, data: {} }),
  downloadStatus: async () => ({ ok: true, data: { done: true, ok: true } }),
  wizardState: async () => ({ ok: true, data: { status: 'done' } }),
  wizardSubmit: async () => ({ ok: true }), wizardFinish: async () => ({ ok: true }),
};
globalThis.AiduSettingsService = {
  get: async () => ({ ok: true, data: { font_size: 19, line_height: 1.85, content_width: 660, theme: 'light', palette: 'clay' } }),
  upsert: async () => ({ ok: true }),
};
globalThis.AiduSyncService = {
  status: async () => ({ ok: true, data: { configured: false, user_id: 'me', pending_count: 0 } }),
  statusLabel: () => '未配置', configure: async () => ({ ok: true }),
  now: async () => ({ ok: true, data: {} }), pull: async () => ({ ok: true, data: {} }),
  disconnect: async () => ({ ok: true }), authDevice: async () => ({ ok: true, data: { user_id: 'me', device_id: 'd' } }),
  makeCode: async () => ({ ok: true, data: { code: '123456' } }),
};
globalThis.AiduDictionaryService = { list: async () => ({ ok: true, data: [] }), vocabAll: async () => ({ ok: true, data: [] }), lookup: async () => ({ ok: true, data: {} }), addToVocab: async () => ({ ok: true }), vocabRemove: async () => ({ ok: true }), srsPreview: async () => ({ ok: true, data: { options: [1,2,3,4].map((g) => ({ grade: g, human: g + ' 天' })) } }), srsGrade: async (p, l, g) => ({ ok: true, data: {} }), srsRestore: async () => ({ ok: true, data: {} }) };
globalThis.AiduReadingService = { get: async () => ({ ok: true, data: null }), save: async () => ({ ok: true }), stats: async () => ({ ok: true, data: {} }) };
globalThis.AiduMiscService = {
  logPath: async () => ({ ok: true, data: { path: 'C:/log' } }), componentsHealth: async () => ({ ok: true, data: [] }),
  runtimeConfig: async () => ({ ok: true, data: {} }), openPath: async () => ({ ok: true }),
  libraryDirGet: async () => ({ ok: true, data: 'C:/aidulc-data' }), libraryDirPickAndSet: async () => ({ ok: true, data: { cancelled: true } }),
  docParserInstall: async () => ({ ok: true, data: { ok: true } }),
};
globalThis.ModelsView = class { constructor() {} render(c) { c.innerHTML = 'MODELS'; } };
globalThis.AiduVocabStats = { dailyBuckets: () => [] };

// ---- 加载被改动的视图及其依赖 ----
load('app/store.js');
load('components/modal.js');
load('components/toast.js');
load('core/import_guard.js');
load('core/builtin_profiles.js');
load('views/library_view.js');
load('views/prep_view.js');
load('views/settings_view.js');

// modal.js 加载时会覆盖全局 AiduModal, 这里重新装捕获确认的 stub
globalThis.AiduModal = { confirm: (opts) => { confirmCaptured = opts; return { close() {} }; } };

const store = new globalThis.AiduStore();

console.log('== 1. prep_view 移除确认 (running/queued/done 三态) ==');
{
  const pv = new globalThis.PrepView(store);
  pv._listEl = makeElement('div');
  const mk = (status) => ({ id: 'job-x', status, stage: 'translate', current: 3, total: 240, progress: 35, book_path: 'C:/Books/Alice.epub', profile_id: 'default', output_dir: 'C:/out/job-x', error: null, batch_id: null });
  for (const status of ['running', 'queued', 'done']) {
    const row = pv._buildTaskRow(mk(status));
    const removeBtn = queryAll(row, 'button').find((b) => b.textContent === '移除');
    if (!removeBtn) { check('running 行有移除按钮', false, status); continue; }
    removeBtn.onclick();
    check('移除弹窗标题含书名', confirmCaptured && confirmCaptured.title.includes('Alice.epub'), status + ' title=' + (confirmCaptured && confirmCaptured.title));
    check('移除弹窗 danger', confirmCaptured && confirmCaptured.danger === true);
    const warn = confirmCaptured && confirmCaptured.message;
    if (status === 'running') check('running 告知停止并丢进度', warn && warn.includes('立即停止处理并丢弃当前进度'), warn);
    if (status === 'queued') check('queued 告知不再处理', warn && warn.includes('不会再进入处理'), warn);
    if (status === 'done') check('done 仅移除记录', warn && warn.includes('任务记录将从列表移除'), warn);
    const before = calls.remove.length;
    confirmCaptured.onConfirm();
    await Promise.resolve();
    check('确认后调用 job_remove', calls.remove.length === before + 1 && calls.remove.at(-1) === 'job-x');
  }
  // 1b: _updateTask 实时刷新 —— 进度条和百分比标签用后端同一个 progress 值 (2026-08-09 修,
  // 此前条按阶段比例、标签按全书进度两套数字打架)
  const liveRow = pv._buildTaskRow(mk('running'));
  pv._listEl.appendChild(liveRow);
  pv._updateTask({ jobId: 'job-x', type: 'stage_progress', stage: 'translate', current: 100, total: 240, progress: 50 });
  const lf = liveRow.querySelector('.prep-bar-fill');
  const lp = liveRow.querySelector('.prep-pct');
  const ls = liveRow.querySelector('.prep-task-status');
  check('实时进度条与标签一致 (50%)', lf.style.width === '50%' && lp.textContent === '50%', 'fill=' + lf.style.width + ' label=' + lp.textContent);
  check('实时状态中文 (翻译 100/240)', ls.textContent.includes('翻译') && ls.textContent.includes('100/240'), ls.textContent);
}

console.log('== 1c. 批次状态中文映射 (completed → 完成, N3 2026-08-10) ==');
{
  const pv = new globalThis.PrepView(store);
  pv._listEl = makeElement('div');
  const origBatches = globalThis.AiduJobService.listBatches;
  globalThis.AiduJobService.listBatches = async () => ({
    ok: true,
    data: [
      { id: 'batch-x', status: 'completed', total_books: 1, done_books: 1, failed_books: 0 },
      { id: 'batch-y', status: 'running', total_books: 1, done_books: 0, failed_books: 0 },
    ],
  });
  await pv._refreshBatches();
  const rows = queryAll(pv._listEl, '.batch-row');
  const txts = rows.map((r) => {
    const s = r.querySelector('span');
    return s && s.textContent;
  });
  const completed = txts.find((t) => t && t.includes('batch-x'));
  const running = txts.find((t) => t && t.includes('batch-y'));
  check('completed 批次显示中文"完成" (不再是英文 completed)', !!completed && completed.includes('完成'), completed);
  check('running 批次显示"处理中"', !!running && running.includes('处理中'), running);
  globalThis.AiduJobService.listBatches = origBatches;
}

console.log('== 2. settings_view 直达"模型中心" tab ==');
{
  store.state.settingsTab = 'models';
  const sv = new globalThis.SettingsView(store);
  const container = makeElement('div');
  sv.render(container);
  const modelsTab = container.querySelector('.settings-tab[data-tab="models"]');
  check('模型中心 tab 被激活', modelsTab && modelsTab.classList.contains('active'), 'tab=' + (modelsTab && modelsTab.className));
  check('一次性意图已清除', store.state.settingsTab === null, 'settingsTab=' + store.state.settingsTab);
  sv.render(makeElement('div'));
  check('无 settingsTab 时第二次 render 不抛错', true);
}

console.log('== 3. library_view 导入卡: 无隐藏 input, 点击走 pickFiles ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  const card = lv._buildImportCard();
  const inputs = queryAll(card, 'input');
  check('导入卡不再有隐藏文件 input', inputs.length === 0, 'inputs=' + inputs.length);
  const dropZone = card.querySelector('.prep-dropzone');
  check('dropZone 存在且有点击回调', !!dropZone && typeof dropZone.onclick === 'function');
  const before = calls.pickFiles.length;
  dropZone.onclick();
  await new Promise((r) => setTimeout(r, 10));
  check('点击直接触发一次 pickFiles', calls.pickFiles.length === before + 1);
}

console.log('== 4. library_view 创建译本弹窗挂载顺序 (A1 回归) ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  lv._profiles = [{ id: 'default', name: '成人自读' }];
  const book = { id: 'b1', title: 'Alice' };
  lv._chooseEditionProfile(book);
  await new Promise((r) => setTimeout(r, 50));
  const ov = document.body._children.find((c) => c.className && c.className.includes('modal-overlay'));
  check('创建译本弹窗已打开', !!ov);
  if (ov) {
    const body = ov.querySelector('.book-settings-body');
    const order = [];
    for (const c of body._children || []) {
      if (c.className && c.className.includes('settings-hint')) order.push('hint:' + c.textContent.slice(0, 2));
      else if (c.tagName === 'SELECT') order.push('select:profile');
      else if (c.className && c.className.includes('prep-row')) order.push('row:lang/model(' + queryAll(c, 'select').length + ')');
    }
    const seq = order.join(' | ');
    // 学习档案→档案下拉, 语言→语言行(2 select), 模型→模型行(2 select); 其后允许模型告警提示
    check('三节标题与控件一一对应', /hint:学习.*select:profile.*hint:语言.*row:lang\/model\(2\).*hint:模型.*row:lang\/model\(2\)/.test(seq), seq);
  }
}

console.log('== 4b. 默认与预填: 记住上次档案 (2026-08-09) ==');
{
  globalThis.localStorage = { _d: { 'aidulc.lastProfile': 'kid' }, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };
  const lv = new globalThis.LibraryView(store, 'original');
  lv._profiles = [{ id: 'default', name: '成人自读' }, { id: 'kid', name: '陪小孩读' }];
  lv._chooseEditionProfile({ id: 'b2', title: 'Alice 2' });
  await new Promise((r) => setTimeout(r, 50));
  // 取最近打开的弹窗 (前面节次的弹窗未关闭, find 会拿到旧的)
  const ovs = document.body._children.filter((c) => c.className && c.className.includes('modal-overlay'));
  const ov2 = ovs[ovs.length - 1];
  const profileSel = ov2 && queryAll(ov2, 'select').find((s) => (s._children || []).some((o) => o.tagName === 'OPTION' && o.value === 'kid'));
  check('上次选的档案被预选 (kid)', !!profileSel && profileSel.value === 'kid', 'value=' + (profileSel && profileSel.value));
  // 用"开始备料"路径保存选择 (stub bindBook 通过 → onStarted 关闭弹窗)
  const startBtn = ov2 && queryAll(ov2, 'button').find((b) => b.textContent === '开始备料');
  startBtn.onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('开始备料会记住档案选择', globalThis.localStorage.getItem('aidulc.lastProfile') === 'kid');
}


console.log('== 5. 顶栏切人 (V1 身份模型, 2026-08-09) ==');
{
  // 事件总线 stub (users_service / shell_view 需要)
  const _listeners = {};
  globalThis.window.addEventListener = (ev, fn) => { (globalThis.window[ev] = globalThis.window[ev] || []).push(fn); };
  globalThis.window.dispatchEvent = (ev) => { (globalThis.window[ev.type] || []).forEach((fn) => fn(ev)); return true; };
  globalThis.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
  // 加载 shell_view + users_service, stub users_list 返回 me + 孩子
  load('services/users_service.js');
  load('views/shell_view.js');
  globalThis.AiduBridge = Object.assign({}, globalThis.AiduBridge || {}, {
    users: { list: async () => ({ ok: true, data: [
      { id: 'me', name: '我' }, { id: 'u-kid', name: '孩子' },
    ] }) },
  });
  globalThis.AiduUserService = globalThis.AiduUserService;
  globalThis.localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };
  const appEl = makeElement('div');
  const shell = new globalThis.ShellView(appEl);
  shell.render();
  await new Promise((r) => setTimeout(r, 30));
  // 顶栏出现用户下拉且预选当前用户 (默认 me)
  const userSel = queryAll(appEl, 'select').find((s) => s.className.includes('nav-user-select'));
  check('顶栏有用户下拉', !!userSel);
  check('下拉预选默认用户 me', userSel && userSel.value === 'me', 'value=' + (userSel && userSel.value));
  check('下拉含两个孩子选项', userSel && (userSel._children || []).length === 2);
  // 切人 → localStorage 记录新 user + 广播事件
  userSel.value = 'u-kid';
  const events = [];
  globalThis.window.addEventListener('aidulc:user-changed', (e) => events.push(e.detail.id));
  userSel.onchange();
  check('切人写入 localStorage', globalThis.localStorage.getItem('aidulc.current_user') === 'u-kid');
  check('切人广播事件', events.includes('u-kid'));
  // 新实例读当前 user
  check('currentId 返回新 user', globalThis.AiduUserService.currentId() === 'u-kid');
  check('currentName 解析新 user', globalThis.AiduUserService.currentName([{ id: 'me', name: '我' }, { id: 'u-kid', name: '孩子' }]) === '孩子');
}

console.log('== 5b. 顶栏同步四态 (V6, 2026-08-09) ==');
{
  // stub sync_status 返回四态之一, 验证顶栏 chip 文案
  const chipStates = ['synced', 'pending', 'offline', 'failed'];
  for (const st of chipStates) {
    globalThis.AiduSyncService.status = async () => ({ ok: true, data: { status: st, configured: true, pending_count: 3, user_id: 'me' } });
    const appEl = makeElement('div');
    const shell = new globalThis.ShellView(appEl);
    shell.render();
    await new Promise((r) => setTimeout(r, 30));
    const chip = queryAll(appEl, '.nav-sync-chip')[0];
    const text = chip && chip.textContent;
    if (st === 'synced') check('已同步 chip', chip && text === '已同步', text);
    if (st === 'pending') check('N 条待推 chip (不转圈)', chip && text === '3 条待推', text);
    if (st === 'offline') check('离线 chip', chip && text === '离线', text);
    if (st === 'failed') check('失败 chip', chip && text === '同步失败', text);
  }
}

console.log('== 6. 背单词三栏 (V3, 2026-08-09) ==');
{
  load('core/review.js');
  load('views/review_view.js');
  // stub: 3 个词 (到期复习 + 学习 + 新词)
  globalThis.AiduDictionaryService.vocabAll = async () => ({ ok: true, data: [
    { word: 'reticent', lemma: 'reticent', stage: 'review', interval_ms: 3 * 86400000, next_review: Date.now() - 1000, meaning: '沉默寡言的', phonetic: '/r/', context: 'He was reticent about the war.', edition_id: 'e-1', chapter_index: 2, sentence_index: 5 },
    { word: 'bank', lemma: 'bank', stage: 'new', next_review: null, meaning: '银行', context: 'He went to the bank.' },
  ] });
  const reviewCalls = { grade: [], restore: [] };
  globalThis.AiduDictionaryService.srsGrade = async (p, l, g) => { reviewCalls.grade.push([l, g]); return { ok: true, data: {} }; };
  globalThis.AiduDictionaryService.srsRestore = async (p, e) => { reviewCalls.restore.push(e.lemma); return { ok: true, data: {} }; };
  const rv = new globalThis.ReviewView(new globalThis.AiduStore());
  const rc = makeElement('div');
  rv.render(rc);
  await new Promise((r) => setTimeout(r, 60));
  // 队列: 到期复习在前
  check('卡片显示当前词 reticent', rv.queue[0] && rv.queue[0].word === 'reticent', 'q0=' + (rv.queue[0] && rv.queue[0].word));
  check('评分按钮初始禁用 (未翻面)', rv.gradeBtns.every((b) => b.disabled === true));
  check('未翻面 canGrade=false', rv.flipLock.canGrade(Date.now()) === false);
  // 翻面: 单向 + 250ms 锁
  rv._flip();
  check('翻面后 isFlipped=true', rv.flipLock.isFlipped() === true);
  const t0 = Date.now();
  check('翻面瞬间仍锁 (250ms 内)', rv.flipLock.canGrade(t0) === false);
  check('250ms 后解锁', rv.flipLock.canGrade(t0 + 250) === true);
  await new Promise((r) => setTimeout(r, 260));
  check('解锁定时器点亮按钮', rv.gradeBtns.every((b) => b.disabled === false));
  // 评分 → srs_grade 被调 + 进入下一张
  const idxBefore = rv.index;
  rv._grade(3);
  await new Promise((r) => setTimeout(r, 60));
  check('评分调用 srs_grade(reticent,3)', reviewCalls.grade.some(([l, g]) => l === 'reticent' && g === 3));
  check('评分后进入下一张', rv.index === idxBefore + 1, 'idx=' + rv.index);
  check('撤销栈有记录且可撤销', rv.undoStack.canUndo(Date.now()) === true);
  // V3 补充 (2026-08-10): 评分后撤销条必须可见 —— 曾在 _armUndo 后被 _renderCurrent 清掉
  check('评分后撤销条可见', !!rv._undoBar && rv._undoBar.parentNode != null, 'undoBar parent=' + (rv._undoBar && rv._undoBar.parentNode));
  // 撤销 → srs_restore 被调 + 回到上一张
  rv._undo();
  await new Promise((r) => setTimeout(r, 60));
  check('撤销调用 srs_restore', reviewCalls.restore.includes('reticent'));
  check('撤销后回到上一张', rv.queue[rv.index] && rv.queue[rv.index].word === 'reticent', 'q=' + (rv.queue[rv.index] && rv.queue[rv.index].word));
  rv.cleanup();
}

console.log('== 6b. 来源定位右栏 (V4, 2026-08-09) ==');
{
  // 词条带 edition_id → 右栏应显示《书名》·第 N 章 + "在阅读器中打开"
  const rv2 = new globalThis.ReviewView(new globalThis.AiduStore());
  const rc2 = makeElement('div');
  rv2.render(rc2);
  await new Promise((r) => setTimeout(r, 60));
  const locEl = rv2.sourceCol && queryAll(rv2.sourceCol, '.review-source-loc')[0];
  check('右栏出现来源定位块', !!locEl);
  const metaLine = locEl && queryAll(locEl, '.review-source-meta')[0];
  const metaText = metaLine ? metaLine.textContent : '';
  check('右栏显示章节与句位置', metaText.includes('第 3 章') && metaText.includes('第 6 处出现'), 'meta=' + JSON.stringify(metaText));
  const openBtn = locEl && queryAll(locEl, 'button').find((b) => b.textContent.includes('在阅读器中打开'));
  check('有"在阅读器中打开"按钮', !!openBtn);
  // 跳转: onOpenInReader 回调拿到 edition_id/chapter/sentence
  let jumped = null;
  rv2.onOpenInReader = (e) => { jumped = e; };
  openBtn.onclick();
  check('点击触发 onOpenInReader 带定位', jumped && jumped.edition_id === 'e-1' && jumped.chapter_index === 2 && jumped.sentence_index === 5, JSON.stringify(jumped));
  await new Promise((r) => setTimeout(r, 30));
  // 书名异步解析
  const book = rv2.sourceCol.querySelector('.review-source-book');
  check('书名异步解析为《雪国》', book && book.textContent === '《雪国》', book && book.textContent);
  rv2.cleanup();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
