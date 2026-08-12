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
    parentNode: null, onclick: null,
    get innerHTML() { return ''; },
    set innerHTML(v) { if (v === '') children.length = 0; }, // 与真实 DOM 一致: 清空重建
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
    replaceWith(node) {
      if (node.parentNode) node.parentNode._children = node.parentNode._children.filter((c) => c !== node);
      node.parentNode = el.parentNode;
      const i = el.parentNode ? el.parentNode._children.indexOf(el) : -1;
      if (i >= 0) el.parentNode._children[i] = node; else node.parentNode && node.parentNode._children.push(node);
      el.parentNode = null;
      return node;
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
// stub 的 textContent 是普通字符串不聚合子节点, 需要时用这个递归拼接
function textOf(n) {
  if (!n || typeof n !== 'object') return String(n);
  if (n.nodeType === 3) return String(n.textContent || '');
  return String(n.textContent || '') + (n._children || []).map(textOf).join('');
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
  forceFull: async () => ({ ok: true }),
  // L11 (2026-08-11): 多后端 (空列表; 各测试覆盖时自行 stub)
  backendsList: async () => ({ ok: true, data: [] }),
  backendAdd: async () => ({ ok: true }), backendSwitch: async () => ({ ok: true }), backendRemove: async () => ({ ok: true }),
};
globalThis.AiduDictionaryService = { list: async () => ({ ok: true, data: [] }), vocabAll: async () => ({ ok: true, data: [] }), lookup: async () => ({ ok: true, data: {} }), lookupOnline: async () => ({ ok: true, data: ['NOUN', '', ['在线释义'], [], [], '', []] }), addToVocab: async () => ({ ok: true, data: { added: 'x', common_word: false } }), vocabRemove: async () => ({ ok: true }), srsPreview: async () => ({ ok: true, data: { options: [1,2,3,4].map((g) => ({ grade: g, human: g + ' 天' })) } }), srsGrade: async (p, l, g) => ({ ok: true, data: {} }), srsRestore: async () => ({ ok: true, data: {} }), vocabCommonPreview: async () => ({ ok: true, data: { count: 0, top_n: 3000, lemmas: [] } }), vocabRemoveCommon: async () => ({ ok: true, data: { removed: 0, backup_path: '' } }), vocabBacklogPreview: async () => ({ ok: true, data: { backlog_count: 0, daily_cap: 40, days: 0, today_after: 0, today_before: 0 } }), vocabBacklogSpread: async () => ({ ok: true, data: { spread: 0, days: 0, backup_path: '' } }) };
globalThis.AiduReadingService = { get: async () => ({ ok: true, data: null }), save: async () => ({ ok: true }), stats: async () => ({ ok: true, data: {} }) };
globalThis.AiduMiscService = {
  logPath: async () => ({ ok: true, data: { path: 'C:/log' } }), componentsHealth: async () => ({ ok: true, data: [] }),
  runtimeConfig: async () => ({ ok: true, data: {} }), openPath: async () => ({ ok: true }),
  libraryDirGet: async () => ({ ok: true, data: 'C:/aidulc-data' }), libraryDirPickAndSet: async () => ({ ok: true, data: { cancelled: true } }), libraryDirPick: async () => ({ ok: true, data: { cancelled: true } }), libraryDirScan: async () => ({ ok: true, data: { importable: [], existing: [] } }), libraryDirImport: async () => ({ ok: true, data: { imported: 0, failed: [] } }),
  docParserInstall: async () => ({ ok: true, data: { ok: true } }),
  // J0 (2026-08-11): 数据目录 / 迁移 (smoke stub: 无待迁移)
  dataMigrationStatus: async () => ({ ok: true, data: { portable: false, data_dir: 'C:/aidulc', db_path: 'C:/aidulc/data.db', out_dir: 'C:/aidulc/jobs_out', pending: false } }),
  dataMigrationDryRun: async () => ({ ok: true, data: { pending: false } }),
  dataMigrationRun: async () => ({ ok: true, data: { ok: true, restart_required: true, backup_path: 'C:/aidulc/backups/x.aidu-data', out_moved: 0, target_out: 'C:/aidulc/jobs_out', target_db: 'C:/aidulc/data.db' } }),
  onlineConfigGet: async () => ({ ok: true, data: { endpoint: '', model: '', key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigSet: async () => ({ ok: true, data: { saved: true, key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigTest: async () => ({ ok: true, data: { ok: true, reply: 'ok' } }),
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

console.log('== 1c. I1/I4 (2026-08-11): 批次降级为组头人话标签, 不再有独立批次进度条 ==');
{
  const pv = new globalThis.PrepView(store);
  pv._listEl = makeElement('div');
  const origBatches = globalThis.AiduJobService.listBatches;
  const origList = globalThis.AiduJobService.list;
  globalThis.AiduJobService.listBatches = async () => ({
    ok: true,
    data: [
      { id: 'batch-1786205582838-11852-0', status: 'running', total_books: 2, done_books: 1, failed_books: 0, created_at: Date.now() },
    ],
  });
  globalThis.AiduJobService.list = async () => ({
    ok: true,
    data: [
      { id: 'j1', book_path: 'C:/Books/Alice.epub', profile_id: 'default', status: 'running', batch_id: 'batch-1786205582838-11852-0', stage: 'translate', current: 3, total: 240, progress: 35 },
      { id: 'j2', book_path: 'C:/Books/Number the Stars.epub', profile_id: 'default', status: 'queued', batch_id: 'batch-1786205582838-11852-0', stage: '', current: 0, total: 0 },
    ],
  });
  await pv._refreshJobs();
  const heads = queryAll(pv._listEl, '.prep-batch-head');
  const headTexts = heads.map((h) => h.textContent).join(' | ');
  check('组头不显示原始批次 id 片段', !headTexts.includes('1786205582838') && !headTexts.includes('-11852-0'), headTexts);
  check('组头显示人话 (N 本书 · 今天 HH:MM)', /2 本书 · 今天/.test(headTexts), headTexts);
  check('不再渲染独立批次进度条 (.batch-row)', queryAll(pv._listEl, '.batch-row').length === 0);
  check('三段标题出现 (进行中/排队中)', queryAll(pv._listEl, '.prep-section-title').length >= 2);
  // I5: 全局按钮随活跃任务启停 (2 个活跃 → 可用); 无活跃 → 禁用
  pv._pauseAllBtn = makeElement('button');
  pv._resumeAllBtn = makeElement('button');
  await pv._refreshJobs();
  check('有活跃任务时全局按钮可用', pv._pauseAllBtn.disabled === false);
  globalThis.AiduJobService.list = async () => ({ ok: true, data: [{ id: 'j3', book_path: 'C:/Books/old.epub', profile_id: 'default', status: 'done', batch_id: null, stage: '', current: 0, total: 0 }] });
  await pv._refreshJobs();
  check('无活跃任务时全局按钮禁用', pv._pauseAllBtn.disabled === true, 'disabled=' + pv._pauseAllBtn.disabled);
  globalThis.AiduJobService.listBatches = origBatches;
  globalThis.AiduJobService.list = origList;
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

console.log('== 2b. settings 同步区: 邀请新成员 (invite-user, 三项已定 ①) ==');
{
  const makeCalls = [];
  globalThis.AiduSyncService.makeCode = async (userId, type, name) => { makeCalls.push([type, name]); return { ok: true, data: { code: '123456' } }; };
  globalThis.window.prompt = () => '孩子';
  const sv2 = new globalThis.SettingsView(store);
  const container2 = makeElement('div');
  sv2.render(container2);
  // 找到"邀请新成员"按钮
  const buttons = queryAll(container2, 'button');
  const inviteBtn = buttons.find((b) => b.textContent.includes('邀请新成员'));
  check('设置页有"邀请新成员"按钮', !!inviteBtn, 'buttons=' + buttons.map((b) => b.textContent).join(','));
  if (inviteBtn) {
    inviteBtn.onclick();
    await new Promise((r) => setTimeout(r, 30));
    check('点击邀请 → 调 makeCode(invite-user, 名字)', makeCalls.some(([t, n]) => t === 'invite-user' && n === '孩子'), JSON.stringify(makeCalls));
  }
  // 还原 makeCode (后续测试可能用到默认行为)
  globalThis.window.prompt = undefined;
  globalThis.AiduSyncService.makeCode = async () => ({ ok: true, data: { code: '654321' } });
}

console.log('== 2c. L9 (2026-08-11): 阅读显示 tab 是全局设置 (主题/主题色/儿童模式+说明) ==');
{
  // 切到阅读显示 tab
  store.state.settingsTab = 'reading';
  const upserts = [];
  globalThis.AiduSettingsService.upsert = async (s) => { upserts.push(s); return { ok: true }; };
  const sv = new globalThis.SettingsView(store);
  const container = makeElement('div');
  sv.render(container);
  await new Promise((r) => setTimeout(r, 60));
  store.state.settingsTab = null;
  const hints = queryAll(container, '.settings-hint').map((n) => n.textContent).join(' ');
  check('L9: 无只读摘要 (无「在阅读器中调整」按钮)', !queryAll(container, 'button').some((b) => b.textContent.includes('在阅读器中调整')));
  check('L9: 有与档案的边界说明 (显示不影响生成)', hints.includes('显示') && hints.includes('不影响生成'), hints.slice(0, 60));
  // 主题三档: 浅色/深色/跟随系统
  const themeSel = queryAll(container, 'select').find((s) => (s._children || []).some((o) => o.tagName === 'OPTION' && o.value === 'system'));
  check('L9: 主题有「跟随系统」档', !!themeSel && (themeSel._children || []).some((o) => o.textContent === '跟随系统'));
  // 儿童模式说明
  const kidExplain = hints.includes('更大') && hints.includes('对比度') && hints.includes('词级高亮');
  check('L9: 儿童模式写明改了什么 (更大字号/更高对比度/词级高亮)', kidExplain);
  // 改主题 → upsert 被调 (完整 ReaderSettings)
  if (themeSel) { themeSel.value = 'system'; themeSel.onchange && themeSel.onchange(); }
  await new Promise((r) => setTimeout(r, 30));
  check('L9: 选「跟随系统」→ upsert theme=system', upserts.some((u) => u.theme === 'system'), JSON.stringify(upserts));
}

console.log('== 2d. L8 (2026-08-11): 在线引擎两档开关, 默认全关, 无key置灰 ==');
{
  store.state.settingsTab = 'system';
  const onlineCalls = [];
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: 'https://x/v1', model: 'm', key_configured: true, lookup_enabled: false, whole_book_enabled: false } });
  globalThis.AiduMiscService.onlineConfigSet = async (ep, md, key, lookup, whole) => { onlineCalls.push([lookup, whole]); return { ok: true, data: { saved: true, key_configured: true, lookup_enabled: lookup, whole_book_enabled: whole } }; };
  const sv = new globalThis.SettingsView(store);
  const container = makeElement('div');
  sv.render(container);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const checks = queryAll(container, 'input[type="checkbox"]');
  // 找到两个在线开关 (按 label 文本, 只匹配 checkbox)
  const allInputs = queryAll(container, 'input');
  const chk = (labelPart) => allInputs.find((c) => {
    if (c.type !== 'checkbox') return false;
    const p = c.parentNode;
    if (!p) return false;
    const labelText = (p._children || []).map((x) => String(x.textContent || '')).join('');
    return labelText.includes(labelPart);
  });
  const lookupCb = chk('查词失败时可用在线 AI');
  const wholeCb = chk('整本翻译/讲解');
  check('L8: 有①查词开关', !!lookupCb);
  check('L8: 有②整本开关', !!wholeCb);
  check('L8: 两档默认关', lookupCb && !lookupCb.checked && wholeCb && !wholeCb.checked);
  check('L8: key已配置时开关可点', lookupCb && !lookupCb.disabled);
  lookupCb && (lookupCb.checked = true);
  lookupCb && lookupCb.onchange();
  await new Promise((r) => setTimeout(r, 30));
  check('L8: 开①→ onlineConfigSet(lookup=true)', onlineCalls.some(([l]) => l === true), JSON.stringify(onlineCalls));
  // 未配置 key → 开关置灰
  const getCalls = [];
  globalThis.AiduMiscService.onlineConfigGet = async () => { getCalls.push('get'); return { ok: true, data: { endpoint: '', model: '', key_configured: false, lookup_enabled: false, whole_book_enabled: false } }; };
  store.state.settingsTab = 'system';
  const sv2 = new globalThis.SettingsView(store);
  const c2 = makeElement('div');
  sv2.render(c2);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const lk2 = queryAll(c2, 'input').find((x) => {
    if (x.type !== 'checkbox') return false;
    const p = x.parentNode;
    if (!p) return false;
    return (p._children || []).map((y) => String(y.textContent || '')).join('').includes('查词');
  });
  check('L8: 无 key 时开关置灰', lk2 && lk2.disabled === true, 'disabled=' + (lk2 && lk2.disabled));
}

console.log('== 2d2. L8 (2026-08-11): 查词失败面板 —— 开关①开才有在线入口, 关则无 ==');
{
  load('components/dictionary_panel.js');
  globalThis.AiduDictionaryService.lookup = async () => ({ ok: true, data: { word: 'reticent', pos: '', phonetic: '', meanings: ['词义查询失败: 词典守护超时'], examples: [], example_zh: '', usage: '', phrases: [] } });
  globalThis.AiduDictionaryService.lookupOnline = async (w) => ({ ok: true, data: ['NOUN', '', ['在线释义'], [], [], '', []] });
  // ① 关: 面板无「用在线 AI 查一次」
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: 'https://x/v1', model: 'm', key_configured: true, lookup_enabled: false, whole_book_enabled: false } });
  const p1 = new globalThis.DictionaryPanel();
  p1.body = makeElement('div');
  p1._word = 'reticent'; p1._context = 'He was reticent.';
  p1._setError('词义查询失败: 词典守护超时');
  await new Promise((r) => setTimeout(r, 40));
  check('L8: 开关①关 → 面板无在线入口', !queryAll(p1.body, 'button').some((b) => b.textContent === '用在线 AI 查一次'), 'btns=' + queryAll(p1.body, 'button').map((b) => b.textContent).join(','));
  // ① 开: 面板出现「用在线 AI 查一次」+ 点它发前显示将发送内容
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: 'https://x/v1', model: 'm', key_configured: true, lookup_enabled: true, whole_book_enabled: false } });
  const p2 = new globalThis.DictionaryPanel();
  p2.body = makeElement('div');
  p2._word = 'reticent'; p2._context = 'He was reticent.';
  p2._setError('词义查询失败: 词典守护超时');
  await new Promise((r) => setTimeout(r, 40));
  const onlineBtn = queryAll(p2.body, 'button').find((b) => b.textContent === '用在线 AI 查一次');
  check('L8: 开关①开 → 面板有在线入口', !!onlineBtn);
  onlineBtn && onlineBtn.onclick();
  await new Promise((r) => setTimeout(r, 20));
  const sendHint = queryAll(p2.body, '.dict-online-send')[0];
  check('L8: 发前显示"将发送" (外发内容可见)', sendHint && String(sendHint.textContent).includes('将发送'), 'hint=' + (sendHint && sendHint.textContent));
}

