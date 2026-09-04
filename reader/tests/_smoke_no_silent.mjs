/**
 * _smoke_no_silent.mjs —— 契约门禁 ui:no-silent-action (M0 之后, 2026-08-12)
 *
 * 契约四条之一: "每个用户动作必须在 300ms 内产生可见变化 —— 三选一: 结果 / 进行中 /
 * 失败原因。没有反应本身就是 bug。"
 *
 * 做法: 渲染主要视图 (书库原版/成品架、模型与依赖、设置全部 tab、生词本、处理中),
 * 遍历该视图容器里**所有 button**, 逐个 click, 断言 60ms 内 (≤300ms) 发生下列之一:
 *   1. 容器 DOM 有变化 (同步或异步后)
 *   2. 出现 toast
 *   3. 出现/消失 modal-overlay
 *   4. 路由 navigate / hash 变化 (视图回调被调)
 * 没有任何变化的按钮 → 门禁失败。
 *
 * 例外清单 (确实不该有反馈的按钮) 显式列在 EXCEPTIONS 并注明理由, 不许默默跳过。
 * 已知缺陷 (M2/M5 等) 修好后从清单里移除, 门禁恢复严格。
 *
 * 范围: review_view 不在此门禁 —— 它的按钮是"进行中会话"的交互 (翻面/评分/撤销),
 * 初始态大多是 disabled, 由 M2 专项断言 (点击后 .review-grid 存在) 覆盖。
 *
 * 运行: node tests/_smoke_no_silent.mjs (已接入 scripts/check.ps1)
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
    textContent: '', title: '', id: '', value: '', href: '', download: '',
    parentNode: null, onclick: null,
    get innerHTML() { return ''; },
    set innerHTML(v) { if (v === '') children.length = 0; },
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
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    focus() {},
    click() {},
    _click(evArg) {
      const ev = evArg || { stopPropagation() {}, preventDefault() {}, target: el };
      if (typeof el.onclick === 'function') el.onclick(ev);
      (el._listeners.click || []).forEach((fn) => fn(ev));
    },
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

const _hash = { v: '#/library', changes: 0 };
globalThis.document = {
  createElement: (tag) => makeElement(tag),
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s), parentNode: null }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  body: makeElement('body'),
  documentElement: makeElement('html'),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.location = {
  get hash() { return _hash.v; },
  set hash(h) { if (h !== _hash.v) { _hash.v = h; _hash.changes++; } },
  reload() {},
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.setInterval = () => ({ unref: () => {} });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {}, readText: async () => '' } }, configurable: true });
globalThis.prompt = () => '孩子';
globalThis.Blob = class Blob { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };

let failures = 0, clicked = 0, skipped = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function load(rel) { eval(readFileSync(join(root, rel), 'utf8')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 反馈追踪 ----------
let toastCount = 0;
globalThis.AiduToast = { show: () => { toastCount++; } };
const navCalls = [];
const openCalls = [];
globalThis.AiduModal = {
  confirm(opts) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    document.body.appendChild(ov);
    return { close() { ov.remove(); }, box: ov, _opts: opts };
  },
};

// ---------- 服务 stub (视图只在调用时引用) ----------
const bookWithEditions = {
  id: 's1', title: 'Alice (Lewis Carroll).epub', kind: 'original', status: 'done',
  source_language: 'en', chapter_count: 0, failed_count: 0, source_path: 'C:/Books/Alice.epub',
  editions: [
    { id: 'e1', title: 'Alice 译本', status: 'ready', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' },
  ],
};
const bookNoEdition = { id: 's2', title: 'Number the Stars.epub', kind: 'original', status: 'pending', source_language: 'en' };
const missingProduct = {
  id: 'e1', title: 'Number the Stars 译本', kind: 'product', status: 'ready',
  pack_state: 'missing', source_id: 's1', profile_id: 'default', chapter_count: 12,
};

globalThis.AiduBridge = {
  invoke: async () => ({ ok: true, data: null }),
  listen: () => () => {},
  pickFiles: async () => ({ ok: true, data: ['C:/a.epub'] }),
  openPath: async () => ({ ok: true }),
  library: { list: async () => ({ ok: true, data: [] }), open: async () => ({ ok: true, data: {} }), remove: async () => ({ ok: true }), register: async () => ({ ok: true }) },
  bookpack: { load: async () => ({ ok: true, data: {} }), loadChapter: async () => ({ ok: true, data: {} }), readAudio: async () => ({ ok: true, data: [] }), readImage: async () => ({ ok: true, data: {} }) },
  profiles: { list: async () => ({ ok: true, data: [{ id: 'default', name: '成人自读' }] }), upsert: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  settings: { get: async () => ({ ok: true, data: {} }), upsert: async () => ({ ok: true }) },
  reading: { save: async () => ({ ok: true }), get: async () => ({ ok: true, data: null }) },
  transfer: { exportData: async () => ({ ok: true, data: {} }), importData: async () => ({ ok: true, data: {} }) },
  highlights: { list: async () => ({ ok: true, data: [] }), save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
};
globalThis.AiduLibraryService = {
  list: async () => ({ ok: true, data: [bookWithEditions, bookNoEdition] }),
  open: async () => ({ ok: true }), remove: async () => ({ ok: true }),
  loadBookpack: async () => ({ ok: true, data: {} }), loadBookpackChapter: async () => ({ ok: true, data: {} }),
  readAudioRange: async () => ({ ok: true, data: { data_b64: '', read: 0, total: 0, end: true } }),
  preview: async () => ({ ok: true, data: { chapters: [], format: 'EPUB', health: {} } }),
  exportBook: async () => ({ ok: true, data: {} }), importBook: async () => ({ ok: true, data: {} }),
  setBookProfile: async () => ({ ok: true }),
  editionLookup: async (id) => ({ ok: true, data: { id, title: '雪国', chapter_count: 12 } }),
};
globalThis.AiduImportService = {
  getProfile: async () => ({ id: 'default', name: '成人自读', explain_strategy: 'brief', voice: 'af_heart', speed: 1.0, highlight_granularity: 'sentence' }),
  buildProfile: () => ({ id: 'default' }), buildModels: async () => ({}),
  importBooks: async (paths) => ({ ok: true, data: { registered: paths, skipped: [] } }),
  startPrep: async () => ({ ok: true, data: {} }),
};
const modelData = [
  { id: 'm1', family: 'llm', language: 'en', model_id: 'Qwen3-4B-Instruct-2507-Q4_K_M', version: '2507-Q4_K_M', variant: 'Q4_K_M', path: 'C:/models/Qwen3-4B.gguf', size_bytes: 2497280256, active: true, custom: false },
  { id: 'm2', family: 'tts', language: 'en', model_id: 'kokoro-v1_0', version: 'v1.0', variant: 'v1.0', path: 'C:/models/kokoro-v1_0.pth', size_bytes: 327212226, active: true, custom: false },
];
globalThis.AiduModelService = {
  list: async () => ({ ok: true, data: modelData }),
  bookBinding: async () => ({ ok: true, data: {} }), bindBook: async () => ({ ok: true }),
  register: async () => ({ ok: true }), setRecommended: async () => ({ ok: true }),
  remove: async () => ({ ok: true }),
  scan: async () => ({ ok: true, data: [] }),
  download: async () => ({ ok: true, data: { token: 't' } }),
  downloadStatus: async () => ({ ok: true, data: { done: true, ok: true } }),
  fileCheck: async () => ({ ok: true, data: { present: false, healthy: false } }),
  hfNormalize: async () => ({ ok: true, data: { file: 'x.gguf', family_hint: 'llm', url: 'https://huggingface.co/x' } }),
  wizardState: async () => ({ ok: true, data: { status: 'done' } }),
  wizardSubmit: async () => ({ ok: true }), wizardFinish: async () => ({ ok: true }),
  wizardReset: async () => ({ ok: true }),
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
  backendsList: async () => ({ ok: true, data: [
    { name: '默认后端', url: 'https://a.workers.dev', active: true, connected: true },
  ] }),
  backendAdd: async () => ({ ok: true }), backendSwitch: async () => ({ ok: true }), backendRemove: async () => ({ ok: true }),
  pairQr: async () => ({ ok: true, data: { qr_svg: '', qr_content: 'http://example.com/#t=x', token: 't' } }),
  revokeToken: async () => ({ ok: true, data: { revoked: true } }),
};
globalThis.AiduDictionaryService = {
  list: async () => ({ ok: true, data: [] }),
  vocabAll: async () => ({ ok: true, data: [
    { word: 'reticent', lemma: 'reticent', stage: 'review', interval_ms: 3 * 86400000, next_review: Date.now() - 1000, meaning: '沉默寡言的', context: 'He was reticent.', edition_id: 'e-1', chapter_index: 2, sentence_index: 5 },
    { word: 'bank', lemma: 'bank', stage: 'new', next_review: null, meaning: '银行', context: 'He went to the bank.' },
  ] }),
  lookup: async () => ({ ok: true, data: {} }), lookupOnline: async () => ({ ok: true, data: [] }),
  addToVocab: async () => ({ ok: true, data: {} }), vocabRemove: async () => ({ ok: true }),
  srsPreview: async () => ({ ok: true, data: {} }), srsGrade: async () => ({ ok: true, data: {} }), srsRestore: async () => ({ ok: true, data: {} }),
  vocabCommonPreview: async () => ({ ok: true, data: { count: 0, top_n: 3000, lemmas: [] } }),
  vocabRemoveCommon: async () => ({ ok: true, data: { removed: 0, backup_path: '' } }),
  vocabBacklogPreview: async () => ({ ok: true, data: { backlog_count: 0, daily_cap: 40, days: 0, today_after: 0, today_before: 0 } }),
  vocabBacklogSpread: async () => ({ ok: true, data: { spread: 0, days: 0, backup_path: '' } }),
  ttsCacheWord: async () => ({ ok: true }), vocabReadCachedAudio: async () => ({ ok: true, data: null }),
  // 2026-08-17: 补发音改成 Rust 侧后台任务的三个命令
  vocabAudioStart: async (words) => ({ ok: true, data: { running: true, total: (words || []).length, done: 0, synthesized: 0, skipped: 0, failed: 0, current: '', outcome: '' } }),
  vocabAudioStatus: async () => ({ ok: true, data: { running: false, total: 0, done: 0, synthesized: 0, skipped: 0, failed: 0, current: '', outcome: '' } }),
  vocabAudioCancel: async () => ({ ok: true }),
};
globalThis.AiduReadingService = { get: async () => ({ ok: true, data: null }), save: async () => ({ ok: true }), stats: async () => ({ ok: true, data: {} }) };
globalThis.AiduMiscService = {
  logPath: async () => ({ ok: true, data: { path: 'C:/log' } }), componentsHealth: async () => ({ ok: true, data: [] }),
  runtimeConfig: async () => ({ ok: true, data: {} }), openPath: async () => ({ ok: true }),
  libraryDirGet: async () => ({ ok: true, data: 'C:/aidulc-data' }),
  libraryRootStatus: async () => ({ ok: true, data: { root: 'C:/aidulc-data', db_path: 'C:/aidulc-data/data.db', exists: true, writable: true, ok: true, reason: '', db_exists: true, out_dir: 'C:/aidulc-data/jobs_out', out_inside_root: true } }),
  libraryOutConsolidate: async () => ({ ok: true, data: { old_out: 'E:/aidulc_data', new_out: 'C:/aidulc-data/jobs_out', backup_path: 'C:/aidulc-data/backups/x', restart_required: true } }),
  dataRootRecommended: async () => ({ ok: true, data: { path: 'C:/Users/x/Documents/aidulc' } }),
  libraryDirPickAndSet: async () => ({ ok: true, data: { cancelled: false, new_dir: 'D:/aidulc-data' } }),
  libraryDirPick: async () => ({ ok: true, data: { cancelled: false, path: 'D:/ext-lib' } }),
  libraryDirScan: async () => ({ ok: true, data: { importable: [], existing: [] } }),
  libraryDirImport: async () => ({ ok: true, data: { imported: 0, failed: [] } }),
  docParserInstall: async () => ({ ok: true, data: { ok: true } }),
  dataMigrationStatus: async () => ({ ok: true, data: { portable: false, data_dir: 'C:/aidulc', db_path: 'C:/aidulc/data.db', out_dir: 'C:/aidulc/jobs_out', pending: false } }),
  dataMigrationDryRun: async () => ({ ok: true, data: { pending: false } }),
  dataMigrationRun: async () => ({ ok: true, data: { ok: true, restart_required: true, backup_path: 'C:/backups/x', out_moved: 0, target_out: 'C:/aidulc/jobs_out', target_db: 'C:/aidulc/data.db' } }),
  onlineConfigGet: async () => ({ ok: true, data: { endpoint: '', model: '', key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigSet: async () => ({ ok: true, data: { saved: true, key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigTest: async () => ({ ok: true, data: { ok: true, reply: 'ok' } }),
  gpuStatus: async () => ({ ok: true, data: { available: false, shouldWarn: false, foreignProcesses: [] } }),
  dictBaseStats: async () => ({ ok: true, data: [{ source: 'seed', count: 19139 }] }),
  dictBaseImportFile: async () => ({ ok: true, data: { imported: 0, skipped_existing: 0, total_rows: 0 } }),
  dictBaseSourcesList: async () => ({ ok: true, data: [] }),
  dictBaseSourceDelete: async () => ({ ok: true, data: 0 }),
};
globalThis.AiduJobService = {
  list: async () => ({ ok: true, data: [
    { id: 'j1', book_path: 'C:/Books/Alice.epub', profile_id: 'default', status: 'running', batch_id: null, stage: 'translate', current: 3, total: 240, progress: 35, output_dir: 'C:/out/j1', edition_id: 'e1', error: null },
    { id: 'j2', book_path: 'C:/Books/Star.epub', profile_id: 'default', status: 'done', batch_id: null, stage: 'pack', current: 240, total: 240, progress: 100, output_dir: 'C:/out/j2', edition_id: 'e2', error: null },
  ] }),
  remove: async () => ({ ok: true }), pause: async () => ({ ok: true }), resume: async () => ({ ok: true }),
  pauseAll: async () => ({ ok: true }), resumeAll: async () => ({ ok: true }),
  retryFailed: async () => ({ ok: true }), detail: async () => ({ ok: true, data: { quality_report: { summary: 'ok' }, run_log_tail: 'log tail' } }),
  retryCustom: async () => ({ ok: true }),
  listBatches: async () => ({ ok: true, data: [] }),
};
globalThis.AiduVocabStats = { dailyBuckets: () => [] };

// ---------- 例外清单 (确实不该有反馈的按钮, 理由必须写明) ----------
const EXCEPTIONS = {
  // key = '视图|按钮文案'
  'settings|打开日志文件': '外部动作: 在系统资源管理器中打开日志文件 (成功时无 DOM 反馈, 结果在系统层)',
  'settings|在资源管理器中打开': '外部动作: 打开系统资源管理器定位书库目录 (结果在系统层)',
  'vocab|恢复': '外部动作: 打开系统文件选择对话框等待用户选文件 (结果在系统层)',
  // UX5 #5 (2026-08-13): 模型页「+ 添加目录」= 打开系统文件夹选择对话框 (与扫描弹窗「+ 添加路径」同一外部动作)
  'models(有模型)|+ 添加目录': '外部动作: 打开系统文件夹选择对话框等待用户选目录 (结果在系统层, 选完才更新列表)',
  'models(无模型)|+ 添加目录': '外部动作: 打开系统文件夹选择对话框等待用户选目录 (结果在系统层, 选完才更新列表)',
  'settings|+ 添加目录': '外部动作: 打开系统文件夹选择对话框等待用户选目录 (结果在系统层, 选完才更新列表)',
};

// ---------- DOM 快照 ----------
function ser(n) {
  if (!n || typeof n !== 'object') return String(n);
  if (n.nodeType === 3) return '#' + String(n.textContent);
  const kids = (n._children || []).map(ser).join(',');
  return n.tagName + '.' + (n.className || '') + '|' + String(n.textContent || '') + '>(' + kids + ')';
}
function snapshot(container) {
  const modalCount = (document.body._children || []).filter((c) => c.className && String(c.className).includes('modal-overlay')).length;
  return ser(container) + '§modal' + modalCount + '§toast' + toastCount +
    '§nav' + navCalls.join(',') + '§open' + openCalls.join(',') + '§hash' + _hash.v;
}

// ---------- 单按钮检查 ----------
async function press(viewName, btn, container) {
  clicked++;
  const label = String(btn.textContent || '').trim() || btn.title || btn.className;
  const before = snapshot(container);
  let threw = null;
  try { btn._click(); } catch (e) { threw = e; }
  const afterSync = snapshot(container);
  await sleep(60);
  const afterAsync = snapshot(container);
  const changed = afterSync !== before || afterAsync !== before;
  if (threw) {
    check(`[${viewName}] 点击「${label}」不抛异常`, false, String(threw && (threw.message || threw)));
    return;
  }
  if (changed) { check(`[${viewName}] 「${label}」60ms 内有可见反馈`, true); return; }
  // 已是激活态的筛选/分段按钮: 重复点击同一状态 = 设计上的 no-op
  if (btn.classList && btn.classList.contains('active')) {
    check(`[${viewName}] 「${label}」已是激活态 (重复点击 no-op 设计如此)`, true);
    return;
  }
  const exKey = viewName + '|' + label;
  if (EXCEPTIONS[exKey]) {
    check(`[${viewName}] 「${label}」在例外清单 (${EXCEPTIONS[exKey]})`, true);
    return;
  }
  check(`[${viewName}] 「${label}」点击后 300ms 内必须产生可见变化 (DOM/toast/modal/路由)`, false,
    '前后快照一致: 没有 DOM 变化、没有 toast、没有 modal、没有路由变化 —— 这是"点了没反应", 契约第一条违反' +
    (process.env.DEBUG_NS ? '\nBEFORE=' + before + '\nAFTER=' + afterAsync : ''));
}

// ---------- 视图遍历 ----------
// 关键: 每按一次就重新查询按钮 (视图点击会重渲染、重建按钮元素) —— 先收集后点会点到
// 游离节点, 改动落在容器外, 快照永远不变 (假"没反应")。
async function walk(viewName, container, opts) {
  await sleep(160); // 等首屏异步加载落定
  const tested = new Set();
  const sig = (i, b) => i + '|' + (String(b.textContent || '').trim() || b.title || b.className) + '|' + b.className;
  let cursor = 0, guard = 0;
  const maxPresses = (opts && opts.maxPresses) || 120;
  while (guard++ < maxPresses) {
    const buttons = queryAll(container, 'button');
    const enabled = buttons.filter((b) => !b.disabled);
    if (enabled.length === 0) break;
    let hit = null, hitIdx = -1;
    for (let i = cursor; i < enabled.length; i++) {
      const key = sig(i, enabled[i]);
      if (!tested.has(key)) { hit = enabled[i]; hitIdx = i; tested.add(key); break; }
    }
    if (!hit) {
      for (let i = 0; i < cursor; i++) {
        const key = sig(i, enabled[i]);
        if (!tested.has(key)) { hit = enabled[i]; hitIdx = i; tested.add(key); break; }
      }
    }
    if (!hit) break;
    cursor = hitIdx + 1;
    await press(viewName, hit, container);
  }
  const total = queryAll(container, 'button').length;
  const unused = queryAll(container, 'button').filter((b) => b.disabled).length;
  console.log(`== ${viewName}: 已点 ${tested.size} 个, 剩禁用 ${unused}/${total} ==`);
  if (tested.size === 0) check(`[${viewName}] 渲染出可用按钮`, false, '容器里一个可用 button 都没有');
}

// ---------- 加载依赖 ----------
load('app/store.js');
load('core/builtin_profiles.js');
load('core/review.js');
load('core/vocab_stats.js');
load('core/title_cleanup.js');
load('core/import_guard.js');
load('app/page_toolbar.js');
load('views/library/cover.js');
load('views/library/status.js');
load('views/library/preview_modal.js');
load('views/library/edition_profile_modal.js');
load('views/library/book_settings_modal.js');
load('views/library/import_export.js');
load('views/library_view.js');
load('views/models_view.js');
load('views/vocab_view.js');
load('views/prep/retry_dialog.js');
load('views/prep_view.js');
load('views/settings/system_tab.js');
load('views/settings/models_tab.js');
load('views/settings/profiles_tab.js');
load('views/settings/sync_tab.js');
load('views/settings/reading_tab.js');
load('views/settings_view.js');

async function main() {
  // 1. 书库 (原版) —— 含译本子卡与折叠开关
  {
    const store = new globalThis.AiduStore();
    const lv = new globalThis.LibraryView(store, 'original');
    lv.onOpenBook = (b) => openCalls.push('lib:' + (b && b.id));
    const c = makeElement('div');
    lv.render(c);
    await walk('library(原版)', c);
  }

  // 2. 书库 (成品架) —— 含成品缺失红卡两出口
  {
    globalThis.AiduLibraryService.list = async () => ({ ok: true, data: [missingProduct] });
    const store = new globalThis.AiduStore();
    const lv = new globalThis.LibraryView(store, 'product');
    lv.onOpenBook = (b) => openCalls.push('lib:' + (b && b.id));
    const c = makeElement('div');
    lv.render(c);
    await walk('library(成品架)', c);
  }

  // 3. 模型与依赖 —— 已登记模型 (换一个/设为推荐/移除/扫描/添加自定义)
  {
    const store = new globalThis.AiduStore();
    const mv = new globalThis.ModelsView(store);
    const c = makeElement('div');
    mv.render(c);
    await walk('models(有模型)', c);
  }

  // 4. 模型与依赖 —— 无模型 (三个 去下载, 其中 nlp 无目录项 —— M4-1 不许空对话框)
  {
    globalThis.AiduModelService.list = async () => ({ ok: true, data: [] });
    const store = new globalThis.AiduStore();
    const mv = new globalThis.ModelsView(store);
    const c = makeElement('div');
    mv.render(c);
    await walk('models(无模型)', c);
  }

  // 5. 设置 (全部 tab) —— 含书库位置三按钮 / 同步动作 / 在线引擎 / 档案
  {
    const store = new globalThis.AiduStore();
    const sv = new globalThis.SettingsView(store);
    const c = makeElement('div');
    sv.render(c);
    await walk('settings', c);
    store.state.settingsTab = null;
  }

  // 6. 生词本 —— 开始复习 (M2) / 备份恢复导出 / 词频剔除 / 打散
  {
    const AiduStoreClass = globalThis.AiduStore;
    const storeV = new AiduStoreClass();
    globalThis.AiduStore = storeV;
    const vv = new globalThis.VocabView(storeV);
    vv.setRouter({ navigate: (r) => navCalls.push('vocab:' + r) });
    const c = makeElement('div');
    vv.render(c);
    await walk('vocab', c);
    globalThis.AiduStore = AiduStoreClass;
  }

  // 7. 处理中 —— 全部暂停/继续 + 任务行按钮
  {
    const store = new globalThis.AiduStore();
    const pv = new globalThis.PrepView(store);
    pv.onOpenBook = (id) => openCalls.push('prep:' + id);
    const c = makeElement('div');
    pv.render(c);
    await walk('prep', c);
    pv.cleanup();
  }

  console.log('');
  console.log(`点击按钮 ${clicked} 个, 跳过禁用 ${skipped} 个`);
  console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