console.log('== 2e. L7 (2026-08-11): 加载已有书库 —— 扫描→确认→登记, 不移动文件 ==');
{
  store.state.settingsTab = 'system';
  confirmCaptured = null;
  const scanCalls = [];
  const importCalls = [];
  globalThis.AiduMiscService.libraryDirPick = async () => ({ ok: true, data: { cancelled: false, path: 'D:/ext-lib' } });
  globalThis.AiduMiscService.libraryDirScan = async (dir) => { scanCalls.push(dir); return { ok: true, data: { dir, importable: [{ id: 'b1_default', title: 'Alice', profile_id: 'default', pack_dir: 'D:/ext-lib/jobs/job-1' }], existing: [{ id: 'b2_default', title: 'Old', profile_id: 'default', pack_dir: 'D:/ext-lib/jobs/job-2' }] } }; };
  globalThis.AiduMiscService.libraryDirImport = async (packs) => { importCalls.push(packs); return { ok: true, data: { imported: packs.length, failed: [] } }; };
  const sv = new globalThis.SettingsView(store);
  const container = makeElement('div');
  try { sv.render(container); } catch (e) { console.log('DEBUG render threw:', e && e.message); }
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const allBtns = queryAll(container, 'button').map((b) => b.textContent);
  const loadBtn = queryAll(container, 'button').find((b) => b.textContent && b.textContent.includes('加载已有书库'));
  check('L7: 有「加载已有书库…」按钮', !!loadBtn, 'btns=' + allBtns.join(','));
  loadBtn && loadBtn.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('L7: 点击 → pick 目录 → scan(dir)', scanCalls.join(',') === 'D:/ext-lib', scanCalls.join(','));
  check('L7: 确认弹窗出现 (登记前让用户确认)', confirmCaptured && confirmCaptured.title && String(confirmCaptured.title).includes('登记外部书库'), confirmCaptured && confirmCaptured.title);
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 40));
  check('L7: 确认后调 import (只登记)', importCalls.length === 1 && importCalls[0].length === 1, JSON.stringify(importCalls));
}

console.log('== 2f. L11 (2026-08-11): 多后端列表 —— 当前高亮 / 切换 / 新增 ==');
{
  store.state.settingsTab = 'sync';
  const backendCalls = { list: [], add: [], sw: [], rm: [] };
  globalThis.AiduSyncService.backendsList = async () => {
    backendCalls.list.push(1);
    return { ok: true, data: [
      { name: '默认后端', url: 'https://a.workers.dev', active: true, connected: true },
      { name: '家里', url: 'https://b.workers.dev', active: false, connected: false },
    ] };
  };
  globalThis.AiduSyncService.backendAdd = async (name, url) => { backendCalls.add.push([name, url]); return { ok: true }; };
  globalThis.AiduSyncService.backendSwitch = async (name) => { backendCalls.sw.push(name); return { ok: true }; };
  globalThis.AiduSyncService.backendRemove = async (name) => { backendCalls.rm.push(name); return { ok: true }; };
  const sv = new globalThis.SettingsView(store);
  const container = makeElement('div');
  sv.render(container);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const rows = queryAll(container, '.sync-backend-row');
  check('L11: 后端列表渲染 2 行', rows.length === 2, 'rows=' + rows.length);
  const activeRow = rows[0];
  check('L11: 当前后端高亮 (active)', activeRow && activeRow.className.includes('active'));
  check('L11: 当前后端无「切换/删除」按钮', rows[0] && queryAll(rows[0], 'button').length === 0);
  const homeRow = rows[1];
  const swBtn = homeRow && queryAll(homeRow, 'button').find((b) => b.textContent === '切换');
  const rmBtn = homeRow && queryAll(homeRow, 'button').find((b) => b.textContent === '删除');
  check('L11: 非当前后端有「切换/删除」', !!swBtn && !!rmBtn);
  swBtn && swBtn.onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('L11: 点切换 → backendSwitch(家里)', backendCalls.sw.join(',') === '家里', backendCalls.sw.join(','));
  rmBtn && rmBtn.onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('L11: 点删除 → backendRemove(家里)', backendCalls.rm.join(',') === '家里', backendCalls.rm.join(','));
  // 新增
  const nameInput = queryAll(container, 'input').find((i) => i.placeholder === '名称 (如 家里的 / 单位 的)');
  const urlInput2 = queryAll(container, 'input').find((i) => i.placeholder === 'Worker URL');
  const addBtn2 = queryAll(container, 'button').find((b) => b.textContent === '新增后端');
  nameInput && (nameInput.value = '单位');
  urlInput2 && (urlInput2.value = 'https://c.workers.dev');
  addBtn2 && addBtn2.onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('L11: 新增 → backendAdd(单位, url)', backendCalls.add.some(([n, u]) => n === '单位' && u === 'https://c.workers.dev'), JSON.stringify(backendCalls.add));
}

console.log('== 3. library_view 导入格 (G1): 网格最后一格, 无下拉, 点击走 pickFiles ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  const cell = lv._buildImportGridCell();
  const inputs = queryAll(cell, 'input');
  const selects = queryAll(cell, 'select');
  check('导入格无隐藏文件 input', inputs.length === 0, 'inputs=' + inputs.length);
  check('导入格无档案/语言下拉 (参数只在创建译本弹窗)', selects.length === 0, 'selects=' + selects.length);
  const dropZone = cell.querySelector('.import-grid-drop');
  check('dropZone 存在且有点击回调', !!dropZone && typeof dropZone.onclick === 'function');
  const before = calls.pickFiles.length;
  dropZone.onclick();
  await new Promise((r) => setTimeout(r, 10));
  check('点击直接触发一次 pickFiles', calls.pickFiles.length === before + 1);
}

console.log('== 3b. G2 (2026-08-11): 每张书卡至多一个主按钮 (.btn-primary ≤ 1) ==');
{
  load('core/title_cleanup.js');
  const lv = new globalThis.LibraryView(store, 'original');
  const listEl = makeElement('div');
  const bookWithEditions = {
    id: 's1', title: 'Alice (Lewis Carroll) (z-library.sk).epub', kind: 'original', status: 'done',
    source_language: 'en', chapter_count: 0, failed_count: 0,
    editions: [
      { id: 'e1', title: 'Alice 译本', status: 'ready', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' },
    ],
  };
  lv._profiles = [{ id: 'default', name: '成人自读' }];
  lv._renderBooks(listEl, [bookWithEditions], makeElement('input'), null);
  const cards = queryAll(listEl, '.book-card');
  const editionCards = queryAll(listEl, '.edition-card');
  check('渲染出书卡', cards.length >= 1, 'cards=' + cards.length);
  // G2: 主卡自己的操作区 (book-card-actions 直系) 至多 1 个 btn-primary; 每个译本子卡各自 ≤1。
  const mainActions = cards.map((c) => c.querySelector(':scope > .book-card-actions'));
  const mainPrimary = mainActions.map((a) => a ? queryAll(a, '.btn-primary').length : 0);
  check('主卡操作区 btn-primary ≤ 1', mainPrimary.every((n) => n <= 1), 'main=' + mainPrimary.join(','));
  const editionPrimary = editionCards.map((c) => queryAll(c, '.btn-primary').length);
  check('译本子卡各自 btn-primary ≤ 1', editionPrimary.every((n) => n <= 1), 'edition=' + editionPrimary.join(','));
  // G5: 书名清洗剥掉来源站后缀 + 作者拆出
  const titleEl = cards[0] && cards[0].querySelector('.book-card-title');
  const authorEl = cards[0] && cards[0].querySelector('.book-card-author');
  check('书名清洗剥掉来源站后缀', titleEl && !titleEl.textContent.includes('z-library'), 'title=' + (titleEl && titleEl.textContent));
  check('作者拆出 (Lewis Carroll)', authorEl && authorEl.textContent === 'Lewis Carroll', 'author=' + (authorEl && authorEl.textContent));
  // G3: 译本列表默认折叠
  const editionBody = cards[0] && cards[0].querySelector('.edition-body');
  check('译本列表默认折叠', editionBody && editionBody.className.includes('collapsed'));
  // G6: 主按钮措辞统一为「创建译本」
  const createBtn = cards[0] && queryAll(cards[0], '.btn-primary').find((b) => b.textContent === '创建译本');
  check('主按钮叫「创建译本」(无译本时也统一)', !!createBtn, 'primary=' + (cards[0] && queryAll(cards[0], '.btn-primary').map((b) => b.textContent).join(',')));
}

console.log('== 3c. L2 (2026-08-11): 成品文件缺失 → 红色徽章 + 重新生成/移除两个出口 ==');
{
  const lv = new globalThis.LibraryView(store, 'product');
  const listEl = makeElement('div');
  const missingBook = {
    id: 'e1', title: 'Number the Stars 译本', kind: 'product', status: 'ready',
    pack_state: 'missing', source_id: 's1', profile_id: 'default', chapter_count: 12,
  };
  lv._profiles = [{ id: 'default', name: '成人自读' }];
  lv._renderBooks(listEl, [missingBook], makeElement('input'), null);
  const cards = queryAll(listEl, '.book-card');
  const badge = cards[0] && cards[0].querySelector('.book-badge.badge-err');
  check('成品文件缺失显示红色徽章', badge && badge.textContent.includes('缺失'), 'badge=' + (badge && badge.textContent));
  // M1-a (2026-08-12, 教训 8): 断言用户可见的最终 DOM —— 徽章文案是「成品文件缺失」,
  // 且不再同时出现「已就绪」(状态徽章被 pack_state 覆盖)。
  check('M1-a: 徽章文案是「成品文件缺失」且无「已就绪」', badge && badge.textContent === '成品文件缺失' &&
    !(cards[0].textContent || '').includes('已就绪'), 'badge=' + (badge && badge.textContent));
  const regen = cards[0] && queryAll(cards[0], '.btn-primary').find((b) => b.textContent === '重新生成译本');
  const rm = cards[0] && queryAll(cards[0], 'button').find((b) => b.textContent === '移除这个译本记录');
  check('有「重新生成译本」出口', !!regen);
  check('有「移除这个译本记录」出口', !!rm);
  check('不再显示「打开阅读」(数据没了不能假装可读)', !queryAll(cards[0] || {}, 'button').some((b) => b.textContent === '打开阅读'), 'btns=' + queryAll(cards[0] || {}, 'button').map((b) => b.textContent).join(','));
  // 移除出口要确认弹窗 (不静默)
  rm.onclick();
  check('移除前弹确认 (不静默删)', confirmCaptured && confirmCaptured.confirmText === '移除', 'confirm=' + (confirmCaptured && confirmCaptured.title));
  // M1-c (2026-08-12): 点「重新生成译本」→ 走创建译本流程 (模态出现, 标题带书名)。
  const ovsBefore = (document.body._children || []).filter((c) => c.className && c.className.includes('modal-overlay')).length;
  regen.onclick();
  await new Promise((r) => setTimeout(r, 60));
  const ovsAfter = (document.body._children || []).filter((c) => c.className && c.className.includes('modal-overlay'));
  check('M1-c: 点「重新生成译本」→ 创建译本模态出现', ovsAfter.length > ovsBefore,
    'before=' + ovsBefore + ' after=' + ovsAfter.length);
  const regenTitle = ovsAfter[ovsAfter.length - 1] && ovsAfter[ovsAfter.length - 1].querySelector('.modal-title');
  check('M1-c: 模态标题带书名 (重新生成 = 复用创建流程)', regenTitle && String(regenTitle.textContent).includes('创建译本') &&
    String(regenTitle.textContent).includes('Number the Stars'), regenTitle && regenTitle.textContent);
  // 清理这个模态, 不干扰后续断言
  const lastOv = ovsAfter[ovsAfter.length - 1];
  if (lastOv && lastOv.remove) lastOv.remove();
}

console.log('== 3d. M1 (2026-08-12): 原版书卡 pack_state 聚合标红 + 译本折叠切对元素 ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  const listEl = makeElement('div');
  // 后端 M1-a: book.pack_state 由 editions 聚合 (任一 missing → 标红)
  const origBook = {
    id: 's1', title: 'Alice (Lewis Carroll).epub', kind: 'original', status: 'done',
    source_language: 'en', pack_state: 'missing',
    editions: [
      { id: 'e1', title: 'Alice 译本', status: 'ready', pack_state: 'missing', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' },
    ],
  };
  const okBook = {
    id: 's2', title: 'Number the Stars.epub', kind: 'original', status: 'done',
    source_language: 'en', pack_state: 'ok',
    editions: [
      { id: 'e2', title: 'Number the Stars 译本', status: 'ready', pack_state: 'ok', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' },
    ],
  };
  lv._profiles = [{ id: 'default', name: '成人自读' }];
  lv._renderBooks(listEl, [okBook, origBook], makeElement('input'), null);
  const cards = queryAll(listEl, '.book-card');
  const origCard = cards.find((c) => c.querySelector && c.querySelector('.book-card-title') && c.querySelector('.book-card-title').textContent === 'Alice');
  const okCard = cards.find((c) => c.querySelector && c.querySelector('.book-card-title') && c.querySelector('.book-card-title').textContent === 'Number the Stars');
  // M1-a (教训 8, 断言的 DOM 选择器 + 文案):
  const origBadge = origCard && origCard.querySelector('.book-badge.badge-err');
  check('M1-a: 有缺失译本的原版书卡徽章 = 红色「成品文件缺失」', origBadge && origBadge.textContent === '成品文件缺失' && origBadge.className.includes('badge-err'),
    'badge=' + (origBadge && origBadge.textContent) + ' class=' + (origBadge && origBadge.className));
  check('M1-a: 该卡不再显示「已就绪」', origCard && !(origCard.textContent || '').includes('已就绪'), 'text=' + (origCard && origCard.textContent));
  check('M1-a: 全部 ok 的原版书卡不标红', okCard && !(okCard.textContent || '').includes('成品文件缺失'), 'text=' + (okCard && okCard.textContent));
  check('M1-a: 该卡有错误提示行 (.book-card-err-hint)', origCard && !!origCard.querySelector('.book-card-err-hint'));
  // M1-b (教训 8, 断言的 DOM 选择器 + 类名): 点 .edition-toggle → .edition-body 无 collapsed
  const toggle = origCard && origCard.querySelector('.edition-toggle');
  const body = origCard && origCard.querySelector('.edition-body');
  check('M1-b: 译本列表默认折叠 (.edition-body 含 collapsed)', body && body.className.includes('collapsed'));
  toggle.onclick();
  check('M1-b: 点折叠开关 → .edition-body 不含 collapsed (内容展开)', body && !body.className.includes('collapsed'), 'class=' + (body && body.className));
  check('M1-b: 展开后箭头变 ▾ (展开=下箭头)', toggle && toggle.textContent.includes('▾'), toggle && toggle.textContent);
  toggle.onclick();
  check('M1-b: 再点 → .edition-body 恢复 collapsed', body && body.className.includes('collapsed'), 'class=' + (body && body.className));
  check('M1-b: 折叠后箭头变 ▸', toggle && toggle.textContent.includes('▸'), toggle && toggle.textContent);
  // M1-c: 展开后红色子卡的两个出口 (重新生成/移除)
  const childCard = origCard && origCard.querySelector('.edition-card');
  const childRegen = childCard && queryAll(childCard, 'button').find((b) => b.textContent === '重新生成译本');
  const childRm = childCard && queryAll(childCard, 'button').find((b) => b.textContent === '移除这个译本记录');
  check('M1-c: 展开的红色子卡有两个出口', !!childRegen && !!childRm);
  confirmCaptured = null;
  childRm && childRm.onclick();
  check('M1-c: 子卡移除有确认弹窗', confirmCaptured && confirmCaptured.confirmText === '移除');
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

console.log('== 4c. L10 (2026-08-11): 书设置弹窗有学习档案 + 影响下次生成说明 ==');
{
  // 书设置弹窗: 档案/语言/模型 三段, 且有一句"影响下次生成、不动已生成译本"的边界说明。
  const lv = new globalThis.LibraryView(store, 'original');
  lv._profiles = [{ id: 'default', name: '成人自读' }, { id: 'kid', name: '陪小孩读' }];
  const setProfileCalls = [];
  globalThis.AiduLibraryService.setBookProfile = async (id, pid) => { setProfileCalls.push([id, pid]); return { ok: true }; };
  const book = { id: 's1', title: 'Alice', profile_id: 'default', source_language: 'en', target_language: 'zh-CN' };
  lv._openBookSettings(book);
  await new Promise((r) => setTimeout(r, 80));
  const ovs = document.body._children.filter((c) => c.className && c.className.includes('modal-overlay'));
  const ov = ovs[ovs.length - 1];
  const body = ov && ov.querySelector('.book-settings-body');
  // 边界说明是 body 第一句 settings-warn (stub 的 textContent 不聚合子节点, 逐节点找)
  const warnHints = body ? queryAll(body, '.settings-warn') : [];
  const boundaryText = warnHints.map((n) => n.textContent).join(' ').replace(/\s+/g, '');
  check('L10: 弹窗有一句边界说明 (影响下次生成/不动已生成译本)', boundaryText.includes('下次生成') && boundaryText.includes('已生成的译本'), 'text=' + boundaryText.slice(0, 80));
  const profileSel = ov && queryAll(ov, 'select').find((s) => (s._children || []).some((o) => o.tagName === 'OPTION' && o.value === 'kid'));
  check('L10: 有学习档案下拉', !!profileSel);
  if (profileSel) profileSel.value = 'kid';
  const saveBtn = ov && queryAll(ov, 'button').find((b) => b.textContent === '保存');
  saveBtn && saveBtn.onclick();
  await new Promise((r) => setTimeout(r, 30));
  check('L10: 保存调 setBookProfile(s1,kid)', setProfileCalls.some(([id, pid]) => id === 's1' && pid === 'kid'), JSON.stringify(setProfileCalls));
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
  check('下拉含两个孩子选项', userSel && (userSel._children || []).length === 3);
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

  // ---- S4 (2026-08-10): 下拉含"＋ 新建成员", 选项文字无 ▾, 取消新建回滚 ----
  const newOpt = (userSel._children || []).find((o) => o.textContent === '＋ 新建成员');
  check('下拉含"＋ 新建成员"项', !!newOpt);
  check('选项文字不硬拼 ▾', (userSel._children || []).every((o) => !String(o.textContent).includes('▾')));
  // 取消新建: 选"＋ 新建成员"后 prompt 返回空 → value 回滚到当前 user
  globalThis.window.prompt = () => '';
  userSel.value = '__new__';
  userSel.onchange();
  check('取消新建后 value 回滚到当前 user', userSel.value === 'u-kid', 'value=' + userSel.value);
  // 新建成功: prompt 返回名字 → users.create 被调 → 切到新成员
  const created = [];
  globalThis.AiduBridge.users.create = async (name) => { created.push(name); return { ok: true, data: { id: 'u-son', name } }; };
  globalThis.window.prompt = () => '儿子';
  const newApp = makeElement('div');
  const shell2 = new globalThis.ShellView(newApp);
  shell2.render();
  await new Promise((r) => setTimeout(r, 30));
  const userSel2 = queryAll(newApp, 'select').find((s) => s.className.includes('nav-user-select'));
  userSel2.value = '__new__';
  userSel2.onchange();
  await new Promise((r) => setTimeout(r, 50));
  check('新建成员调用 users.create', created.includes('儿子'), JSON.stringify(created));
  check('新建后当前 user 切到新成员', globalThis.AiduUserService.currentId() === 'u-son', 'current=' + globalThis.AiduUserService.currentId());
  // 新成员同步状态应显示"同步未连接" (没 token) —— 由 users_service 无 token + sync chip 兜底
  check('新建成员后 currentName 解析', globalThis.AiduUserService.currentName([{ id: 'u-son', name: '儿子' }, { id: 'me', name: '我' }]) === '儿子');
}

console.log('== 5b. 顶栏同步四态 (V6, 2026-08-09; L6 图标+tooltip) ==');
{
  //  stub sync_status 返回四态之一, 验证顶栏同步图标 tooltip (L6: 不再用文字块)
  const chipStates = ['synced', 'pending', 'offline', 'failed'];
  for (const st of chipStates) {
    globalThis.AiduSyncService.status = async () => ({ ok: true, data: { status: st, configured: true, pending_count: 3, user_id: 'me' } });
    const appEl = makeElement('div');
    const shell = new globalThis.ShellView(appEl);
    shell.render();
    await new Promise((r) => setTimeout(r, 30));
    const chip = queryAll(appEl, '.nav-sync')[0];
    const tip = chip && chip.title;
    if (st === 'synced') check('已同步 tooltip', chip && tip === '已同步', tip);
    if (st === 'pending') check('N 条待推 tooltip (不转圈)', chip && tip === '3 条待推', tip);
    if (st === 'offline') check('离线 tooltip', chip && tip === '离线', tip);
    if (st === 'failed') check('失败 tooltip', chip && tip === '同步失败', tip);
  }
  // P0-B (2026-08-10): unconfigured 文案改"同步未连接" + 点击直达设置同步区
  globalThis.AiduSyncService.status = async () => ({ ok: true, data: { status: 'unconfigured', configured: false, pending_count: 0, user_id: 'me' } });
  const appElU = makeElement('div');
  const shellU = new globalThis.ShellView(appElU);
  const storeU = new globalThis.AiduStore();
  shellU.setStore(storeU);
  let routedU = null;
  shellU.setRouter({ navigate: (r) => { routedU = r; } });
  shellU.render();
  await new Promise((r) => setTimeout(r, 30));
  const chipU = queryAll(appElU, '.nav-sync')[0];
  check('未配置 tooltip 是 同步未连接', chipU && chipU.title === '同步未连接', 'title=' + (chipU && chipU.title));
  chipU.onclick();
  check('点击 chip → settingsTab=sync 意图', storeU.state.settingsTab === 'sync', 'settingsTab=' + storeU.state.settingsTab);
  check('点击 chip → 跳设置页', routedU === 'settings', 'routed=' + routedU);
}

console.log('== 5b. H1/L6 (2026-08-11): 顶栏两个每日目的地, 无「背单词」无「导入」 ==');
{
  const navEl = makeElement('div');
  const sh = new globalThis.ShellView(navEl);
  sh.setRouter({ navigate: () => {} });
  sh.render();
  const links = queryAll(navEl, '.app-nav-link');
  const labels = links.map((b) => b.textContent);
  check('顶栏有 我的书', labels.includes('我的书'), labels.join(','));
  check('顶栏有 生词本', labels.includes('生词本'), labels.join(','));
  check('顶栏没有 背单词 (已并入生词本)', !labels.includes('背单词'), labels.join(','));
  check('L6: 顶栏没有 导入 (书库已有导入格)', !labels.includes('导入'), labels.join(','));
  // L6: 右侧是定宽图标按钮 (处理中/同步/设置), 不混用文字按钮
  const icons = queryAll(navEl, '.app-nav-icon');
  const iconNames = icons.map((b) => b.querySelector && b.querySelector('.icon-msr') && b.querySelector('.icon-msr').textContent);
  check('L6: 右侧图标按钮 ≥ 3 (处理中/同步/设置)', icons.length >= 3, 'icons=' + iconNames.join(','));
  const prepIcon = icons.find((b) => b.querySelector && b.querySelector('.icon-msr') && b.querySelector('.icon-msr').textContent === 'progress_activity');
  check('L6: 处理中图标带角标', prepIcon && prepIcon.querySelector && prepIcon.querySelector('.nav-count') && prepIcon.querySelector('.nav-count').textContent === '0', 'badge=' + (prepIcon && prepIcon.querySelector && prepIcon.querySelector('.nav-count') && prepIcon.querySelector('.nav-count').textContent));
  check('L6: 设置图标是 icon 不是文字 ⚙', iconNames.includes('settings'), iconNames.join(','));
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

console.log('== 6c. E: 今日队列上限 + 折叠 (UX 2026-08-11) ==');
{
  // 1424 词全到期 → 队列 1424 行; 布局修复后左栏内部滚动, 队列不该一次铺开 1424 行
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 1424; i++) {
    many.push({ word: 'w' + i, lemma: 'w' + i, stage: 'review', interval_ms: 3 * 86400000, next_review: now - 1000, meaning: 'm', context: 'c' });
  }
  globalThis.AiduDictionaryService.vocabAll = async () => ({ ok: true, data: many });
  const rv3 = new globalThis.ReviewView(new globalThis.AiduStore());
  const rc3 = makeElement('div');
  rv3.render(rc3);
  await new Promise((r) => setTimeout(r, 80));
  check('队列全量 1424', rv3.queue.length === 1424, 'len=' + rv3.queue.length);
  const rows = queryAll(rv3._queueList, '.review-qrow');
  check('默认折叠: 只渲染 50 行', rows.length === 50, 'rows=' + rows.length);
  const moreBtn = queryAll(rv3._queueList, '.review-qmore')[0];
  check('出现「还有 N 词已折叠」按钮', !!moreBtn && moreBtn.textContent.includes('1374'), moreBtn && moreBtn.textContent);
  moreBtn.onclick();
  const rows2 = queryAll(rv3._queueList, '.review-qrow');
  check('点展开 → 渲染全量 1424 行', rows2.length === 1424, 'rows=' + rows2.length);
  check('展开后折叠按钮消失', queryAll(rv3._queueList, '.review-qmore').length === 0);
  rv3.cleanup();
}

console.log('== 6d. L3/M2 (2026-08-11/12): 点「开始复习」触发重渲染 ==');
{
  load('views/vocab_view.js');
  globalThis.AiduDictionaryService.vocabAll = async () => ({ ok: true, data: [
    { word: 'reticent', lemma: 'reticent', stage: 'review', interval_ms: 3 * 86400000, next_review: Date.now() - 1000, meaning: '沉默寡言的', context: 'He was reticent.', edition_id: 'e-1', chapter_index: 2, sentence_index: 5 },
  ] });
  const navCalls = [];
  const fakeRouter = { navigate: (r) => navCalls.push(r) };
  const storeV = new globalThis.AiduStore();
  const vv = new globalThis.VocabView(storeV);
  // M2 (2026-08-12): 不再用 globalThis.AiduStore = storeV 掩盖 bug —— 视图走 this.store,
  // global.AiduStore 是类 (没有静态 set), 以前正是这里一点就抛 TypeError。
  vv.setRouter(fakeRouter);
  const vc = makeElement('div');
  vv.render(vc);
  await new Promise((r) => setTimeout(r, 60));
  // 进入专注模式: reviewFocus=true + router.navigate('vocab') (同路由也强制重渲染)
  const startBtn = queryAll(vc, 'button').find((b) => b.textContent === '开始复习');
  check('今日队列卡有「开始复习」按钮', !!startBtn);
  startBtn.onclick();
  check('点击设置 reviewFocus=true (不再抛 TypeError)', storeV.state.reviewFocus === true);
  check('点击调用 router.navigate(vocab) (不再赋同值 hash)', navCalls.join(',') === 'vocab', 'nav=' + navCalls.join(','));
}

console.log('== 6e. M2 (2026-08-12): 全链路 —— 点「开始复习」→ 真渲染 .review-grid, Esc 退出 ==');
{
  // 教训 8: 断言落在用户可见的最终 DOM。复刻 main.js 的 vocab 路由处理器 (真实 Router),
  // 全程不 mask global.AiduStore —— 就是线上出 bug 的路径。
  load('app/router.js');
  const storeE = new globalThis.AiduStore();
  const containerE = makeElement('div');
  const navEl = makeElement('div');
  const router = new globalThis.AiduRouter(makeElement('div'));
  const vvE = new globalThis.VocabView(storeE);
  const rvE = new globalThis.ReviewView(storeE);
  let lastRoute = null;
  const dispatch = (route) => { lastRoute = route; router._handlers[route](containerE); };
  vvE.setRouter({ navigate: (r) => dispatch(r) });
  router.register('vocab', (container) => {
    rvE.cleanup();
    if (storeE.state.reviewFocus) {
      storeE.set({ reviewFocus: false });
      navEl.classList.add('focus-hidden');
      rvE.render(container);
      rvE.onExit = () => { navEl.classList.remove('focus-hidden'); dispatch('vocab'); };
    } else {
      vvE.render(container);
    }
  });
  dispatch('vocab');
  await new Promise((r) => setTimeout(r, 100));
  check('M2: 初始是词表 (.vocab-today-card 存在)', !!containerE.querySelector('.vocab-today-card'));
  const startBtnE = queryAll(containerE, 'button').find((b) => b.textContent === '开始复习');
  startBtnE && startBtnE.onclick();
  await new Promise((r) => setTimeout(r, 100));
  // 教训 8 DOM 断言: 点击后 .review-grid 存在、.vocab-today-card 不存在
  check('M2: 点击后 .review-grid 存在 (专注模式真渲染)', !!containerE.querySelector('.review-grid'), 'has-grid=' + !!containerE.querySelector('.review-grid'));
  check('M2: 点击后 .vocab-today-card 不存在', !containerE.querySelector('.vocab-today-card'));
  check('M2: 顶栏 nav 加 focus-hidden (专注模式视觉)', navEl.className.includes('focus-hidden'), navEl.className);
  const exitBtnE = queryAll(containerE, 'button').find((b) => b.textContent === '退出复习');
  check('M2: 专注模式有「退出复习」按钮', !!exitBtnE);
  // Esc / 退出 → 回词表
  if (exitBtnE) exitBtnE.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('M2: 退出后 .vocab-today-card 回来', !!containerE.querySelector('.vocab-today-card'));
  check('M2: 退出后 .review-grid 消失', !containerE.querySelector('.review-grid'));
  check('M2: 退出后 nav 移除 focus-hidden', !navEl.className.includes('focus-hidden'));
}

console.log('== 7. S5 只播这一句 (player.playOne 单句停) ==');
{
  load('core/shadow.js');
  load('core/timeline.js');
  load('views/reader/player.js');
  // _tick 末行 rAF 在测试 stub 里是同步执行 → 会无限递归; 这里改为 no-op, 手动驱动 tick
  globalThis.requestAnimationFrame = () => 1;
  // 极简 Audio mock: 记录 currentTime/play/pause, 无真实媒体
  let audioTime = 0;
  const fakeAudio = {
    currentTime: 0,
    duration: 60,
    playbackRate: 1,
    paused: true,
    src: '',
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener() {}, load() {},
    style: {}, remove() {}, removeAttribute() {}, setAttribute() {},
  };
  // 句子时间轴: 句0 [0,5000), 句1 [5000,10000) —— 单条流, 句间无留白
  const sentences = [
    { audio: { start_ms: 0, end_ms: 5000 }, original_text: 'Sentence A' },
    { audio: { start_ms: 5000, end_ms: 10000 }, original_text: 'Sentence B' },
  ];
  const player = new globalThis.ReaderPlayer();
  const shadow = new globalThis.ShadowMachine();
  // 模拟 loadChapter 对 shadow.onAction 的接线 (真实路径在 loadChapter 内)
  shadow.onAction = (a) => {
    if (a.type === 'repeat') {
      const s = player.sentences[a.sentenceIndex];
      if (s && s.audio) { player.audio.currentTime = s.audio.start_ms / 1000; player.audio.play(); }
    } else if (a.type === 'next') {
      if (player._oneShot) {
        player._stopAtMs = null; player._stopIndex = -1; player._oneShot = false;
        player.audio.pause();
      } else if (a.sentenceIndex < player.sentences.length) {
        player.playFrom(a.sentenceIndex);
      }
    }
  };
  let anchorChanges = [];
  let playingChanged = null;
  let lastStatus = '';
  player.bindDOM({
    shadow,
    onStatus: (s) => { lastStatus = s; },
    onSaveProgress: () => {},
    onSentenceEnded: (i) => shadow.sentenceEnded(i),
    onAnchorChange: (i) => anchorChanges.push(i),
    onShadowAction: () => {},
    onPlayingChange: (p) => { playingChanged = p; },
  });
  player.audio = fakeAudio;
  player.sentences = sentences;
  player.renderer = { ensureRendered: () => {}, highlightAt: () => {} };
  const startPlaying = () => { player.playing = true; player._lastTickTs = Date.now(); };

  // 通篇模式: playFrom → oneShot 关闭, 越过句末不停 (维持现状)
  player.playFrom(0);
  check('playFrom 不设 oneShot', player._oneShot === false, 'oneShot=' + player._oneShot);
  check('playFrom 无 stopAtMs', player._stopAtMs === null);

  // 逐句模式: playOne(0) → oneShot + stopAtMs=句末
  startPlaying();
  player.playOne(0);
  check('playOne 设 oneShot', player._oneShot === true);
  check('playOne 设 stopAtMs=5000', player._stopAtMs === 5000, 'stopAt=' + player._stopAtMs);
  check('playOne 定位到句起点', player.audio.currentTime === 0);
  check('playOne 开始播放', player.audio.paused === false);

  // 播到句末前 (4900ms): 不停 (audio.currentTime 单位是秒 → 4.9)
  audioTime = 4.9;
  player.audio.currentTime = audioTime;
  player.playing = true;
  player._lastTickTs = 1;
  player._tick();
  check('句末前不暂停 (still playing)', player.audio.paused === false, 'paused=' + player.audio.paused + ' playing=' + player.playing);

  // 越过句末 (5000ms): _tick → shadow.sentenceEnded → repeatCount=1 → next → oneShot 停
  audioTime = 5.0;
  player.audio.currentTime = audioTime;
  player.playing = true;
  player._lastTickTs = 1;
  player._tick();
  check('越过句末 → 自动暂停', player.audio.paused === true, 'paused=' + player.audio.paused);
  check('oneShot 清除 (停完归位)', player._oneShot === false && player._stopAtMs === null);
  // 锚点不前移: 停在句0 (findSentenceIndex(5000) 会返回句1, 但 oneShot 停在前不加)
  check('锚点未前进到句1', !anchorChanges.includes(1), 'anchorChanges=' + JSON.stringify(anchorChanges));

  // 跟读预设 (repeat=3): 重复 2 次后第 3 次才停
  const p2 = new globalThis.ReaderPlayer();
  const shadow2 = new globalThis.ShadowMachine();
  shadow2.setRepeat(3);
  let repeatRewinds = 0;
  shadow2.onAction = (a) => {
    if (a.type === 'repeat') {
      repeatRewinds++;
      const s = p2.sentences[a.sentenceIndex];
      if (s && s.audio) { p2.audio.currentTime = s.audio.start_ms / 1000; p2.audio.play(); }
    } else if (a.type === 'next') {
      if (p2._oneShot) {
        p2._stopAtMs = null; p2._stopIndex = -1; p2._oneShot = false;
        p2.audio.pause();
      }
    }
  };
  p2.bindDOM({ shadow: shadow2, onStatus: () => {}, onSaveProgress: () => {},
    onSentenceEnded: (i) => shadow2.sentenceEnded(i), onAnchorChange: () => {},
    onShadowAction: () => {}, onPlayingChange: () => {} });
  p2.audio = fakeAudio;
  p2.sentences = sentences;
  p2.renderer = { ensureRendered: () => {}, highlightAt: () => {} };
  p2.playing = true;
  p2.playOne(0);
  // 越过句末 → sentenceEnded(repeat) → onAction repeat 重播 (不停); 手动模拟 shadow 的
  // 重播定位到句起点, 再越过 → 直到 repeat 用完
  for (let pass = 1; pass <= 2; pass++) {
    audioTime = 5.0; // 句末 (秒)
    p2.audio.currentTime = audioTime;
    p2.playing = true;
    p2._lastTickTs = 1;
    p2._tick();
    check(`跟读 repeat 第 ${pass} 次越过 → 未停 (repeat 未用完)`, p2.audio.paused === false, 'paused=' + p2.audio.paused);
    // 模拟 shadow repeat 动作已重播: 当前时间回到句起点
    p2.audio.currentTime = 0;
  }
  // 第 3 次越过 → repeatLeft 耗尽 → next → oneShot 停
  audioTime = 5.0;
  p2.audio.currentTime = audioTime;
  p2.playing = true;
  p2._lastTickTs = 1;
  p2._tick();
  check('跟读 repeat 用完 → 才停', p2.audio.paused === true, 'paused=' + p2.audio.paused);
  check('repeat 期间重播过 (走了 repeat 动作)', repeatRewinds >= 2, 'rewinds=' + repeatRewinds);
}

console.log('== 8. B: 设置浮层「播放」节 (通篇⇄逐句 + 跟读预设, UX 2026-08-11) ==');
{
  load('core/follow_presets.js');
  load('views/reader/settings_overlay.js');
  let patches = [];
  // 构造即 _build 一次 (stub 的 innerHTML 不清空, 不调 open 避免重复档位)
  const overlay = new globalThis.SettingsOverlay({
    settings: { pace: 'flow', preset: 'shadow', speed: 1.0 },
    onPatch: (p) => patches.push(p),
  });
  const rows = overlay.el.querySelectorAll('.rd-settings-row');
  const rowText = Array.from(rows).map((r) => {
    const lab = r.querySelector('.rd-settings-label');
    const btns = Array.from(r.querySelectorAll('.rd-settings-opt')).map((b) => b.textContent);
    return (lab ? lab.textContent : '') + ':' + btns.join('/');
  });
  check('「播放」节标题存在', overlay.el.querySelectorAll('.rd-settings-title').length >= 2);
  const paceRowTxt = rowText.find((t) => t.startsWith('播放粒度'));
  check('播放粒度 通篇/逐句 两档', !!paceRowTxt && paceRowTxt.includes('通篇') && paceRowTxt.includes('逐句'), paceRowTxt);
  const presetRowTxt = rowText.find((t) => t.startsWith('跟读'));
  check('跟读预设 四档 (初听/跟读/盲跟/孩子)', !!presetRowTxt && presetRowTxt.includes('初听') && presetRowTxt.includes('盲跟') && presetRowTxt.includes('孩子'), presetRowTxt);
  const findRow = (label) => rows.find((r) => {
    const lab = r.querySelector('.rd-settings-label');
    return lab && lab.textContent === label;
  });
  // 默认值: flow + shadow 高亮
  const paceRowEl = findRow('播放粒度');
  const activePace = paceRowEl && paceRowEl.querySelector('.rd-settings-opt.active');
  check('默认播放粒度 = 通篇 (flow)', activePace && activePace.textContent === '通篇');
  const presetRowEl = findRow('跟读');
  const activePreset = presetRowEl && presetRowEl.querySelector('.rd-settings-opt.active');
  check('默认跟读 = 跟读 (shadow)', activePreset && activePreset.textContent === '跟读');
  // 点击「逐句」→ onPatch({pace:'sentence'})
  patches = [];
  const paceBtns = paceRowEl.querySelectorAll('.rd-settings-opt');
  paceBtns[1].onclick();
  check('点「逐句」→ onPatch pace=sentence', patches.some((p) => p.pace === 'sentence'), JSON.stringify(patches));
  // 点击「盲跟」→ onPatch({preset:'blind'})
  patches = [];
  const presetBtns = presetRowEl.querySelectorAll('.rd-settings-opt');
  presetBtns[2].onclick();
  check('点「盲跟」→ onPatch preset=blind', patches.some((p) => p.preset === 'blind'), JSON.stringify(patches));
}

console.log('== 9. J1/J2: 模型按功能分组, 判据=该功能有无可用模型 (2026-08-11) ==');
{
  // 用真实 ModelsView 替换顶部 stub (仅本段), 段末恢复
  const fakeModelsView = globalThis.ModelsView;
  load('views/models_view.js');
  const listCalls = { fileCheck: [], register: [] };
  // J2 关键场景: 注册的 model_id 是 Qwen3-4B-Instruct-2507-Q4_K_M (与目录 name Qwen3-4B 不同)
  // → 旧判据 (model_id === 目录 name) 落空显示"下载"; 新判据 (family 有无可用) → "可用"。
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { family: 'llm', language: 'en', model_id: 'Qwen3-4B-Instruct-2507-Q4_K_M', version: '2507-Q4_K_M', variant: 'Q4_K_M', path: 'C:/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size_bytes: 2497280256, active: true, asset_status: 'recommended' },
  ] });
  globalThis.AiduModelService.fileCheck = async (path, minBytes) => {
    listCalls.fileCheck.push({ path, minBytes });
    return { ok: true, data: { present: path.includes('kokoro'), healthy: path.includes('kokoro') } };
  };
  globalThis.AiduModelService.register = async (m) => { listCalls.register.push(m); return { ok: true }; };
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {
    llm_model: 'C:/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', tts_model: 'C:/models/kokoro-v1_0.pth', default_model_dir: 'C:/models',
  } });
  const mv = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc = makeElement('div');
  mv.render(mc);
  await new Promise((r) => setTimeout(r, 80));
  const groups = queryAll(mc, '.model-group');
  // 段标题直接读第一个子元素 (stub 的 querySelector 对 tag 选择器有兼容问题, 直读更稳)
  const groupTitle = (g) => { const h2 = (g._children || []).find((x) => x.tagName === 'H2'); return h2 ? h2.textContent : ''; };
  const groupTexts = groups.map(groupTitle);
  check('三段标题: 翻译/讲解 + 语音合成 + 分词/NLP', groupTexts.some((t) => t.includes('翻译')) && groupTexts.some((t) => t.includes('语音合成')) && groupTexts.some((t) => t.includes('分词')), JSON.stringify(groupTexts));
  check('L4: 界面不再出现「语音识别」', !groupTexts.some((t) => t.includes('语音识别')), JSON.stringify(groupTexts));
  const mcText = (mc.textContent || '').replace(/\s+/g, '');
  check('L4: 界面不再出现「跟读打分」', !mcText.includes('跟读打分'));
  // 翻译段: 有可用模型 → 显示"可用" + 换一个, 不显示"去下载"
  const llmSec = groups.find((g) => groupTitle(g).includes('翻译/讲解'));
  const llmRow = llmSec && llmSec.querySelector('.model-row');
  const llmName = llmRow && llmRow.querySelector('.model-name').textContent;
  const llmBadge = llmRow && queryAll(llmRow, '.book-badge').map((b) => b.textContent);
  check('J2: 注册名≠目录名也显示"可用" (Qwen3 4B · Q4_K_M)', llmName && llmName.includes('Qwen3') && llmBadge && llmBadge.some((t) => t.includes('可用')), 'name=' + llmName + ' badges=' + JSON.stringify(llmBadge));
  check('J2: 有可用模型时该段不显示「去下载」', llmSec && !queryAll(llmSec, 'button').some((b) => b.textContent === '去下载'));
  // 语音段: 无已登记 tts → 该段提供「去下载」
  const ttsSec = groups.find((g) => groupTitle(g).includes('语音合成'));
  check('J2: 无可用语音 → 该段显示「去下载」', ttsSec && queryAll(ttsSec, 'button').some((b) => b.textContent === '去下载'));
  // 点「去下载」→ 下载单里对 kokoro 做磁盘探测 (文件在 → 磁盘已有·点此登记)
  const ttsDlBtn = ttsSec && queryAll(ttsSec, 'button').find((b) => b.textContent === '去下载');
  ttsDlBtn && ttsDlBtn.onclick();
  await new Promise((r) => setTimeout(r, 200));
  const modals = (document.body._children || []).filter((c) => c.className && c.className.includes('modal-overlay'));
  const ov = modals[modals.length - 1]; // 最近打开的 (前面测试的弹窗未关, find 会拿旧的)
  const dlBtn = ov && queryAll(ov, 'button')[0];
  check('J2: 下载单对磁盘已有文件显示「磁盘已有·点此登记」', dlBtn && dlBtn.textContent.includes('磁盘已有'), 'text=' + (dlBtn && dlBtn.textContent) + ' fileChecks=' + JSON.stringify(listCalls.fileCheck));
  // 恢复 stub, 不干扰其它段
  globalThis.ModelsView = fakeModelsView;
}

console.log('== 9c. M4 (2026-08-12): 分词/NLP 无空下载按钮 + 扫描候选勾选登记 + 家族识别 ==');
{
  load('views/models_view.js'); // 上一段 (9) 把 ModelsView 还原成了 stub
  // 无模型时渲染 models 视图
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [] });
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {
    llm_model: 'C:/models/Qwen3-4B.gguf', tts_model: 'C:/models/kokoro-v1_0.pth',
    default_model_dir: 'C:/aidulc/models', hf_cache_dir: 'F:/hf_cache',
  } });
  const mv9 = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc9 = makeElement('div');
  mv9.render(mc9);
  await new Promise((r) => setTimeout(r, 80));
  const groups9 = queryAll(mc9, '.model-group');
  const gtitle = (g) => { const h2 = (g._children || []).find((x) => x.tagName === 'H2'); return h2 ? h2.textContent : ''; };
  const nlpSec9 = groups9.find((g) => gtitle(g).includes('分词'));
  // M4-1: nlp 无目录项 → 不渲染「去下载」(空对话框的根源)
  check('M4-1: 分词/NLP 段没有「去下载」按钮', nlpSec9 && !queryAll(nlpSec9, 'button').some((b) => b.textContent === '去下载'));
  // M4-1: 回答"我现在用的什么" —— 当前方案写在这一段
  const nlpText9 = textOf(nlpSec9);
  check('M4-1: nlp 段写明当前方案 (spaCy en_core_web_sm 内置)', nlpText9.includes('spaCy') && nlpText9.includes('en_core_web_sm'), nlpText9.slice(0, 80));
  // M4-1: llm/tts 有目录项 → 仍有「去下载」(有源才有按钮)
  const llmSec9 = groups9.find((g) => gtitle(g).includes('翻译'));
  const ttsSec9 = groups9.find((g) => gtitle(g).includes('语音合成'));
  check('M4-1: 翻译段有「去下载」(有目录项)', llmSec9 && queryAll(llmSec9, 'button').some((b) => b.textContent === '去下载'));
  check('M4-1: 语音段有「去下载」(有目录项)', ttsSec9 && queryAll(ttsSec9, 'button').some((b) => b.textContent === '去下载'));

  // M4-3: 扫描弹窗 —— 默认路径 (模型目录 + HF 缓存) 可见
  globalThis.AiduModelService.scan = async (dir) => {
    // 两个路径各返回自己的文件 (llm/tts 在模型目录, nlp/asr/vad 在 HF 缓存)
    if (String(dir).includes('hf_cache')) {
      return { ok: true, data: [
        { path: 'F:/hf_cache/hub/models--spacy--en_core_web_sm/snapshots/x/model.bin', file_name: 'model.bin', size_bytes: 1000, family_hint: 'nlp', registered: false },
        { path: 'F:/hf_cache/ggml-large-v3.bin', file_name: 'ggml-large-v3.bin', size_bytes: 2000, family_hint: 'asr', registered: false },
        { path: 'F:/hf_cache/ggml-silero-v5.1.2.onnx', file_name: 'ggml-silero-v5.1.2.onnx', size_bytes: 3000, family_hint: 'vad', registered: false },
      ] };
    }
    return { ok: true, data: [
      { path: 'C:/models/Qwen3-4B.gguf', file_name: 'Qwen3-4B.gguf', size_bytes: 2497280256, family_hint: 'llm', registered: false },
      { path: 'C:/models/kokoro-v1_0.pth', file_name: 'kokoro-v1_0.pth', size_bytes: 327212226, family_hint: 'tts', registered: false },
    ] };
  };
  const regCalls9 = [];
  globalThis.AiduModelService.register = async (m) => { regCalls9.push(m); return { ok: true }; };
  mv9._openScanModal();
  await new Promise((r) => setTimeout(r, 80));
  const ov9 = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  const pathRows9 = ov9 && queryAll(ov9, '.scan-path-row');
  const pathTexts9 = (pathRows9 || []).map(textOf);
  check('M4-3①: 扫描弹窗默认列出模型目录', pathTexts9.some((t) => t.includes('C:/models')), pathTexts9.join(','));
  check('M4-3①: 扫描弹窗默认列出 HF 缓存', pathTexts9.some((t) => t.includes('F:/hf_cache')), pathTexts9.join(','));
  // 点扫描 → 候选列表 (路径/大小/家族/是否已登记)
  const scanBtn9 = ov9 && queryAll(ov9, 'button').find((b) => b.textContent === '扫描');
  scanBtn9.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const cands9 = ov9 && queryAll(ov9, '.scan-candidate');
  check('M4-3④: 扫描后渲染候选列表', cands9 && cands9.length === 5, 'n=' + (cands9 && cands9.length));
  const famBadges9 = (cands9 || []).map((c) => {
    const b = c.querySelector('.book-badge');
    return b ? b.textContent : '';
  });
  check('M4-3③: 家族识别正确 (llm/tts/nlp)', famBadges9.includes('翻译/讲解') && famBadges9.includes('语音合成') && famBadges9.includes('分词/NLP'), famBadges9.join(','));
  check('M4-3③: whisper(ggml-large) 标「未识别」不是语音合成', famBadges9.includes('未识别'), famBadges9.join(','));
  check('M4-3③: silero 标「未识别」不是语音合成', famBadges9.filter((b) => b === '未识别').length >= 2, famBadges9.join(','));
  // 未识别候选有家族下拉 (让用户选)
  const unrecRow9 = cands9 && cands9.find((c) => c.querySelector('.book-badge') && c.querySelector('.book-badge').textContent === '未识别');
  check('M4-3③: 未识别候选带家族下拉', unrecRow9 && queryAll(unrecRow9, 'select.scan-fam').length === 1);
  // 勾选登记: 默认全勾 (未登记), 点登记 → register 被调且只登记未注册的
  const regBtn9 = ov9 && queryAll(ov9, 'button').find((b) => b.textContent && b.textContent.startsWith('登记选中'));
  check('M4-3④: 有「登记选中 N 个」按钮', !!regBtn9, regBtn9 && regBtn9.textContent);
  regBtn9 && regBtn9.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('M4-3④: 登记只提交未注册候选 (5 个)', regCalls9.length === 5, 'n=' + regCalls9.length);
  check('M4-3④: 登记的家族用候选下拉所选值', regCalls9.some((m) => m.family === 'llm') && regCalls9.some((m) => m.family === 'tts') && regCalls9.some((m) => m.family === 'nlp'), regCalls9.map((m) => m.family).join(','));

  // M4-3⑤: 0 结果 → 明确列出扫过的路径 + 可点下一步
  globalThis.AiduModelService.scan = async () => ({ ok: true, data: [] });
  mv9._openScanModal();
  await new Promise((r) => setTimeout(r, 80));
  const ov9b = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  const scanBtn9b = ov9b && queryAll(ov9b, 'button').find((b) => b.textContent === '扫描');
  scanBtn9b && scanBtn9b.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const emptyText9 = textOf(ov9b);
  check('M4-3⑤: 0 结果列出扫过的路径', emptyText9.includes('没找到模型') && emptyText9.includes('F:/hf_cache'), emptyText9.slice(0, 100));
  check('M4-3⑤: 0 结果给「选择目录扫描…」出口', ov9b && queryAll(ov9b, 'button').some((b) => b.textContent.includes('选择目录扫描')), queryAll(ov9b, 'button').map((b) => b.textContent).join(','));
  check('M4-3⑤: 0 结果给「添加自定义模型」出口', ov9b && queryAll(ov9b, 'button').some((b) => b.textContent === '添加自定义模型'));

  // M4-3③: 存量误登记改家族 —— 全部模型列表有「改家族」且调 setFamily
  const setFamCalls = [];
  globalThis.AiduModelService.setFamily = async (id, fam) => { setFamCalls.push([id, fam]); return { ok: true }; };
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'm-mis', family: 'tts', language: 'en', model_id: 'ggml-large-v3', version: 'x', variant: '', path: 'F:/hf_cache/ggml-large-v3.bin', size_bytes: 1, active: false, custom: true },
  ] });
  mv9._reload();
  await new Promise((r) => setTimeout(r, 60));
  // 「全部模型」组的标题是 .model-history-toggle 按钮, 行按钮要点了才铺开
  const groupsAll9 = queryAll(mc9, '.model-group');
  const allSec = groupsAll9.find((g) => queryAll(g, '.model-history-toggle').length > 0);
  const toggleAll9 = allSec && allSec.querySelector('.model-history-toggle');
  toggleAll9 && toggleAll9.onclick();
  await new Promise((r) => setTimeout(r, 20));
  const famBtn = allSec && queryAll(allSec, 'button').find((b) => b.textContent === '改家族');
  check('M4-3③: 已登记模型行有「改家族」', !!famBtn);
  if (famBtn) {
    famBtn.onclick();
    await new Promise((r) => setTimeout(r, 30));
    const ov9c = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
    const saveFam = ov9c && queryAll(ov9c, 'button').find((b) => b.textContent === '保存');
    const famSel9 = ov9c && queryAll(ov9c, 'select')[0];
    famSel9 && (famSel9.value = 'nlp');
    saveFam && saveFam.onclick();
    await new Promise((r) => setTimeout(r, 40));
    check('M4-3③: 保存改家族 → setFamily(id, nlp)', setFamCalls.some(([id, f]) => id === 'm-mis' && f === 'nlp'), JSON.stringify(setFamCalls));
  }
}

console.log('== 9d. M4-2 (2026-08-12): 无更新渠道的本地模型给可操作的话 ==');
{
  store.state.settingsTab = 'models';
  globalThis.AiduMiscService.componentsHealth = async () => ({ ok: true, data: [
    { id: 'llm', name: 'LLM 模型', healthy: true, detail: 'Qwen3 4B', update_channel: '无更新渠道' },
    { id: 'tts', name: 'TTS 模型', healthy: true, detail: 'Kokoro', update_channel: '无更新渠道' },
  ] });
  const sv9 = new globalThis.SettingsView(store);
  const c9 = makeElement('div');
  sv9.render(c9);
  await new Promise((r) => setTimeout(r, 100));
  store.state.settingsTab = null;
  const rows9 = queryAll(c9, '.component-row');
  const rowTexts9 = rows9.map(textOf);
  check('M4-2: 无更新渠道的模型组件给「添加自定义模型」可操作指引', rowTexts9.some((t) => t.includes('无更新渠道') && t.includes('添加自定义模型')), rowTexts9.join('|').slice(0, 120));
}

console.log('== 9b. L5 (2026-08-11): 页头动作按钮成组 (.page-toolbar + gap), 不再被 space-between 撑开 ==');
{
  // 三处页头 (生词本/模型与依赖/同步) 的动作按钮必须收进 .page-toolbar 单一 flex 容器。
  load('app/page_toolbar.js');
  const toolbarCss = readFileSync(join(root, 'styles/app.css'), 'utf8');
  const hasGap = /\.page-toolbar\s*\{[^}]*gap:\s*var\(--md-sys-space-2\)/.test(toolbarCss);
  check('L5: .page-toolbar 用 gap: var(--md-sys-space-2) (组内间距固定)', hasGap);
  // 模型与依赖页头: 动作按钮在 .page-toolbar 里, 不再直接是 page-header 的子按钮。
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [] });
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {} });
  load('views/models_view.js');
  const mv5 = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc5 = makeElement('div');
  mv5.render(mc5);
  await new Promise((r) => setTimeout(r, 60));
  const ph5 = mc5.querySelector && mc5.querySelector('.page-header');
  const tb5 = ph5 && ph5.querySelector('.page-toolbar');
  const tbButtons = tb5 ? queryAll(tb5, 'button').length : 0;
  const headerDirectButtons = ph5 ? queryAll(ph5, 'button').length - tbButtons : 0;
  check('L5: 页头动作按钮收进 .page-toolbar (无直系散列按钮)', ph5 && tb5 && headerDirectButtons === 0, 'direct=' + headerDirectButtons + ' inToolbar=' + tbButtons);
  // 生词本页头同样用 .page-toolbar
  load('views/vocab_view.js');
  const fakeVocabModels = globalThis.ModelsView; // 占位, 不影响
  const vv5 = new globalThis.VocabView(new globalThis.AiduStore());
  const vc5 = makeElement('div');
  vv5.render(vc5);
  await new Promise((r) => setTimeout(r, 60));
  const phv = vc5.querySelector && vc5.querySelector('.page-header');
  check('L5: 生词本页头也用 .page-toolbar (备份/恢复/导出成组)', phv && !!phv.querySelector('.page-toolbar'));
  // 同步页动作按钮 (立即同步/拉取合并/更多) 也在 .page-toolbar (三处中的第三处)
  store.state.settingsTab = 'sync';
  const sv5 = new globalThis.SettingsView(store);
  const sc5 = makeElement('div');
  sv5.render(sc5);
  await new Promise((r) => setTimeout(r, 60));
  store.state.settingsTab = null;
  const syncToolbars = queryAll(sc5, '.page-toolbar');
  const syncToolbar = syncToolbars.find((tb) => (tb._children || []).map((x) => String(x.textContent)).join('').includes('拉取合并'));
  check('L5: 同步动作按钮也用 .page-toolbar (立即同步/拉取合并/更多)', !!syncToolbar, 'toolbars=' + syncToolbars.length);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);