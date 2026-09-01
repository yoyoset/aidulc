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
    contains(other) { let n = other; while (n) { if (n === el) return true; n = n.parentNode; } return false; },
    closest(sel) { let n = el; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; },
    // 事件: 原来是纯空实现。STDIMPORT (2026-08-17) 要测"改下拉 → 联动改单选",
    // 补成"记下来, 只有测试显式 dispatchEvent 时才触发"——现有测试没人调
    // dispatchEvent, 所以对它们是零行为变化(空实现下本来也一个都不会触发)。
    _handlers: {},
    addEventListener(ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) { el._handlers[ev] = (el._handlers[ev] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { (el._handlers[(ev && ev.type) || ''] || []).forEach((fn) => fn(ev)); return true; },
    focus() {},
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
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
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
const calls = { remove: [], pickFiles: [], retryCustom: [] };
globalThis.AiduJobService = {
  list: async () => ({ ok: true, data: [] }),
  remove: async (id) => { calls.remove.push(id); return { ok: true }; },
  pause: async () => ({ ok: true }), resume: async () => ({ ok: true }),
  pauseAll: async () => ({ ok: true }), resumeAll: async () => ({ ok: true }),
  retryFailed: async () => ({ ok: true }), detail: async () => ({ ok: true, data: {} }),
  retryCustom: async (id, llmId, ttsId, nlpId, forceStages, profileId) => { calls.retryCustom.push({ id, llmId, ttsId, nlpId, forceStages, profileId: profileId || null }); return { ok: true }; },
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
  readImage: async () => ({ ok: true, data: null }), backfillCover: async () => ({ ok: true, data: { cover: "cover.jpg" } }),
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
  // STDIMPORT (2026-08-17): 导入前体检。默认全部达标 (个别用例会覆盖成 block/warn)
  auditSources: async (paths) => paths.map(() => ({ verdict: 'ok', issues: [] })),
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
  backendToggle: async () => ({ ok: true }),
};
globalThis.AiduDictionaryService = { list: async () => ({ ok: true, data: [] }), vocabAll: async () => ({ ok: true, data: [] }), lookup: async () => ({ ok: true, data: {} }), lookupOnline: async () => ({ ok: true, data: ['NOUN', '', ['在线释义'], [], [], '', []] }), addToVocab: async () => ({ ok: true, data: { added: 'x', common_word: false } }), vocabRemove: async () => ({ ok: true }), srsPreview: async () => ({ ok: true, data: { options: [1,2,3,4].map((g) => ({ grade: g, human: g + ' 天' })) } }), srsGrade: async (p, l, g) => ({ ok: true, data: {} }), srsRestore: async () => ({ ok: true, data: {} }), vocabCommonPreview: async () => ({ ok: true, data: { count: 0, top_n: 3000, lemmas: [] } }), vocabRemoveCommon: async () => ({ ok: true, data: { removed: 0, backup_path: '' } }), vocabBacklogPreview: async () => ({ ok: true, data: { backlog_count: 0, daily_cap: 40, days: 0, today_after: 0, today_before: 0 } }), vocabBacklogSpread: async () => ({ ok: true, data: { spread: 0, days: 0, backup_path: '' } }), ttsCacheWord: async () => ({ ok: true }), vocabReadCachedAudio: async () => ({ ok: true, data: null }), vocabAudioStart: async (words) => ({ ok: true, data: { running: true, total: words.length, done: 0, synthesized: 0, skipped: 0, failed: 0, current: '', outcome: '', finished_at: 0 } }), vocabAudioStatus: async () => ({ ok: true, data: { running: false, total: 0, done: 0, synthesized: 0, skipped: 0, failed: 0, current: '', outcome: '', finished_at: 0 } }), vocabAudioCancel: async () => ({ ok: true }) };
globalThis.AiduReadingService = { get: async () => ({ ok: true, data: null }), save: async () => ({ ok: true }), stats: async () => ({ ok: true, data: {} }) };
globalThis.AiduMiscService = {
  logPath: async () => ({ ok: true, data: { path: 'C:/log' } }), componentsHealth: async () => ({ ok: true, data: [] }),
  runtimeConfig: async () => ({ ok: true, data: {} }), openPath: async () => ({ ok: true }),
  libraryDirGet: async () => ({ ok: true, data: 'C:/aidulc-data' }),
  libraryRootStatus: async () => ({ ok: true, data: { root: 'C:/aidulc-data', db_path: 'C:/aidulc-data/data.db', exists: true, writable: true, ok: true, reason: '', db_exists: true, out_dir: 'C:/aidulc-data/jobs_out', out_inside_root: true } }),
  libraryOutConsolidate: async () => ({ ok: true, data: { old_out: 'E:/aidulc_data', new_out: 'C:/aidulc-data/jobs_out', backup_path: 'C:/aidulc-data/backups/x', restart_required: true } }),
  dataRootRecommended: async () => ({ ok: true, data: { path: 'C:/Users/x/Documents/aidulc' } }),
  libraryDirPickAndSet: async () => ({ ok: true, data: { cancelled: true } }), libraryDirPick: async () => ({ ok: true, data: { cancelled: true } }), libraryDirScan: async () => ({ ok: true, data: { importable: [], existing: [] } }), libraryDirImport: async () => ({ ok: true, data: { imported: 0, failed: [] } }),
  docParserInstall: async () => ({ ok: true, data: { ok: true } }),
  // J0 (2026-08-11): 数据目录 / 迁移 (smoke stub: 无待迁移)
  dataMigrationStatus: async () => ({ ok: true, data: { portable: false, data_dir: 'C:/aidulc', db_path: 'C:/aidulc/data.db', out_dir: 'C:/aidulc/jobs_out', pending: false } }),
  dataMigrationDryRun: async () => ({ ok: true, data: { pending: false } }),
  dataMigrationRun: async () => ({ ok: true, data: { ok: true, restart_required: true, backup_path: 'C:/aidulc/backups/x.aidu-data', out_moved: 0, target_out: 'C:/aidulc/jobs_out', target_db: 'C:/aidulc/data.db' } }),
  onlineConfigGet: async () => ({ ok: true, data: { endpoint: '', model: '', key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigSet: async () => ({ ok: true, data: { saved: true, key_configured: false, lookup_enabled: false, whole_book_enabled: false } }),
  onlineConfigTest: async () => ({ ok: true, data: { ok: true, reply: 'ok' } }),
  // 2026-08-21: 词典基底统计/导入 (查词三层重构, 设置里"选择词典文件")
  gpuStatus: async () => ({ ok: true, data: { available: false, shouldWarn: false, foreignProcesses: [] } }),
  dictBaseStats: async () => ({ ok: true, data: [{ source: 'seed', count: 19139 }] }),
  dictBaseImportFile: async () => ({ ok: true, data: { imported: 0, skipped_existing: 0, total_rows: 0 } }),
};
globalThis.ModelsView = class { constructor() {} render(c) { c.innerHTML = 'MODELS'; } };
globalThis.AiduVocabStats = { dailyBuckets: () => [] };

// ---- 加载被改动的视图及其依赖 ----
load('app/store.js');
load('components/modal.js');
load('components/toast.js');
load('core/import_guard.js');
load('core/builtin_profiles.js');
load('core/rerun_scope.js');
load('core/import_gate.js');
load('core/cover_cache.js');
load('views/library/cover.js');
load('views/library/status.js');
load('views/library/preview_modal.js');
load('views/library/edition_profile_modal.js');
load('views/library/book_settings_modal.js');
load('views/library/import_export.js');
load('views/library_view.js');
load('views/prep/retry_dialog.js');
load('views/prep_view.js');
load('views/settings/system_tab.js');
load('views/settings/models_tab.js');
load('views/settings/profiles_tab.js');
load('views/settings/sync_tab.js');
load('views/settings/reading_tab.js');
load('views/settings_view.js');

// modal.js 加载时会覆盖全局 AiduModal, 这里重新装捕获确认的 stub
globalThis.AiduModal = { confirm: (opts) => { confirmCaptured = opts; return { close() {} }; } };

const store = new globalThis.AiduStore();

console.log('== 1d. UX5 修正 (2026-08-13): 失败任务给「去修模型」入口 (TTS/模型类错误) ==');
{
  const pv1d = new globalThis.PrepView(store);
  const mkErr = (error) => ({ id: 'job-x', status: 'failed', stage: 'tts', current: 3, total: 240, progress: 57, error, book_path: 'C:/Books/Alice.epub', profile_id: 'default', output_dir: 'C:/out/job-x', batch_id: null });
  // 模型类错误 → 有「去修模型」按钮
  const rowM = pv1d._buildTaskRow(mkErr('TTS voices 目录不存在: F:/hf_cache/.../voices'));
  const fixBtn = queryAll(rowM, 'button').find((b) => b.textContent === '去修模型');
  check('UX5修正: TTS 类失败 → 有「去修模型」按钮', !!fixBtn);
  const hashBefore = location.hash;
  fixBtn && fixBtn.onclick();
  // K17 (2026-08-14): 改跳"模型中心"(#/models, 有下载能力) 而非"设置→依赖组件"(只有版本检查);
  // TTS 类错误文本能猜出家族时带 focus=tts, 到那边直接弹下载单。
  check('K17: 点「去修模型」→ 跳 #/models?focus=tts', location.hash === '#/models?focus=tts', 'hash=' + location.hash);
  location.hash = hashBefore;
  // 非模型类错误 → 没有「去修模型」(不该误导)
  const rowN = pv1d._buildTaskRow(mkErr('文件格式不支持: .djvu'));
  check('UX5修正: 非模型类失败不显示「去修模型」', !queryAll(rowN, 'button').some((b) => b.textContent === '去修模型'));
  // 有重试按钮 (恢复路径仍在)
  // STDIMPORT (2026-08-17): 「重试失败句」和「重跑…」合并成单一「重新处理…」入口
  // (「只补失败句」降级成对话框里的默认重跑范围, 语义等价)。恢复路径仍在, 只是少一个概念。
  check('UX5修正: 失败行仍有恢复入口「重新处理…」', !!queryAll(rowM, 'button').find((b) => b.textContent === '重新处理…'));
}

console.log('== 1d-2. 补全发音后台任务 (2026-08-17): 处理中页单独一行, 有进度条和取消 ==');
{
  const pv = new globalThis.PrepView(store);
  pv._vocabSlot = makeElement('div');

  // 从没跑过 → 不占位置
  pv._renderVocabAudio(null);
  check('补发音: 没跑过时不占位置', pv._vocabSlot._children.length === 0);
  pv._renderVocabAudio({ running: false, total: 0, done: 0, synthesized: 0, skipped: 0, failed: 0, current: '', outcome: '' });
  check('补发音: total=0 也不占位置', pv._vocabSlot._children.length === 0);

  // 跑动中 → 有进度条 + 取消按钮 + 三个计数分开报
  pv._renderVocabAudio({ running: true, total: 100, done: 40, synthesized: 30, skipped: 8, failed: 2, current: 'hatchet', outcome: '' });
  const card = queryAll(pv._vocabSlot, '.prep-task')[0];
  check('补发音: 跑动中出现任务卡', !!card);
  check('补发音: 标题是「补全生词发音」', !!queryAll(card, '.prep-task-title').find((n) => n.textContent === '补全生词发音'));
  const st = queryAll(card, '.prep-task-status')[0];
  check('补发音: 状态显示 已处理/总数 + 当前词', st && st.textContent === '40/100 · hatchet', st && st.textContent);
  const fill = queryAll(card, '.prep-bar-fill')[0];
  check('补发音: 进度条按 done/total 走', fill && fill.style.width === '40%', fill && fill.style.width);
  const cancelBtn = queryAll(card, 'button').find((b) => b.textContent === '取消');
  check('补发音: 跑动中有取消按钮', !!cancelBtn);
  const meta = queryAll(card, '.preview-meta')[0];
  check('补发音: 新合成/跳过/失败 三个数分开报 (跳过不是失败)',
    meta && meta.textContent === '新合成 30 · 已有缓存跳过 8 · 失败 2', meta && meta.textContent);

  // 结束后仍留一条结果摘要, 且没有取消按钮
  pv._renderVocabAudio({ running: false, total: 100, done: 100, synthesized: 90, skipped: 10, failed: 0, current: '', outcome: 'done' });
  const card2 = queryAll(pv._vocabSlot, '.prep-task')[0];
  check('补发音: 跑完仍留结果摘要 (不是弹个 toast 就没了)', !!card2);
  check('补发音: 跑完状态是「已完成」', queryAll(card2, '.prep-task-status')[0].textContent === '已完成');
  check('补发音: 跑完没有取消按钮', !queryAll(card2, 'button').some((b) => b.textContent === '取消'));

  pv._renderVocabAudio({ running: false, total: 100, done: 42, synthesized: 40, skipped: 2, failed: 0, current: '', outcome: 'canceled' });
  check('补发音: 取消后状态是「已取消」', queryAll(pv._vocabSlot, '.prep-task-status')[0].textContent === '已取消');
}

console.log('== 1e. 重新处理 (2026-08-13 / STDIMPORT 2026-08-17): 单一入口 + 对话框 (3 模型 + 档案下拉 + 重跑范围) ==');
{
  const pv = new globalThis.PrepView(store);
  pv._listEl = makeElement('div');
  const mkErr = (error) => ({ id: 'job-rerun', status: 'failed', stage: 'tts', current: 3, total: 240, progress: 57, error, book_path: 'C:/Books/Alice.epub', profile_id: 'default', output_dir: 'C:/out/job-rerun', batch_id: null });
  const row = pv._buildTaskRow(mkErr('TTS voices 目录不存在: F:/hf_cache/...'));
  const btnRerun = queryAll(row, 'button').find((b) => b.textContent === '重新处理…');
  check('重新处理: 失败行有「重新处理…」按钮', !!btnRerun);
  // 合并后不该再并排出现第二个重跑入口 (用户反馈"两个重跑分不清")
  check('重新处理: 不再并排「重跑…」/「重试失败句」两个入口',
    !queryAll(row, 'button').some((b) => b.textContent === '重跑…' || b.textContent === '重试失败句'));

  // 覆盖模型 stub: 给对话框填充 llm/tts/nlp 各一个已登记模型 (对话框异步拉取)
  // 档案下拉的数据源 (STDIMPORT): 当前档案 default + 一个可切换的 kid
  const origProfilesList = globalThis.AiduBridge.profiles.list;
  globalThis.AiduBridge.profiles.list = async () => ({ ok: true, data: [
    { id: 'default', name: '成人自读', explain_strategy: 'brief', explain_max_chars: 150, explain_min_sentence_chars: 0, voice: 'af_heart', speed: 1.0 },
    { id: 'kid', name: '儿童精讲', explain_strategy: 'deep', explain_max_chars: 150, explain_min_sentence_chars: 0, voice: 'af_heart', speed: 1.0 },
  ]});
  const origModelsList = globalThis.AiduModelService.list;
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'llm|en|qwen3-4b|q4', family: 'llm', model_id: 'qwen3-4b', active: true },
    { id: 'tts|en|kokoro|v1', family: 'tts', model_id: 'kokoro', active: true },
    { id: 'nlp|en|spacy|v3', family: 'nlp', model_id: 'spacy', active: true },
  ]});

  btnRerun.onclick();
  const ov = queryAll(globalThis.document.body, '.modal-overlay').at(-1);
  await Promise.resolve(); // 等模型下拉异步填充
  check('手动重跑: 点击后出现对话框 (.modal-overlay)', !!ov);
  const selAll = queryAll(ov, 'select');
  check('重新处理: 对话框有 4 个下拉 (3 模型 + 学习档案)', selAll.length === 4, 'selects=' + selAll.length);
  const optTexts = (sel) => queryAll(sel, 'option').map((o) => o.textContent);
  check('手动重跑: 翻译下拉有「保持当前」+ qwen3-4b', optTexts(selAll[0]).includes('保持当前 (书级绑定/推荐)') && optTexts(selAll[0]).some((t) => t.includes('qwen3-4b')), JSON.stringify(optTexts(selAll[0])));
  check('手动重跑: 语音下拉有 kokoro', optTexts(selAll[1]).some((t) => t.includes('kokoro')), JSON.stringify(optTexts(selAll[1])));
  check('手动重跑: 分词下拉有 spacy', optTexts(selAll[2]).some((t) => t.includes('spacy')), JSON.stringify(optTexts(selAll[2])));
  check('重新处理: 档案下拉有「保持当前」+ 两个档案, 当前档案带 (当前) 标记',
    optTexts(selAll[3]).includes('保持当前') && optTexts(selAll[3]).includes('成人自读 (当前)') && optTexts(selAll[3]).includes('儿童精讲'),
    JSON.stringify(optTexts(selAll[3])));
  const radios = queryAll(ov, 'input').filter((i) => i.type === 'radio');
  check('手动重跑: 重跑范围 5 个单选 (自动/从翻译/从讲解/从语音/全部)', radios.length === 5, 'radios=' + radios.length);
  check('手动重跑: 单选默认「自动」(checked)', radios.length === 5 && radios[0].checked, JSON.stringify(radios.map((r) => ({ v: r.value, c: r.checked }))));
  const startBtn = queryAll(ov, 'button').find((b) => b.textContent === '开始重跑');
  check('手动重跑: 有「开始重跑」按钮', !!startBtn);
  // 联动 (STDIMPORT): 换成讲解策略不同的档案 → 默认范围自动跳到「从讲解」, 不必全量重跑
  selAll[3].value = 'kid';
  selAll[3].dispatchEvent({ type: 'change' });
  check('重新处理: 换讲解档案 → 默认范围自动变「从讲解」',
    radios.find((r) => r.value === 'explain') && radios.find((r) => r.value === 'explain').checked,
    JSON.stringify(radios.map((r) => ({ v: r.value, c: r.checked }))));
  selAll[3].value = '';
  selAll[3].dispatchEvent({ type: 'change' });

  // 默认自动 + 不选模型 → retryCustom(id, null, null, null, null)
  const before = calls.retryCustom.length;
  startBtn.onclick();
  await Promise.resolve();
  const autoCall = calls.retryCustom.at(-1);
  check('手动重跑: 点开始调 retryCustom (默认自动)', calls.retryCustom.length === before + 1 && !!autoCall, JSON.stringify(autoCall));
  check('手动重跑: 默认传 job id', autoCall && autoCall.id === 'job-rerun', JSON.stringify(autoCall));
  check('手动重跑: 默认模型为空 (null)', autoCall && autoCall.llmId === null && autoCall.ttsId === null && autoCall.nlpId === null, JSON.stringify(autoCall));
  check('手动重跑: 自动范围 → forceStages null', autoCall && autoCall.forceStages === null, JSON.stringify(autoCall));
  check('重新处理: 未换档案 → profileId null', autoCall && autoCall.profileId === null, JSON.stringify(autoCall));

  // 重开: 选模型 + 从语音 → retryCustom(id, llm, tts, nlp, ['tts'])
  btnRerun.onclick();
  const ov2 = queryAll(globalThis.document.body, '.modal-overlay').at(-1);
  await Promise.resolve();
  const s2 = queryAll(ov2, 'select');
  s2[0].value = 'llm|en|qwen3-4b|q4';
  s2[1].value = 'tts|en|kokoro|v1';
  s2[2].value = 'nlp|en|spacy|v3';
  const r2 = queryAll(ov2, 'input').filter((i) => i.type === 'radio');
  r2.forEach((x) => { x.checked = (x.value === 'tts'); });
  const before2 = calls.retryCustom.length;
  queryAll(ov2, 'button').find((b) => b.textContent === '开始重跑').onclick();
  await Promise.resolve();
  const ttsCall = calls.retryCustom.at(-1);
  check('手动重跑: 选模型后调 retryCustom 带模型 id', ttsCall && ttsCall.llmId === 'llm|en|qwen3-4b|q4' && ttsCall.ttsId === 'tts|en|kokoro|v1' && ttsCall.nlpId === 'nlp|en|spacy|v3', JSON.stringify(ttsCall));
  check('手动重跑: 从语音 → forceStages ["tts"]', ttsCall && JSON.stringify(ttsCall.forceStages) === JSON.stringify(['tts']), JSON.stringify(ttsCall.forceStages));

  // 重开: 全部 → forceStages 全列
  btnRerun.onclick();
  const ov3 = queryAll(globalThis.document.body, '.modal-overlay').at(-1);
  await Promise.resolve();
  const r3 = queryAll(ov3, 'input').filter((i) => i.type === 'radio');
  r3.forEach((x) => { x.checked = (x.value === 'all'); });
  const before3 = calls.retryCustom.length;
  queryAll(ov3, 'button').find((b) => b.textContent === '开始重跑').onclick();
  await Promise.resolve();
  const allCall = calls.retryCustom.at(-1);
  check('手动重跑: 全部 → forceStages 四阶段全列', allCall && JSON.stringify(allCall.forceStages) === JSON.stringify(['translate', 'explain', 'tts', 'align']), JSON.stringify(allCall.forceStages));

  globalThis.AiduModelService.list = origModelsList;
  globalThis.AiduBridge.profiles.list = origProfilesList;
  calls.retryCustom.length = 0;
}

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

console.log('== 2d3. UX5 #6 (2026-08-13): 在线引擎 deepseek-v4-flash 预填 + 清除 key 按钮 ==');
{
  store.state.settingsTab = 'system';
  const clearCalls = [];
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: '', model: '', key_configured: true, lookup_enabled: false, whole_book_enabled: false } });
  globalThis.AiduMiscService.onlineConfigClearKey = async () => { clearCalls.push(1); return { ok: true, data: { cleared: true, key_configured: false } }; };
  const sv6 = new globalThis.SettingsView(store);
  const c6 = makeElement('div');
  sv6.render(c6);
  await new Promise((r) => setTimeout(r, 100));
  store.state.settingsTab = null;
  // 模型预填 deepseek-v4-flash
  const modelInput = queryAll(c6, 'input').find((i) => i.placeholder && i.placeholder.includes('模型名'));
  check('UX5#6: 模型输入预填 deepseek-v4-flash', modelInput && modelInput.value === 'deepseek-v4-flash', 'value=' + (modelInput && modelInput.value));
  check('UX5#6: 模型占位符提示预设', modelInput && modelInput.placeholder.includes('deepseek-v4-flash'), modelInput && modelInput.placeholder);
  // 清除 key 按钮: 有 key 时可点; 点 → 确认 → 调 onlineConfigClearKey → 开关置灰 + 状态未配置
  const clearBtn = queryAll(c6, 'button').find((b) => b.textContent === '清除在线引擎 key');
  check('UX5#6: 有「清除在线引擎 key」按钮且可点', clearBtn && clearBtn.disabled === false, 'disabled=' + (clearBtn && clearBtn.disabled));
  confirmCaptured = null;
  clearBtn && clearBtn.onclick();
  check('UX5#6: 清除前有确认弹窗', confirmCaptured && confirmCaptured.confirmText === '清除', confirmCaptured && confirmCaptured.title);
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 40));
  check('UX5#6: 确认后调 onlineConfigClearKey', clearCalls.length === 1, 'calls=' + clearCalls.length);
  const status6 = queryAll(c6, '.sync-status').find((s) => s.textContent && s.textContent.includes('已清除在线引擎 key'));
  check('UX5#6: 清除后状态显示未配置', !!status6, 'status=' + queryAll(c6, '.sync-status').map((s) => s.textContent).join('|'));
  const chk6 = (labelPart) => queryAll(c6, 'input').find((x) => {
    if (x.type !== 'checkbox') return false;
    const p = x.parentNode;
    if (!p) return false;
    return (p._children || []).map((y) => String(y.textContent || '')).join('').includes(labelPart);
  });
  const lookup6 = chk6('查词失败时可用在线 AI');
  const whole6 = chk6('整本翻译/讲解');
  check('UX5#6: 清除 key 后两档开关置灰', lookup6 && lookup6.disabled === true && whole6 && whole6.disabled === true,
    'lookup=' + (lookup6 && lookup6.disabled) + ' whole=' + (whole6 && whole6.disabled));
  check('UX5#6: 清除 key 后开关取消勾选', lookup6 && !lookup6.checked && whole6 && !whole6.checked);
}

console.log('== 2d4. UX5 #6 (2026-08-13): L8② 整本外发入口 —— 书卡菜单 + 发前确认外发量 ==');
{
  load('core/title_cleanup.js');
  // 场景: ①未开启② → 点菜单 → toast 提示去设置; ②开启+key → 弹确认框含外发量 → 确认调 book_online_translate
  const toasts = [];
  const toastsOrig = globalThis.AiduToast;
  globalThis.AiduToast = { show: (t, k) => toasts.push([t, k]) };
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: 'https://x/v1', model: 'deepseek-v4-flash', key_configured: true, lookup_enabled: false, whole_book_enabled: false } });
  const lv6 = new globalThis.LibraryView(store, 'original');
  lv6._profiles = [{ id: 'default', name: '成人自读' }];
  const book6 = { id: 's1', title: 'Alice.epub', kind: 'original', editions: [{ id: 'e1', title: 'Alice 译本', status: 'ready' }] };
  lv6._openBookMenu(book6, { online: true });
  await new Promise((r) => setTimeout(r, 30));
  const ov6 = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  const menuItem6 = ov6 && queryAll(ov6, 'button').find((b) => b.textContent === '整本翻译/讲解(在线)');
  check('UX5#6: 书卡 ⋯ 菜单有「整本翻译/讲解(在线)」', !!menuItem6);
  menuItem6 && menuItem6.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('UX5#6: ②未开启 → 提示去设置开启', toasts.some(([t]) => t.includes('整本翻译/讲解') && t.includes('开启')), JSON.stringify(toasts));
  // 开启② + 有 key → 弹确认框 (发前外发量可见)
  confirmCaptured = null;
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { endpoint: 'https://x/v1', model: 'deepseek-v4-flash', key_configured: true, lookup_enabled: false, whole_book_enabled: true } });
  globalThis.AiduLibraryService.loadBookpack = async () => ({ ok: true, data: { basePath: 'D:/packs/e1', bookpack: { title: 'Alice', chapters: [{ sentences: [{ original_text: 'Hello world.' }, { original_text: 'Second sentence longer.' }] }] } } });
  const onlineCalls6 = [];
  globalThis.AiduBridge.invoke = async (cmd, args) => {
    if (cmd === 'book_online_translate') { onlineCalls6.push(args); return { ok: true, data: { edition_id: 'online-e1', sentences_done: 2, sentences_failed: 0, model: 'deepseek-v4-flash', source_id: 's1' } }; }
    return { ok: true, data: {} };
  };
  lv6._onlineWholeBook(book6);
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#6: 开启② → 发前弹确认框 (含全书外发量)', confirmCaptured && confirmCaptured.title.includes('整本翻译/讲解') &&
    String(confirmCaptured.message).includes('2 句') && String(confirmCaptured.message).includes('外发量可能很大'), confirmCaptured && confirmCaptured.title);
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#6: 确认后调 book_online_translate(bookId=e1)', onlineCalls6.some((a) => a && a.bookId === 'e1'), JSON.stringify(onlineCalls6));
  check('UX5#6: 完成后 toast 报成功句数', toasts.some(([t]) => t.includes('在线整本翻译完成') && t.includes('2 句成功')), JSON.stringify(toasts));
  // 还原
  globalThis.AiduToast = toastsOrig;
  globalThis.AiduBridge.invoke = async () => ({ ok: true, data: null });
  const lastOv6 = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  if (lastOv6 && lastOv6.remove) lastOv6.remove();
}

console.log('== 2d2. L8 (2026-08-11): 查词失败面板 —— 开关①开才有在线入口, 关则无 ==');{
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

console.log('== 2d3. UX6 #4 (2026-08-13): 词典面板治理 —— 点正文收起 / 长内容分段可折叠 / 底部非历史讲清楚 ==');
{
  load('components/dictionary_panel.js');
  // 2026-08-21: 成功渲染现在也会 fire-and-forget 查一次在线开关配置(见
  // _maybeAppendOnlineLookup)——上一个 2d2 测试块把这个 mock 留在 lookup_enabled:
  // true, 不在这里先重置成确定值的话, 前一块遗留的悬空 promise 会在本块第一次
  // await 时才落地, 混进本块自己的断言里(实测踩到, 断言随机多一个按钮)。
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { lookup_enabled: false } });
  const lookupCalls = [];
  globalThis.AiduDictionaryService.lookup = async (w) => {
    lookupCalls.push(w);
    return { ok: true, data: { word: w, pos: 'NOUN', phonetic: '/rɛtɪsnt/', meanings: ['含蓄的', '寡言的'], examples: ['He was reticent about his plans.'], example_zh: ['他对计划很含蓄。'], usage: '正式场合形容人不愿多谈', phrases: ['be reticent about'], in_vocab: false, source: 'llm' } };
  };
  const p4 = new globalThis.DictionaryPanel();
  p4.el = makeElement('div');
  p4.el.className = 'dict-panel';
  p4.body = makeElement('div');
  p4.el.appendChild(p4.body);
  document.body.appendChild(p4.el);
  p4.onVocabAdded = () => {};
  p4._word = 'reticent';
  p4._profileId = 'default';
  p4._context = 'He was reticent.';
  p4._render({ word: 'reticent', pos: 'NOUN', phonetic: '/rɛtɪsnt/', meanings: ['含蓄的', '寡言的'], examples: ['He was reticent about his plans.'], example_zh: ['他对计划很含蓄。'], usage: '正式场合形容人不愿多谈', phrases: ['be reticent about'], in_vocab: false, source: 'llm' });
  // 面板结构: 分段标题 (释义/例句/用法/搭配) 都出现, 不再是没标题的长尾巴
  const secHeads = queryAll(p4.body, '.dict-sec-head').map((h) => h.textContent);
  check('UX6#4: 面板分段有标题 (释义/例句/用法/搭配)', ['释义', '例句', '用法', '搭配'].every((l) => secHeads.includes(l)), 'heads=' + secHeads.join(','));
  check('UX6#4: 每段可折叠 (有 .dict-sec-head 点击切换)', queryAll(p4.body, '.dict-sec').length >= 4, 'secs=' + queryAll(p4.body, '.dict-sec').length);
  const meaningsBody = queryAll(p4.body, '.dict-sec')[0].querySelector('.dict-sec-body');
  const beforeHidden = meaningsBody.classList.contains('dict-sec-collapsed');
  queryAll(p4.body, '.dict-sec-head')[0].onclick();
  check('UX6#4: 点段头 → 该段折叠 (dict-sec-collapsed)', meaningsBody.classList.contains('dict-sec-collapsed'), 'before=' + beforeHidden);
  queryAll(p4.body, '.dict-sec-head')[0].onclick();
  check('UX6#4: 再点段头 → 展开', !meaningsBody.classList.contains('dict-sec-collapsed'));
  // 底部不是查询历史 (讲清楚)
  const srcText = queryAll(p4.body, '.dict-source').map((s) => s.textContent).join(' ');
  check('UX6#4: 底部明确"不是查询历史"', srcText.includes('不是查询历史'), srcText);
  // 2026-08-21 (查词三层重构, 改了 UX6 #3 原来的行为): 开关①关闭时, 哪怕查词
  // 成功也不该出现在线入口(发不出去的东西不该有按钮)——这条不变。
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { lookup_enabled: false } });
  p4._render({ word: 'reticent', pos: 'NOUN', phonetic: '/rɛtɪsnt/', meanings: ['含蓄的'], examples: ['x'], example_zh: ['y'], usage: 'z', phrases: [], in_vocab: false, source: 'llm' });
  await new Promise((r) => setTimeout(r, 20));
  check('开关①关: 查词成功也无在线入口', !queryAll(p4.body, 'button').some((b) => b.textContent === '用在线 AI 查一次'), queryAll(p4.body, 'button').map((b) => b.textContent).join(','));
  // 2026-08-21 拍板改动: 开关①开启时, 查词成功(不管是 local/base/llm 哪个来源)
  // 也该出现在线入口——"本地给了答案、用户还是不确定"时不必等到彻底查不到
  // 才能点"用在线 AI 查一次"。旧版本 UX6 #3 的"绝不在成功路径出现"已不再成立。
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { lookup_enabled: true } });
  p4._render({ word: 'reticent', pos: 'NOUN', phonetic: '/rɛtɪsnt/', meanings: ['含蓄的'], examples: ['x'], example_zh: ['y'], usage: 'z', phrases: [], in_vocab: false, source: 'llm' });
  await new Promise((r) => setTimeout(r, 20));
  check('开关①开: 查词成功也提供在线入口(本地给了答案仍可再确认)', queryAll(p4.body, 'button').some((b) => b.textContent === '用在线 AI 查一次'), queryAll(p4.body, 'button').map((b) => b.textContent).join(','));

  // 2026-08-21 (查词三层重构): 基底命中(source='base')只有稳定字段, 面板要
  // 给一个"结合这句话再讲一下"的手动按钮触发本地小模型补全语境例句。
  globalThis.AiduMiscService.onlineConfigGet = async () => ({ ok: true, data: { lookup_enabled: false } });
  const enrichCalls = [];
  globalThis.AiduDictionaryService.lookup = async (w, profileId, ctx, forceLlm) => {
    enrichCalls.push({ w, forceLlm });
    return { ok: true, data: { word: w, pos: 'NOUN', phonetic: '/x/', meanings: ['基底释义'], examples: ['结合上下文的例句'], example_zh: ['例句翻译'], usage: '用法', phrases: [], in_vocab: false, source: 'llm' } };
  };
  const pBase = new globalThis.DictionaryPanel();
  pBase.el = makeElement('div'); pBase.body = makeElement('div'); pBase.el.appendChild(pBase.body);
  document.body.appendChild(pBase.el);
  pBase._word = 'zebra'; pBase._profileId = 'default'; pBase._context = 'A zebra ran past.';
  pBase._render({ word: 'zebra', pos: 'NOUN', phonetic: '/ˈziː.brə/', meanings: ['斑马'], examples: [], example_zh: [], usage: '', phrases: ['zebra crossing'], in_vocab: false, source: 'base' });
  const srcBadge = queryAll(pBase.body, '.dict-source-base')[0];
  check('基底命中: 来源徽章显示"词典基底"', srcBadge && srcBadge.textContent === '词典基底', srcBadge && srcBadge.textContent);
  const enrichBtn = queryAll(pBase.body, 'button').find((b) => b.textContent === '结合这句话再讲一下');
  check('基底命中: 有"结合这句话再讲一下"按钮', !!enrichBtn);
  enrichBtn.onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('点按钮 → 强制走 LLM (forceLlm=true)', enrichCalls.length === 1 && enrichCalls[0].forceLlm === true, JSON.stringify(enrichCalls));
  check('点按钮后重新渲染出语境例句', queryAll(pBase.body, '.dict-examples').length > 0);
  // 对照组: 非基底命中(llm/local)不该出现这个按钮
  pBase._render({ word: 'zebra', pos: 'NOUN', phonetic: '/x/', meanings: ['斑马'], examples: ['e'], example_zh: ['y'], usage: 'u', phrases: [], in_vocab: false, source: 'llm' });
  check('非基底命中: 无"结合这句话再讲一下"按钮', !queryAll(pBase.body, 'button').some((b) => b.textContent === '结合这句话再讲一下'));

  // 点正文 (面板外) → 自动收起
  p4._bindDocClick();
  p4.el.classList.add('open');
  const panelEl = p4.el;
  const docClick = (target) => { if (p4._onDocClick) p4._onDocClick({ target }); };
  const bodyEl = makeElement('div'); bodyEl.className = 'reader-content';
  docClick(bodyEl);
  check('UX6#4: 点正文空白 → 面板收起 (open 移除)', !panelEl.classList.contains('open'), 'open=' + panelEl.classList.contains('open'));
  // 点面板内按钮 → 不收
  panelEl.classList.add('open');
  const panelBtn = makeElement('button'); panelBtn.className = 'btn-small';
  panelBtn.textContent = '🔊 发音';
  panelEl.appendChild(panelBtn);
  docClick(panelBtn);
  check('UX6#4: 点面板内按钮 → 不收', panelEl.classList.contains('open'));
  // 点正文的词 (.bubble) → 不收 (那是查词入口, 由 _onWordClick 刷新面板)
  panelEl.classList.add('open');
  const bubble = makeElement('span'); bubble.className = 'bubble tok';
  docClick(bubble);
  check('UX6#4: 点正文的词 (.bubble) → 不收', panelEl.classList.contains('open'));
  panelEl.remove();
  if (p4._unbindDocClick) p4._unbindDocClick();
  lookupCalls.length = 0;
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

console.log('== 2f2. M3 (2026-08-13): 后端「同步此后端」勾选 + 所属主体 + 多后端同步 ==');
{
  store.state.settingsTab = 'sync';
  const toggles = [];
  const syncCalls = [];
  globalThis.AiduSyncService.backendsList = async () => ({ ok: true, data: [
    { name: '默认后端', url: 'https://a.workers.dev', active: true, connected: true, enabled: true, subject: '我' },
    { name: '家里', url: 'https://b.workers.dev', active: false, connected: true, enabled: false, subject: '我' },
    { name: '单位', url: 'https://c.workers.dev', active: false, connected: false, enabled: false, subject: '我' },
  ] });
  globalThis.AiduSyncService.backendToggle = async (name, enabled) => { toggles.push([name, enabled]); return { ok: true }; };
  globalThis.AiduSyncService.now = async () => { syncCalls.push(1); return { ok: true, data: [
    { name: '默认后端', worker_url: 'https://a.workers.dev', ok: true, status: 'synced', pending_count: 0, last_wrote: 2, last_pulled: 0, last_error: null },
    { name: '家里', worker_url: 'https://b.workers.dev', ok: true, status: 'synced', pending_count: 0, last_wrote: 5, last_pulled: 0, last_error: null },
  ] }; };
  const svM3 = new globalThis.SettingsView(store);
  const cM3 = makeElement('div');
  svM3.render(cM3);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const rowsM3 = queryAll(cM3, '.sync-backend-row');
  check('M3: 后端列表渲染 3 行', rowsM3.length === 3, 'rows=' + rowsM3.length);
  // 每个后端有「同步此后端」勾选 (有 token 才可点) + 所属主体
  const cbOf = (row) => {
    const lab = queryAll(row, '.sync-backend-enable')[0];
    if (!lab) return null;
    return (lab._children || []).find((c) => c.type === 'checkbox');
  };
  const subjOf = (row) => queryAll(row, '.sync-backend-subject')[0];
  check('M3: 有「同步此后端」勾选', rowsM3.every((r) => !!cbOf(r)));
  check('M3: 已连接后端勾选可点', cbOf(rowsM3[0]) && cbOf(rowsM3[0]).disabled === false && cbOf(rowsM3[1]) && cbOf(rowsM3[1]).disabled === false);
  check('M3: 未连接后端勾选置灰', cbOf(rowsM3[2]) && cbOf(rowsM3[2]).disabled === true);
  check('M3: 勾选状态回显 (a=启用, b=停用)', cbOf(rowsM3[0]).checked === true && cbOf(rowsM3[1]).checked === false);
  check('M3: 每项显示所属主体', rowsM3.every((r) => subjOf(r) && textOf(subjOf(r)).includes('我')));
  // 勾选「家里」→ backendToggle(name, true)
  cbOf(rowsM3[1]).checked = true;
  cbOf(rowsM3[1]).onchange();
  await new Promise((r) => setTimeout(r, 30));
  check('M3: 勾选 → backendToggle(家里, true)', toggles.some(([n, e]) => n === '家里' && e === true), JSON.stringify(toggles));
  // 立即同步 → 聚合每个已启用后端的结果
  const syncBtnM3 = queryAll(cM3, 'button').find((b) => b.textContent === '立即同步');
  syncBtnM3.onclick();
  await new Promise((r) => setTimeout(r, 60));
  const statusM3 = queryAll(cM3, '.sync-status').map((s) => s.textContent).join('\n');
  check('M3: 立即同步 → 调 sync_now', syncCalls.length === 1, 'calls=' + syncCalls.length);
  check('M3: 结果聚合展示「已同步 2 / 2 个后端」', statusM3.includes('已同步 2 / 2 个后端'), statusM3.slice(0, 100));
  check('M3: 各自推 N 条 (默认 2 / 家里 5)', statusM3.includes('推 2') && statusM3.includes('推 5'), statusM3.slice(0, 160));
}

console.log('== 2g. M5 + UX5 #4 (2026-08-12/13): 书库位置三按钮 + 整根迁移 + 绿色徽章 ==');
{
  store.state.settingsTab = 'system';
  // 徽章: 生效 → 绿色; 失效 → 红 + 原因
  globalThis.AiduMiscService.libraryRootStatus = async () => ({ ok: true, data: { root: 'D:/aidulc', db_path: 'D:/aidulc/data.db', exists: true, writable: true, ok: true, reason: '', db_exists: true, out_dir: 'D:/aidulc/jobs_out', out_inside_root: true } });
  // 更改… 新流程: pick → 确认 (L1 清单+备份) → libraryDirPickAndSet(newRoot) → 整根迁移结果
  const migrateCalls = [];
  globalThis.AiduMiscService.libraryDirPickAndSet = async (newDir) => { migrateCalls.push(newDir); return { ok: true, data: { cancelled: false, new_dir: newDir, backup_path: 'D:/aidulc-new/backups/x', restart_required: true, book_count: 3 } }; };
  globalThis.AiduMiscService.libraryDirPick = async () => ({ ok: true, data: { cancelled: false, path: 'D:/aidulc-new' } });
  globalThis.AiduMiscService.libraryDirGet = async () => ({ ok: true, data: 'D:/aidulc' });
  globalThis.AiduMiscService.libraryDirScan = async () => ({ ok: true, data: { importable: [], existing: [] } });
  globalThis.AiduMiscService.libraryDirImport = async () => ({ ok: true, data: { imported: 0, failed: [] } });
  const svM5 = new globalThis.SettingsView(store);
  const cM5 = makeElement('div');
  svM5.render(cM5);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const buttonsM5 = queryAll(cM5, 'button');
  const changeBtn = buttonsM5.find((b) => b.textContent === '更改…');
  const openBtnM5 = buttonsM5.find((b) => b.textContent === '在资源管理器中打开');
  const loadBtnM5 = buttonsM5.find((b) => b.textContent === '加载已有书库…');
  // 书库位置那一节 (含三个按钮的 .settings-section)
  const libSecM5 = queryAll(cM5, '.settings-section').find((s) => {
    const h2 = (s._children || []).find((x) => x.tagName === 'H2');
    return h2 && h2.textContent === '书库位置';
  });
  const libMsgOf = () => {
    const tips = queryAll(libSecM5, '.import-tip');
    return textOf(tips[tips.length - 1] || {});
  };
  // 排版: 三按钮收进 .page-toolbar (L5 间距)
  const tbM5 = changeBtn && changeBtn.parentNode;
  check('M5: 三按钮收进 .page-toolbar 一组', tbM5 && String(tbM5.className).includes('page-toolbar') &&
    [openBtnM5, changeBtn, loadBtnM5].every((b) => b && b.parentNode === tbM5), tbM5 && tbM5.className);
  // UX5 #4: 绿色生效徽章 (存在且可写)
  const badgeOk = libSecM5 && libSecM5.querySelector('.lib-badge');
  check('UX5#4: 生效位置绿色徽章 (.lib-badge-ok · 文案 生效中)', badgeOk && badgeOk.className.includes('lib-badge-ok') && badgeOk.textContent.includes('生效中'), badgeOk && (badgeOk.className + ' ' + badgeOk.textContent));
  // 更改成功: pick → 确认弹窗 (L1 清单+备份说明) → 确认 → 迁移 → 结果"已整根迁移到"
  confirmCaptured = null;
  changeBtn.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('UX5#4: 更改前弹确认 (整根迁移 + 备份 + 校验说明)', confirmCaptured && String(confirmCaptured.title).includes('整根迁移') &&
    String(confirmCaptured.message).includes('备份') && String(confirmCaptured.message).includes('校验'), confirmCaptured && confirmCaptured.title);
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 40));
  check('UX5#4: 确认后调 libraryDirPickAndSet(新根)', migrateCalls.includes('D:/aidulc-new'), JSON.stringify(migrateCalls));
  const libMsgText = libMsgOf();
  check('UX5#4: 迁移结果含「已整根迁移到」+ 备份路径 + 重启提示', libMsgText.includes('已整根迁移到 D:/aidulc-new') && libMsgText.includes('备份') && libMsgText.includes('重启'), libMsgText.slice(0, 140));
  // 更改取消: 明确说"已取消", 不静默
  globalThis.AiduMiscService.libraryDirPick = async () => ({ ok: true, data: { cancelled: true } });
  changeBtn.onclick();
  await new Promise((r) => setTimeout(r, 40));
  const cancelText = libMsgOf();
  check('M5: 更改取消 → 明确说「已取消, 书库位置未更改」', cancelText.includes('已取消') && cancelText.includes('书库位置未更改'), cancelText.slice(0, 80));
  // 失效徽章: 目录不可写 → 红 + 原因
  globalThis.AiduMiscService.libraryRootStatus = async () => ({ ok: true, data: { root: 'X:/gone', db_path: 'X:/gone/data.db', exists: false, writable: false, ok: false, reason: '目录不存在', db_exists: false, out_dir: '', out_inside_root: false } });
  const svM5b = new globalThis.SettingsView(store);
  const cM5b = makeElement('div');
  svM5b.render(cM5b);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const libSecM5b = queryAll(cM5b, '.settings-section').find((s) => {
    const h2 = (s._children || []).find((x) => x.tagName === 'H2');
    return h2 && h2.textContent === '书库位置';
  });
  const badgeErr = libSecM5b && libSecM5b.querySelector('.lib-badge');
  check('UX5#4: 失效位置红徽章 + 原因', badgeErr && badgeErr.className.includes('lib-badge-err') && badgeErr.textContent.includes('目录不存在'), badgeErr && (badgeErr.className + ' ' + badgeErr.textContent));
  // 加载已有书库取消: 明确说已取消
  loadBtnM5.onclick();
  await new Promise((r) => setTimeout(r, 40));
  const cancelText2 = libMsgOf();
  check('M5: 加载取消 → 明确说「已取消, 没有加载任何目录」', cancelText2.includes('已取消') && cancelText2.includes('没有加载任何目录'), cancelText2.slice(0, 80));
  // 加载已有书库成功: 扫描到 N 本, 已登记 M 本
  const importCallsM5 = [];
  globalThis.AiduMiscService.libraryDirPick = async () => ({ ok: true, data: { cancelled: false, path: 'D:/ext-lib' } });
  globalThis.AiduMiscService.libraryDirScan = async () => ({ ok: true, data: { dir: 'D:/ext-lib', importable: [{ id: 'b1', title: 'Alice' }, { id: 'b2', title: 'Star' }], existing: [{ id: 'b0', title: 'Old' }] } });
  globalThis.AiduMiscService.libraryDirImport = async (packs) => { importCallsM5.push(packs); return { ok: true, data: { imported: packs.length, failed: [] } }; };
  confirmCaptured = null;
  loadBtnM5.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('M5: 扫描到 2 本 → 弹确认 (另 1 本已在书库)', confirmCaptured && String(confirmCaptured.title).includes('登记外部书库') && String(confirmCaptured.message).includes('找到 2 本成品') && String(confirmCaptured.message).includes('另有 1 本已在书库'), confirmCaptured && confirmCaptured.title);
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 40));
  const loadText = libMsgOf();
  check('M5: 登记结果说清「扫描到 2 本, 已登记 2 本」', loadText.includes('扫描到 2 本') && loadText.includes('已登记 2 本'), loadText.slice(0, 80));
  // UX5 #4: 整根迁移由后端 L1 清单+备份+校验保证文件一个不少 (Rust 单测锁)
  check('UX5#4: 整根迁移文件安全由后端 L1 清单/备份/校验保证 (见 Rust 单测 ux5_migrate_data_root)', true);
  // M2 教训守卫: 视图调用的 service 方法必须存在于真实 service 文件 (测试 stub 可能掩盖缺失)
  const miscSrc = readFileSync(join(root, 'services/misc_service.js'), 'utf8');
  check('UX5#4: 真实 misc_service.js 有 dataRootRecommended (stub 不掩盖真实缺失)', miscSrc.includes('dataRootRecommended()'), 'missing dataRootRecommended');
  check('UX5#4: 真实 misc_service.js 有 libraryRootStatus', miscSrc.includes('libraryRootStatus()'), 'missing libraryRootStatus');
  check('UX5#4: 真实 misc_service.js 有 libraryOutConsolidate', miscSrc.includes('libraryOutConsolidate()'), 'missing libraryOutConsolidate');
}

console.log('== 2g2. UX5 修正 (2026-08-13): 书库不在数据根下 → 收拢警告 + 一键收拢 ==');
{
  // 用户场景: 数据根 C:\...\Roaming\aidulc, 书库成品在旧位置 E:\aidulc_data (数据分散两处)
  store.state.settingsTab = 'system';
  globalThis.AiduMiscService.libraryRootStatus = async () => ({ ok: true, data: { root: 'C:/aidulc-data', db_path: 'C:/aidulc-data/data.db', exists: true, writable: true, ok: true, reason: '', db_exists: true, out_dir: 'E:/aidulc_data', out_inside_root: false } });
  const consolidateCalls = [];
  globalThis.AiduMiscService.libraryOutConsolidate = async () => { consolidateCalls.push(1); return { ok: true, data: { old_out: 'E:/aidulc_data', new_out: 'C:/aidulc-data/jobs_out', backup_path: 'C:/aidulc-data/backups/x', restart_required: true, book_count: 3 } }; };
  const sv2g2 = new globalThis.SettingsView(store);
  const c2g2 = makeElement('div');
  sv2g2.render(c2g2);
  await new Promise((r) => setTimeout(r, 90));
  store.state.settingsTab = null;
  const libSec2g2 = queryAll(c2g2, '.settings-section').find((s) => {
    const h2 = (s._children || []).find((x) => x.tagName === 'H2');
    return h2 && h2.textContent === '书库位置';
  });
  // 教训 8 DOM 断言: 收拢警告文案 + 按钮; 摘要行不再把两个打架的路径并排 (书库行带 ⚠)
  const metaText = textOf(libSec2g2 && libSec2g2.querySelector('.settings-meta'));
  check('UX5修正: 摘要行数据根与数据库在根下, 书库行标注「不在数据根下」', metaText.includes('数据根: C:/aidulc-data') &&
    metaText.includes('E:/aidulc_data') && metaText.includes('不在数据根下'), metaText.slice(0, 140));
  const warnTip = queryAll(libSec2g2, '.import-tip').find((t) => textOf(t).includes('旧位置'));
  const warnText = textOf(warnTip || {});
  check('UX5修正: 显示收拢警告 (数据分散在两个地方)', warnText.includes('旧位置') && warnText.includes('数据分散'), warnText.slice(0, 120));
  const consolidateBtn = queryAll(c2g2, 'button').find((b) => b.textContent === '收拢到数据根');
  check('UX5修正: 有「收拢到数据根」按钮', !!consolidateBtn);
  consolidateBtn && consolidateBtn.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5修正: 点收拢 → 调 libraryOutConsolidate', consolidateCalls.length === 1, 'calls=' + consolidateCalls.length);
  const resultTip = queryAll(libSec2g2, '.import-tip').find((t) => textOf(t).includes('已把书库收拢'));
  const resultText = textOf(resultTip || {});
  check('UX5修正: 收拢结果含「已把书库收拢到数据根」+ 备份 + 重启', resultText.includes('已把书库收拢到数据根') && resultText.includes('备份') && resultText.includes('重启'), resultText.slice(0, 140));
}

console.log('== 2g3. UX5 修正 (2026-08-13): 确认框动作失败必须可见 + 选当前书库目录=重新生根 ==');
{
  // A. 真实 modal: onConfirm 拒绝 → toast 显示错误 (此前静默吞掉 → "点一下没反应")
  const realModal = globalThis.AiduModal;
  const toasts = [];
  const toastOrig = globalThis.AiduToast;
  globalThis.AiduToast = { show: (t, k) => toasts.push([t, k]) };
  load('components/modal.js'); // 真实 modal 覆盖 stub
  globalThis.AiduModal.confirm({
    title: 't', message: 'm', confirmText: '确定',
    onConfirm: () => Promise.reject(new Error('后端拒绝: 目标不是空目录')),
  });
  const ov3 = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  const confirmBtn3 = ov3 && queryAll(ov3, 'button').find((b) => b.textContent === '确定');
  confirmBtn3 && confirmBtn3.onclick();
  await new Promise((r) => setTimeout(r, 30));
  check('UX5修正: onConfirm 失败 → toast 显示错误 (不再静默)', toasts.some(([t]) => t.includes('后端拒绝')), JSON.stringify(toasts));
  check('UX5修正: 失败后确认按钮恢复可用', confirmBtn3 && confirmBtn3.disabled === false);
  globalThis.AiduToast = toastOrig;
  globalThis.AiduModal = realModal;
  if (ov3 && ov3.remove) ov3.remove();
  // B. 选当前书库所在目录 → rooted_around_out 结果文案 (书原地不动, 数据根迁过去)
  store.state.settingsTab = 'system';
  globalThis.AiduMiscService.libraryDirGet = async () => ({ ok: true, data: 'C:/aidulc-data' });
  globalThis.AiduMiscService.libraryDirPick = async () => ({ ok: true, data: { cancelled: false, path: 'E:/aidulc_data' } });
  globalThis.AiduMiscService.libraryDirPickAndSet = async () => ({ ok: true, data: { cancelled: false, new_dir: 'E:/aidulc_data', backup_path: 'E:/aidulc_data/backups/x', restart_required: true, rooted_around_out: true } });
  const sv2g3 = new globalThis.SettingsView(store);
  const c2g3 = makeElement('div');
  sv2g3.render(c2g3);
  await new Promise((r) => setTimeout(r, 90));
  store.state.settingsTab = null;
  const changeBtn3 = queryAll(c2g3, 'button').find((b) => b.textContent === '更改…');
  confirmCaptured = null;
  changeBtn3 && changeBtn3.onclick();
  await new Promise((r) => setTimeout(r, 40));
  confirmCaptured && confirmCaptured.onConfirm && confirmCaptured.onConfirm();
  await new Promise((r) => setTimeout(r, 40));
  const libSec3 = queryAll(c2g3, '.settings-section').find((s) => {
    const h2 = (s._children || []).find((x) => x.tagName === 'H2');
    return h2 && h2.textContent === '书库位置';
  });
  const tips3 = queryAll(libSec3, '.import-tip');
  const msg3 = textOf(tips3[tips3.length - 1] || {});
  check('UX5修正: 选当前书库目录 → 结果说明「数据根迁过去, 书库子项收进 jobs_out, 书原地不动」',
    msg3.includes('数据根迁到书库所在目录') && msg3.includes('书库子项收进') && msg3.includes('原地不动'), msg3.slice(0, 180));
}

console.log('== 3. library_view 导入格 (G1): 网格最后一格, 无下拉, 点击走 pickFiles ==');{
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

console.log('== 3a-3. 补封面入口 (2026-08-17): 必须真的点得到 ==');
{
  // 背景: K12 把「补封面」只写进 kind==='product' 分支, 而 main.js 只挂了
  // new LibraryView(store,'original') —— 那个分支 UI 上到不了, 功能从写出来就是死的。
  // 这条测试锁定"在真正挂着的那个视图里点得到", 防止再退化成不可达。
  const lv = new globalThis.LibraryView(store, 'original');
  const listEl = makeElement('div');
  const mk = (edCover) => ({
    id: 'src1', title: 'Number the Stars', kind: 'original', status: 'done',
    editions: [{ id: 'ed1', title: 'Number the Stars', pack_dir: 'C:/p/ed1', status: 'done', cover_file: edCover }],
  });

  lv._renderBooks(listEl, [mk(null)], makeElement('input'));
  const card = queryAll(listEl, '.book-card')[0];
  const dots = queryAll(card, 'button').find((b) => b.textContent === '⋯');
  check('补封面: 原书卡上有 ⋯ 按钮', !!dots);
  dots.onclick();
  let menu = queryAll(globalThis.document.body, '.vocab-menu').at(-1);
  const labels = queryAll(menu, 'button').map((b) => b.textContent);
  check('补封面: 译本没封面时, ⋯ 菜单里有「补封面」', labels.includes('补封面'), JSON.stringify(labels));

  // 点它要打到译本 id(封面在译本的书包里, 原书没有 pack_dir)
  const seen = [];
  const orig = globalThis.AiduLibraryService.backfillCover;
  globalThis.AiduLibraryService.backfillCover = async (id) => { seen.push(id); return { ok: true, data: { cover: 'cover.jpeg' } }; };
  queryAll(menu, 'button').find((b) => b.textContent === '补封面').onclick();
  await new Promise((r) => setTimeout(r, 10));
  check('补封面: 点了传的是译本 id 不是原书 id', seen.length === 1 && seen[0] === 'ed1', JSON.stringify(seen));
  globalThis.AiduLibraryService.backfillCover = orig;
  queryAll(globalThis.document.body, '.modal-overlay').forEach((o) => o.remove());

  // 译本已有封面 → 不显示这一项(不给无意义的入口)
  const listEl2 = makeElement('div');
  lv._renderBooks(listEl2, [mk('cover.jpg')], makeElement('input'));
  const dots2 = queryAll(queryAll(listEl2, '.book-card')[0], 'button').find((b) => b.textContent === '⋯');
  dots2.onclick();
  menu = queryAll(globalThis.document.body, '.vocab-menu').at(-1);
  check('补封面: 译本已有封面时不显示这一项',
    !queryAll(menu, 'button').map((b) => b.textContent).includes('补封面'));
  queryAll(globalThis.document.body, '.modal-overlay').forEach((o) => o.remove());
}

console.log('== 3a-2. STDIMPORT/AUTOSTANDARDIZE (2026-08-17/19): 导入前统一标准体检 —— 不标准的书照常导入 + 后台转换 ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  const origAudit = globalThis.AiduImportService.auditSources;
  const origImport = globalThis.AiduImportService.importBooks;
  const imported = [];
  const needsStd = [];
  globalThis.AiduImportService.importBooks = async (paths, profileId, languages, pendingStandardize) => {
    imported.push(paths);
    needsStd.push(pendingStandardize);
    return { ok: true, data: { registered: paths, skipped: [], batch_id: 'b1' } };
  };

  // 一本不标准 + 一本达标 → 两本都导入, 不标准那本把路径传给 needsStandardize
  globalThis.AiduImportService.auditSources = async () => ([
    { verdict: 'block', issues: [{ code: 'S3', level: 'block', message: '解析结果过少: 0 章 / 0 句' }] },
    { verdict: 'ok', issues: [] },
  ]);
  lv._startBatchImport(['C:/Books/broken.epub', 'C:/Books/good.epub']);
  await new Promise((r) => setTimeout(r, 20));
  check('体检: 不标准的书也进书库(与达标的一起导入)',
    imported.length === 1 && imported[0].length === 2
    && imported[0].includes('C:/Books/broken.epub') && imported[0].includes('C:/Books/good.epub'),
    JSON.stringify(imported));
  check('体检: 不标准的那本传给 needsStandardize (后台自动转换)',
    needsStd.length === 1 && JSON.stringify(needsStd[0]) === JSON.stringify(['C:/Books/broken.epub']),
    JSON.stringify(needsStd));

  // 全部不标准 → 也照常导入, 全部进 needsStandardize (不再有"完全拒绝")
  imported.length = 0; needsStd.length = 0;
  globalThis.AiduImportService.auditSources = async () => ([
    { verdict: 'block', issues: [{ code: 'S1', level: 'block', message: 'EPUB 打不开或读不到 spine' }] },
  ]);
  lv._startBatchImport(['C:/Books/dead.epub']);
  await new Promise((r) => setTimeout(r, 20));
  check('体检: 全部不标准 → 照常导入 + 全部转后台转换',
    imported.length === 1 && imported[0].length === 1 && needsStd[0] && needsStd[0].length === 1,
    'imported=' + JSON.stringify(imported) + ' needsStd=' + JSON.stringify(needsStd));

  // 体检本身炸了(侧车缺失/超时)不该挡住用户导入
  imported.length = 0; needsStd.length = 0;
  globalThis.AiduImportService.auditSources = async () => { throw new Error('侧车不可用'); };
  lv._startBatchImport(['C:/Books/whatever.epub']);
  await new Promise((r) => setTimeout(r, 20));
  check('体检: 体检自身失败 → 降级放行, 不挡住导入',
    imported.length === 1 && needsStd[0] && needsStd[0].length === 0, JSON.stringify(imported));

  globalThis.AiduImportService.auditSources = origAudit;
  globalThis.AiduImportService.importBooks = origImport;
}

console.log('== 3a-3. AUTOSTANDARDIZE (2026-08-19): 书卡 standardize_status 徽章 (独立于 status) ==');
{
  const lv = new globalThis.LibraryView(store, 'original');
  lv._profiles = [{ id: 'default', name: '成人自读' }];
  const listEl = makeElement('div');
  const books = [
    { id: 'p1', title: 'Pending.epub', kind: 'original', status: 'ready', source_language: 'en', standardize_status: 'pending', standardize_note: '' },
    { id: 'r1', title: 'Running.epub', kind: 'original', status: 'pending', source_language: 'en', standardize_status: 'running', standardize_note: '第二遍转换中' },
    { id: 'd1', title: 'Done.epub', kind: 'original', status: 'ready', source_language: 'en', standardize_status: 'done', standardize_note: '已规范为单 EPUB' },
    { id: 'f1', title: 'Failed.epub', kind: 'original', status: 'ready', source_language: 'en', standardize_status: 'failed', standardize_note: '仍然不达标: 解析结果过少' },
    { id: 'n1', title: 'None.epub', kind: 'original', status: 'ready', source_language: 'en', standardize_status: 'none' },
    { id: 'x1', title: 'NoField.epub', kind: 'original', status: 'ready', source_language: 'en' },
  ];
  lv._renderBooks(listEl, books, makeElement('input'), null);
  const cards = queryAll(listEl, '.book-card');
  const byTitle = (t) => cards.find((c) => c.querySelector('.book-card-title').textContent === t);
  const stz = (t) => byTitle(t) ? queryAll(byTitle(t), '[data-standardize="1"]') : [];
  // pending/running → 复用处理中样式的"自动转换中…"小徽章
  check('standardize: pending 显示「自动转换中…」(badge-busy)',
    stz('Pending').length === 1 && stz('Pending')[0].textContent === '自动转换中…' && stz('Pending')[0].className.includes('badge-busy'),
    'stz=' + stz('Pending').map((b) => b.textContent + '/' + b.className).join(','));
  check('standardize: running 同样「自动转换中…」',
    stz('Running').length === 1 && stz('Running')[0].textContent === '自动转换中…',
    'stz=' + stz('Running').map((b) => b.textContent).join(','));
  // done → 无常驻文字的小点 + 悬浮 title 带 standardize_note
  const doneBadge = stz('Done')[0];
  check('standardize: done 是小点(badge-dot), 无常驻文字, title 带说明',
    !!doneBadge && doneBadge.textContent === '' && doneBadge.className.includes('badge-dot')
    && doneBadge.title.includes('已规范为单 EPUB'),
    doneBadge && (doneBadge.textContent + '/' + doneBadge.className + '/' + doneBadge.title));
  // failed → 醒目失败样式, 文案直接用 standardize_note
  const failedBadge = stz('Failed')[0];
  check('standardize: failed 标红(badge-err), 文案 = standardize_note',
    !!failedBadge && failedBadge.className.includes('badge-err')
    && failedBadge.textContent.includes('仍然不达标') && failedBadge.title.includes('仍然不达标'),
    failedBadge && (failedBadge.className + '/' + failedBadge.textContent + '/' + failedBadge.title));
  // none / 缺省 → 不渲染任何 standardize 徽章
  check('standardize: none/缺省不渲染第二徽章',
    stz('None').length === 0 && stz('NoField').length === 0,
    'none=' + stz('None').length + ' nofield=' + stz('NoField').length);
  // status 徽章仍在 —— 第二档与 status 独立并存
  const failedCard = byTitle('Failed');
  check('standardize: status 徽章不受影响(仍显示「就绪」)',
    !!failedCard && queryAll(failedCard, '.book-badge').some((b) => b.textContent === '就绪'),
    'badges=' + (failedCard && queryAll(failedCard, '.book-badge').map((b) => b.textContent).join(',')));
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

console.log('== 3e. UX5 #1 (2026-08-13): 译本展开状态持久化 + 轮巡增量更新 ==');
{
  // 教训 8: 断言落在最终 DOM。两张带译本的原版书卡: 展开书1 → 轮巡/整列重建后仍展开,
  // 书2 不受影响; 轮巡只刷进度条不重建卡片。
  const lvE = new globalThis.LibraryView(store, 'original');
  lvE._profiles = [{ id: 'default', name: '成人自读' }];
  const listElE = makeElement('div');
  const booksE = [
    { id: 's1', title: 'Alice.epub', kind: 'original', status: 'done', source_language: 'en',
      editions: [{ id: 'e1', title: 'Alice 译本', status: 'ready', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' }] },
    { id: 's2', title: 'Number the Stars.epub', kind: 'original', status: 'done', source_language: 'en',
      editions: [{ id: 'e2', title: 'Star 译本', status: 'ready', profile_id: 'default', chapter_count: 12, llm_id: 'llm|en|qwen3-4b|2507', tts_id: 'tts|en|kokoro|v1' }] },
  ];
  store.state.books = booksE;
  lvE._renderBooks(listElE, booksE, makeElement('input'), null);
  const cardsE = queryAll(listElE, '.book-card');
  const card1 = cardsE.find((c) => c.querySelector('.book-card-title').textContent === 'Alice');
  const card2 = cardsE.find((c) => c.querySelector('.book-card-title').textContent === 'Number the Stars');
  const toggle1 = card1 && card1.querySelector('.edition-toggle');
  const body1 = card1 && card1.querySelector('.edition-body');
  const body2 = card2 && card2.querySelector('.edition-body');
  check('UX5#1: 初始两张卡都折叠 (.edition-body 含 collapsed)', body1 && body2 && body1.className.includes('collapsed') && body2.className.includes('collapsed'));
  toggle1 && toggle1.onclick();
  check('UX5#1: 展开书1 → .edition-body 无 collapsed、箭头 ▾', body1 && !body1.className.includes('collapsed') && toggle1.textContent.includes('▾'));
  // 情形A: 轮巡增量 (job poll → _updateJobProgress, 不整列重建)
  lvE._jobs = [];
  lvE._updateJobProgress(listElE);
  check('UX5#1: 轮巡后书1仍展开、箭头仍 ▾ (增量更新不整列重建)', body1 && !body1.className.includes('collapsed') && toggle1.textContent.includes('▾'));
  check('UX5#1: 其它未展开书卡不受影响 (书2仍 collapsed)', body2 && body2.className.includes('collapsed'));
  // 情形B: store change 触发的整列重建 (_renderBooks) —— expanded set 保持
  lvE._renderBooks(listElE, booksE, makeElement('input'), null);
  const cardsE2 = queryAll(listElE, '.book-card');
  const card1b = cardsE2.find((c) => c.querySelector('.book-card-title').textContent === 'Alice');
  const body1b = card1b && card1b.querySelector('.edition-body');
  const toggle1b = card1b && card1b.querySelector('.edition-toggle');
  const card2b = cardsE2.find((c) => c.querySelector('.book-card-title').textContent === 'Number the Stars');
  const body2b = card2b && card2b.querySelector('.edition-body');
  check('UX5#1: 整列重建后书1仍展开 (expanded set 保持)', body1b && !body1b.className.includes('collapsed') && toggle1b.textContent.includes('▾'));
  check('UX5#1: 整列重建后书2仍折叠', body2b && body2b.className.includes('collapsed'));
  // 增量进度条: 处理中的书, 轮巡只更新 fill 宽度 + 文案 (不改卡片其它部分)
  const procBook = { id: 's3', title: 'Old Man.epub', kind: 'original', status: 'processing', source_language: 'en', source_path: 'C:/Books/OldMan.epub' };
  store.state.books = [procBook];
  const listElP = makeElement('div');
  lvE._renderBooks(listElP, [procBook], makeElement('input'), null);
  lvE._jobs = [{ book_path: 'C:/Books/OldMan.epub', stage: 'translate', current: 50, total: 200, status: 'running' }];
  lvE._updateJobProgress(listElP);
  const pfill = listElP.querySelector('.prep-bar-fill');
  const ptext = listElP.querySelector('.book-progress-text');
  check('UX5#1: 轮巡更新 .prep-bar-fill 宽度 25%', pfill && pfill.style.width === '25%', 'width=' + (pfill && pfill.style.width));
  check('UX5#1: 轮巡更新 .book-progress-text (翻译 50/200 句)', ptext && ptext.textContent.includes('翻译') && ptext.textContent.includes('50/200'), ptext && ptext.textContent);
  store.state.books = [];
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
  // K9 (2026-08-14): "生词本"链接现在挂了到期数角标(.nav-count 子节点), textContent
  // 会变成"生词本0"这种——用 startsWith 而不是精确相等。
  const labels = links.map((b) => b.textContent);
  check('顶栏有 我的书', labels.includes('我的书'), labels.join(','));
  check('顶栏有 生词本', labels.some((l) => l.startsWith('生词本')), labels.join(','));
  check('顶栏没有 背单词 (已并入生词本)', !labels.some((l) => l.startsWith('背单词')), labels.join(','));
  check('L6: 顶栏没有 导入 (书库已有导入格)', !labels.some((l) => l.startsWith('导入')), labels.join(','));
  const vocabLink = links.find((b) => b.dataset && b.dataset.route === 'vocab');
  check('K9: 生词本链接带到期数角标', vocabLink && vocabLink.querySelector && vocabLink.querySelector('.nav-count') && vocabLink.querySelector('.nav-count').textContent === '0', 'badge=' + (vocabLink && vocabLink.querySelector && vocabLink.querySelector('.nav-count') && vocabLink.querySelector('.nav-count').textContent));
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

console.log('== 6b. 来源定位入卡背 (V4 + UX5 #2, 2026-08-13) ==');
{
  // 词条带 edition_id → 卡片背面应显示《书名》·第 N 章 + "在阅读器中打开"
  const rv2 = new globalThis.ReviewView(new globalThis.AiduStore());
  const rc2 = makeElement('div');
  rv2.render(rc2);
  await new Promise((r) => setTimeout(r, 60));
  const cardBack = rv2._cardEl && rv2._cardEl.querySelector('.back');
  const locEl = cardBack && queryAll(cardBack, '.review-source-loc')[0];
  check('卡片背面出现来源定位块', !!locEl);
  const metaLine = locEl && queryAll(locEl, '.review-source-meta')[0];
  const metaText = metaLine ? metaLine.textContent : '';
  check('来源显示章节与句位置', metaText.includes('第 3 章') && metaText.includes('第 6 处出现'), 'meta=' + JSON.stringify(metaText));
  const openBtn = locEl && queryAll(locEl, 'button').find((b) => b.textContent.includes('在阅读器中打开'));
  check('有"在阅读器中打开"按钮', !!openBtn);
  // 跳转: onOpenInReader 回调拿到 edition_id/chapter/sentence
  let jumped = null;
  rv2.onOpenInReader = (e) => { jumped = e; };
  openBtn.onclick();
  check('点击触发 onOpenInReader 带定位', jumped && jumped.edition_id === 'e-1' && jumped.chapter_index === 2 && jumped.sentence_index === 5, JSON.stringify(jumped));
  await new Promise((r) => setTimeout(r, 30));
  // 书名异步解析
  const book = rv2._cardEl && rv2._cardEl.querySelector('.review-source-book');
  check('书名异步解析为《雪国》', book && book.textContent === '《雪国》', book && book.textContent);
  rv2.cleanup();
}

console.log('== 6c. E→UX5 #2: 今日队列信息收进单卡摘要行 (2026-08-11/13) ==');
{
  // 1424 词全到期 → 单卡模式不再铺 1424 行队列, 摘要行显示计数 + 超上限顺延提示
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
  check('单卡模式不再渲染队列列表 (.review-qrow 不存在)', queryAll(rc3, '.review-qrow').length === 0);
  const sumText = textOf(rv3._summaryEl || {});
  check('摘要行显示计数 (1424)', sumText.includes('1424'), sumText.slice(0, 80));
  check('摘要行提示超每日上限顺延', sumText.includes('顺延') && sumText.includes('每日上限'), sumText.slice(0, 120));
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

console.log('== 6e. M2 + UX5 #2 (2026-08-12/13): 全链路 —— 点「开始复习」→ 真渲染单卡, Esc 退出 ==');
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
  // 教训 8 DOM 断言 (UX5 #2): 点击后 .review-grid 消失 (三栏没了), 单卡出现
  check('UX5#2: 点击后 .review-grid 不存在 (去三栏 grid)', !containerE.querySelector('.review-grid'));
  check('UX5#2: 单卡出现 (.review-card)', !!containerE.querySelector('.review-card'));
  check('UX5#2: 背景遮罩/模糊层存在 (.review-backdrop)', !!containerE.querySelector('.review-backdrop'));
  const cardE = containerE.querySelector('.review-card');
  const ctxE = cardE && cardE.querySelector('.review-context');
  check('UX5#2: 卡内含原文语境块 (.review-context)', !!ctxE, 'ctx=' + (ctxE && ctxE.textContent));
  check('M2: 点击后 .vocab-today-card 不存在', !containerE.querySelector('.vocab-today-card'));
  check('M2: 顶栏 nav 加 focus-hidden (专注模式视觉)', navEl.className.includes('focus-hidden'), navEl.className);
  const exitBtnE = queryAll(containerE, 'button').find((b) => b.textContent === '退出复习');
  check('M2: 专注模式有「退出复习」按钮', !!exitBtnE);
  // Esc / 退出 → 回词表
  if (exitBtnE) exitBtnE.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('M2: 退出后 .vocab-today-card 回来', !!containerE.querySelector('.vocab-today-card'));
  check('UX5#2: 退出后 .review-card 消失', !containerE.querySelector('.review-card'));
  check('M2: 退出后 nav 移除 focus-hidden', !navEl.className.includes('focus-hidden'));
}

console.log('== 6f. UX5 #2 (2026-08-13): 单卡双语音按钮 —— 正常速度/慢速 + 播放中状态类 ==');
{
  // 词条带来源 → 走阅读器音频管线 (桌面); 音频加载失败 → 降级 speechSynthesis。
  // 教训 8: 断言可见文案「正常速度」/「慢速」+ 点击后 .playing 状态类。
  globalThis.AiduDictionaryService.vocabAll = async () => ({ ok: true, data: [
    { word: 'reticent', lemma: 'reticent', stage: 'review', interval_ms: 3 * 86400000, next_review: Date.now() - 1000, meaning: '沉默寡言的', context: 'He was reticent.', edition_id: 'e-1', chapter_index: 2, sentence_index: 5 },
  ] });
  // 音频管线 stub: loadBookpack → basePath; loadChapter → 该句 audio 区间; readAudioRange → 一个字节
  globalThis.AiduLibraryService.loadBookpack = async () => ({ ok: true, data: { basePath: 'D:/packs/e1', bookpack: { chapters: [] } } });
  globalThis.AiduLibraryService.loadBookpackChapter = async () => ({ ok: true, data: { audioFile: 'audio/ch_002.opus', sentences: [{}, {}, {}, {}, {}, { audio: { start_ms: 1000, end_ms: 3000 } }] } });
  globalThis.AiduLibraryService.readAudioRange = async () => ({ ok: true, data: { data_b64: 'AAAA', read: 4, end: true } });
  globalThis.AiduLibraryService.editionLookup = async () => ({ ok: true, data: { id: 'e-1', title: '雪国' } });
  // Audio mock: 同步触发 loadedmetadata, 记录 play 时的 rate/currentTime
  let playCalls = [];
  let createdAudio = null;
  globalThis.Audio = class {
    constructor() { this.currentTime = 0; this.playbackRate = 1; this.src = ''; this.paused = true; createdAudio = this; }
    load() {}
    addEventListener(ev, fn) { if (ev === 'loadedmetadata') { fn(); return true; } return false; }
    play() { this.paused = false; playCalls.push({ rate: this.playbackRate, currentTime: this.currentTime }); return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  globalThis.atob = (s) => s;
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  globalThis.Blob = class { constructor() {} };
  const rvF = new globalThis.ReviewView(new globalThis.AiduStore());
  const rcF = makeElement('div');
  rvF.render(rcF);
  await new Promise((r) => setTimeout(r, 80));
  const voiceBtns = queryAll(rcF, '.review-voice-btn');
  const texts = voiceBtns.map((b) => b.textContent);
  check('UX5#2: 两个语音按钮 (正常速度/慢速)', texts.includes('正常速度') && texts.includes('慢速'), texts.join(','));
  const normalBtn = voiceBtns.find((b) => b.textContent === '正常速度');
  const slowBtn = voiceBtns.find((b) => b.textContent === '慢速');
  // 点正常速度 → 走阅读器音频, playbackRate=1, 定位到句起点, .playing 高亮
  playCalls = [];
  normalBtn.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#2: 正常速度走音频管线 (playbackRate=1)', playCalls.some((p) => p.rate === 1), JSON.stringify(playCalls));
  check('UX5#2: 定位到句起点 (1000ms)', playCalls.some((p) => p.currentTime === 1), JSON.stringify(playCalls));
  check('UX5#2: 播放中按钮加 .playing 状态类', normalBtn.className.includes('playing'), normalBtn.className);
  // 点慢速 → 切换到 0.75 (桌面 playbackRate)
  rvF._stopVoice();
  playCalls = [];
  slowBtn.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#2: 慢速 playbackRate=0.75', playCalls.some((p) => p.rate === 0.75), JSON.stringify(playCalls));
  check('UX5#2: 慢速按钮加 .playing', slowBtn.className.includes('playing'), slowBtn.className);
  rvF._stopVoice();
  // 无来源词条 → 降级 speechSynthesis (系统级)
  globalThis.AiduDictionaryService.vocabAll = async () => ({ ok: true, data: [
    { word: 'bank', lemma: 'bank', stage: 'new', next_review: null, meaning: '银行', context: 'He went to the bank.' },
  ] });
  const spoken = [];
  globalThis.speechSynthesis = {
    cancel() {}, speak(u) { spoken.push({ text: u.text, rate: u.rate }); },
  };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const rvG = new globalThis.ReviewView(new globalThis.AiduStore());
  const rcG = makeElement('div');
  rvG.render(rcG);
  await new Promise((r) => setTimeout(r, 80));
  const gVoiceBtns = queryAll(rcG, '.review-voice-btn');
  const gNormal = gVoiceBtns.find((b) => b.textContent === '正常速度');
  const gSlow = gVoiceBtns.find((b) => b.textContent === '慢速');
  gNormal.onclick();
  // K32 (2026-08-15): _speakWord 先 await vocabReadCachedAudio 才决定降级路径, 比原来
  // 多一次微任务跳转, 点击后不能再同步断言, 补一次 tick 等 .then() 链跑完。
  await Promise.resolve().then(() => {});
  check('UX5#2: 无来源词条 → speechSynthesis 读单词 (rate 1.0)', spoken.some((u) => u.text === 'bank' && u.rate === 1), JSON.stringify(spoken));
  rvG._stopVoice();
  spoken.length = 0;
  gSlow.onclick();
  await Promise.resolve().then(() => {});
  check('UX5#2: 慢速降级 rate 0.6 (系统级)', spoken.some((u) => u.text === 'bank' && u.rate === 0.6), JSON.stringify(spoken));
  rvG.cleanup();
  // 还原
  delete globalThis.Audio;
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
  globalThis.atob = undefined;
  globalThis.Blob = undefined;
  globalThis.URL = undefined;
  const audioLoadCalls = [];
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
  check('功能段标题: 翻译/讲解 + 语音合成', groupTexts.some((t) => t.includes('翻译')) && groupTexts.some((t) => t.includes('语音合成')), JSON.stringify(groupTexts));
  // K24 (2026-08-14): UX5#5 曾经整段隐藏, 现在改成显示静态引导文案(装 spaCy 语言包+扫描登记),
  // 不是"没有配置就不存在"了——用户拍板"nlp 需要引导下载入口"。
  check('K24: 无已登记 nlp 模型 → 分词/NLP 段仍显示引导文案', groupTexts.some((t) => t.includes('分词')), JSON.stringify(groupTexts));
  check('UX5#5: 模型目录段在最上 (第一个 .model-group)', groupTitle(groups[0]).includes('模型目录'), JSON.stringify(groupTexts));
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
  // K24 (2026-08-14): 曾经整段隐藏(UX5 #5), 现在改成显示静态引导文案。
  check('K24: 无已登记 nlp 模型 → 分词/NLP 段仍渲染引导文案', !!nlpSec9, 'groups=' + groups9.map(gtitle).join(','));
  // M4-1: llm/tts 有目录项 → 仍有「去下载」(有源才有按钮)
  const llmSec9 = groups9.find((g) => gtitle(g).includes('翻译'));
  const ttsSec9 = groups9.find((g) => gtitle(g).includes('语音合成'));
  check('M4-1: 翻译段有「去下载」(有目录项)', llmSec9 && queryAll(llmSec9, 'button').some((b) => b.textContent === '去下载'));
  check('M4-1: 语音段有「去下载」(有目录项)', ttsSec9 && queryAll(ttsSec9, 'button').some((b) => b.textContent === '去下载'));
  // UX5 #5: 模型目录段 —— 页面上可见模型目录路径 + 可增删
  const dirsSec9 = groups9.find((g) => gtitle(g).includes('模型目录'));
  const dirRows9 = dirsSec9 ? queryAll(dirsSec9, '.model-dir-row') : [];
  check('UX5#5: 模型目录段显示路径 (llm/tts 目录 + HF 缓存)', dirRows9.some((r) => textOf(r).includes('C:/models')) && dirRows9.some((r) => textOf(r).includes('F:/hf_cache')),
    (dirRows9 || []).map(textOf).join('|'));
  check('UX5#5: 模型目录段有「+ 添加目录」可增删', dirsSec9 && queryAll(dirsSec9, 'button').some((b) => b.textContent.includes('添加目录')));

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
  // UX5 #5: 版本/更新判定 (候选 vs DOWNLOAD_CATALOG)。行内最后一个 .book-badge 是版本徽章
  // (stub 的 querySelector 不支持后代选择器, 用 slice(-1) 取最后一个)。
  const verTexts9 = (cands9 || []).map((c) => {
    const badges = c.querySelectorAll('.book-badge');
    const v = badges[badges.length - 1];
    return v ? v.textContent : '';
  });
  check('UX5#5: 已知 llm 候选标「可下载/可登记」', verTexts9.some((t) => t.includes('可下载/可登记')), verTexts9.join(','));
  check('UX5#5: 目录里没有的候选老实说「版本未知, 无法判断」', verTexts9.filter((t) => t.includes('版本未知')).length >= 2, verTexts9.join(','));
  // 未识别 (asr/vad) 的候选版本标「版本未知」—— 不谎称已知版本可下载
  const unrecVerOk = (cands9 || []).every((c) => {
    const badges = c.querySelectorAll('.book-badge');
    const fam = badges[0] && badges[0].textContent;
    const ver = badges[badges.length - 1] && badges[badges.length - 1].textContent;
    if (fam === '未识别') return ver.includes('版本未知');
    return true;
  });
  check('UX5#5: 未识别候选版本标「版本未知」', unrecVerOk, verTexts9.join(','));
  // K10 (2026-08-14): "已是最新"改成如实描述——只说是内置目录版本, 不再暗示做过在线检查
  const mkVer = (c, reg) => mv9._versionStatus(Object.assign({}, c, { registered: reg }));
  check('K10: 已登记 Qwen → 内置目录版本(不暗示已做在线检查)', mkVer({ family_hint: 'llm', file_name: 'Qwen3-4B-Q4_K_M.gguf' }, true).text.includes('内置目录版本'),
    mkVer({ family_hint: 'llm', file_name: 'Qwen3-4B-Q4_K_M.gguf' }, true).text);
  check('UX5#5: 未登记 Qwen → 可下载/可登记', mkVer({ family_hint: 'llm', file_name: 'Qwen3-4B-Q4_K_M.gguf' }, false).text.includes('可下载'),
    mkVer({ family_hint: 'llm', file_name: 'Qwen3-4B-Q4_K_M.gguf' }, false).text);
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
  check('UX5#5: 0 结果给「去下载推荐模型」出口', ov9b && queryAll(ov9b, 'button').some((b) => b.textContent === '去下载推荐模型'), queryAll(ov9b, 'button').map((b) => b.textContent).join(','));

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
  // UX5 #5: 有已登记 nlp 模型 → 分词/NLP 段显示 (带当前方案)
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'nlp|en|spacy|sm', family: 'nlp', language: 'en', model_id: 'en_core_web_sm', version: '3.7.1', variant: '', path: 'C:/models/en_core_web_sm', size_bytes: 12 * 1024 * 1024, active: true, custom: false },
  ] });
  mv9._reload();
  await new Promise((r) => setTimeout(r, 60));
  const groupsNlp = queryAll(mc9, '.model-group');
  const nlpSecShown = groupsNlp.find((g) => gtitle(g).includes('分词'));
  check('UX5#5: 有已登记 nlp 模型 → 分词/NLP 段显示', !!nlpSecShown, 'groups=' + groupsNlp.map(gtitle).join(','));
  const nlpRowName = nlpSecShown && nlpSecShown.querySelector('.model-name');
  check('UX5#5: nlp 段显示已登记模型名 + 可用', nlpSecShown && nlpRowName && nlpRowName.textContent.includes('en_core_web_sm') &&
    queryAll(nlpSecShown, '.book-badge').some((b) => b.textContent === '可用'), nlpSecShown && textOf(nlpSecShown).slice(0, 80));
}

console.log('== 9e. UX5 修正 (2026-08-13): 语音合成不再谎称可用 —— 未设推荐显示"已登记未推荐" ==');
{
  load('views/models_view.js');
  // 用户实测场景: 扫进来的 pytorch_model 被登记成 tts, 但没有任何 tts 设为推荐 →
  // 此前模型页显示"可用", 依赖组件却缺引擎 (kokoro), 两边打架。
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'llm|en|qwen|1', family: 'llm', language: 'en', model_id: 'Qwen3-4B', version: 'x', variant: 'CUDA12.4', path: 'C:/models/qwen.gguf', size_bytes: 1, active: true, custom: true },
    { id: 'tts|en|pytorch|1', family: 'tts', language: 'en', model_id: 'pytorch_model', version: 'x', variant: 'CUDA12.4', path: 'F:/hf_cache/pytorch_model.bin', size_bytes: 444 * 1024 * 1024, active: false, custom: true },
    { id: 'tts|en|kokoro|1', family: 'tts', language: 'en', model_id: 'kokoro-v1_0', version: 'v1.0', variant: 'CUDA12.4', path: 'F:/hf_cache/kokoro-v1_0.pth', size_bytes: 327 * 1024 * 1024, active: false, custom: true },
  ] });
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {
    llm_model: 'C:/models/qwen.gguf', tts_model: 'F:/hf_cache/kokoro-v1_0.pth', default_model_dir: 'C:/models', hf_cache_dir: 'F:/hf_cache',
  } });
  const mv9e = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc9e = makeElement('div');
  mv9e.render(mc9e);
  await new Promise((r) => setTimeout(r, 80));
  const gtitle = (g) => { const h2 = (g._children || []).find((x) => x.tagName === 'H2'); return h2 ? h2.textContent : ''; };
  const groups9e = queryAll(mc9e, '.model-group');
  const ttsSec9e = groups9e.find((g) => gtitle(g).includes('语音合成'));
  const ttsText9e = textOf(ttsSec9e);
  check('UX5修正: 未设推荐的语音段不再显示"可用"', !ttsText9e.includes('可用'), ttsText9e.slice(0, 80));
  check('UX5修正: 语音段说明「已登记但未设为推荐 · 处理不会自动用」', ttsText9e.includes('未设为推荐') && ttsText9e.includes('处理时不会自动使用'), ttsText9e.slice(0, 140));
  check('UX5修正: 未推荐时给「去下载」出口 (下载推荐引擎)', queryAll(ttsSec9e, 'button').some((b) => b.textContent === '去下载'));
  check('UX5修正: 未推荐时给「换一个」(可把已登记设为推荐)', queryAll(ttsSec9e, 'button').some((b) => b.textContent === '换一个'));
  // 设为推荐后 → 显示"可用"
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'llm|en|qwen|1', family: 'llm', language: 'en', model_id: 'Qwen3-4B', version: 'x', variant: 'CUDA12.4', path: 'C:/models/qwen.gguf', size_bytes: 1, active: true, custom: true },
    { id: 'tts|en|pytorch|1', family: 'tts', language: 'en', model_id: 'pytorch_model', version: 'x', variant: 'CUDA12.4', path: 'F:/hf_cache/pytorch_model.bin', size_bytes: 1, active: true, custom: true },
  ] });
  mv9e._reload();
  await new Promise((r) => setTimeout(r, 60));
  const ttsSec9e2 = queryAll(mc9e, '.model-group').find((g) => gtitle(g).includes('语音合成'));
  const ttsText9e2 = textOf(ttsSec9e2);
  check('UX5修正: 设为推荐后语音段显示"可用"', ttsText9e2.includes('可用'), ttsText9e2.slice(0, 80));
}

console.log('== 9f. UX5 修正 (2026-08-13): 模型目录斜杠归一化去重 (F:/hf_cache 与 F:\hf_cache 同一目录) ==');
{
  load('views/models_view.js');
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [] });
  // llm_model 是正斜杠路径, hf_cache_dir 是反斜杠 —— 指向同一目录必须只显示一项
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {
    llm_model: 'F:/hf_cache/Qwen3-4B.gguf', tts_model: '', default_model_dir: 'C:/models', hf_cache_dir: 'F:\\hf_cache',
  } });
  const mv9f = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc9f = makeElement('div');
  mv9f.render(mc9f);
  await new Promise((r) => setTimeout(r, 80));
  const dirRows = queryAll(mc9f, '.model-dir-row');
  check('UX5修正: 同一目录正/反斜杠只显示一项', dirRows.length === 1,
    'rows=' + dirRows.length + ' texts=' + (dirRows || []).map(textOf).join('|'));
  check('UX5修正: 目录显示为归一化路径', dirRows.length === 1 && textOf(dirRows[0]).includes('F:/hf_cache'), textOf(dirRows[0]));
}

console.log('== 9g. UX5 修正 (2026-08-13): 非本项目模型标注用途 (asr/vad/OCR 不选错) ==');
{
  load('views/models_view.js');
  // 用户实测: manga-ocr/whisper/silero 被误登记成 tts, 模型页不说明它们是什么 → 被当语音合成推荐
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'tts|en|pytorch|1', family: 'tts', language: 'en', model_id: 'pytorch_model', version: 'x', variant: 'CUDA12.4', path: 'F:/hf_cache/hub/models--kha-white--manga-ocr-base/snapshots/x/pytorch_model.bin', size_bytes: 1, active: false, custom: true, detected_family: 'unknown' },
    { id: 'tts|en|ggml-large|1', family: 'tts', language: 'en', model_id: 'ggml-large-v3', version: 'x', variant: 'CUDA12.4', path: 'F:/hf_cache/ggml-large-v3.bin', size_bytes: 1, active: false, custom: true, detected_family: 'asr' },
    { id: 'tts|en|kokoro|1', family: 'tts', language: 'en', model_id: 'kokoro-v1_0', version: 'v1.0', variant: 'CUDA12.4', path: 'F:/hf_cache/kokoro-v1_0.pth', size_bytes: 1, active: false, custom: true, detected_family: 'tts' },
  ] });
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: { llm_model: '', tts_model: 'F:/hf_cache/kokoro-v1_0.pth', default_model_dir: 'C:/models', hf_cache_dir: 'F:/hf_cache' } });
  const mv9g = new globalThis.ModelsView(new globalThis.AiduStore());
  const mc9g = makeElement('div');
  mv9g.render(mc9g);
  await new Promise((r) => setTimeout(r, 80));
  const allToggle = queryAll(mc9g, 'button').find((b) => b.textContent && b.textContent.includes('全部模型'));
  allToggle && allToggle.onclick();
  await new Promise((r) => setTimeout(r, 20));
  const allText = textOf(mc9g);
  // 教训 8: 断言的 DOM 文案 —— 每个非本项目模型都明说是干什么的
  check('UX5修正: manga-ocr (detected=unknown) 标「本项目用不到」', allText.includes('未识别用途') && allText.includes('本项目用不到'), allText.slice(0, 200));
  check('UX5修正: whisper (detected=asr) 标「语音识别 · 本项目用不到」', allText.includes('语音识别') && allText.includes('whisper'), allText.slice(0, 200));
  // 语音合成段: 没有任何 tts 推荐 → 诚实显示"未设推荐" (不再把 pytorch_model 当可用)
  const gtitle = (g) => { const h2 = (g._children || []).find((x) => x.tagName === 'H2'); return h2 ? h2.textContent : ''; };
  const ttsSec9g = queryAll(mc9g, '.model-group').find((g) => gtitle(g).includes('语音合成'));
  const ttsTxt9g = textOf(ttsSec9g);
  check('UX5修正: 无推荐时语音段不显示"可用"', !ttsTxt9g.includes('可用'), ttsTxt9g.slice(0, 60));
  check('UX5修正: 语音段 tip 说明需要 Kokoro (config+voices)', ttsTxt9g.includes('Kokoro') && ttsTxt9g.includes('voices'), ttsTxt9g.slice(0, 140));
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

console.log('== 9h. UX5 修正 (2026-08-13): TTS 完整性 —— 扫描候选标不完整/不预勾 + 模型列表标不完整 ==');
{
  load('views/models_view.js');
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {
    llm_model: 'C:/models/qwen.gguf', tts_model: 'C:/models/kokoro-v1_0.pth',
    default_model_dir: 'C:/models', hf_cache_dir: 'F:/hf_cache',
  } });
  // 平铺 .pth (complete=false) vs HF 快照 (complete=true)
  globalThis.AiduModelService.scan = async () => ({ ok: true, data: [
    { path: 'F:/hf_cache/kokoro-v1_0.pth', file_name: 'kokoro-v1_0.pth', size_bytes: 327212226, family_hint: 'tts', registered: false, complete: false },
    { path: 'F:/hf_cache/hub/models--hexgrad--Kokoro-82M/snapshots/sha/kokoro-v1_0.pth', file_name: 'kokoro-v1_0.pth', size_bytes: 327212226, family_hint: 'tts', registered: false, complete: true },
  ] });
  const mvH = new globalThis.ModelsView(new globalThis.AiduStore());
  const mcH = makeElement('div');
  mvH.render(mcH);
  await new Promise((r) => setTimeout(r, 60));
  mvH._openScanModal();
  await new Promise((r) => setTimeout(r, 60));
  const ovH = document.body._children.filter((c) => c.className && String(c.className).includes('modal-overlay')).slice(-1)[0];
  const scanBtnH = ovH && queryAll(ovH, 'button').find((b) => b.textContent === '扫描');
  scanBtnH && scanBtnH.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const candsH = ovH && queryAll(ovH, '.scan-candidate');
  const incompleteRow = candsH && candsH.find((c) => c.querySelector('.scan-incomplete'));
  const completeRow = candsH && candsH.find((c) => !c.querySelector('.scan-incomplete'));
  check('UX5修正: 平铺 .pth (complete=false) 标「⚠ 不完整」', !!incompleteRow && textOf(incompleteRow).includes('不完整') && textOf(incompleteRow).includes('voices'), incompleteRow && textOf(incompleteRow).slice(0, 100));
  const incCb = incompleteRow && incompleteRow.querySelector('.scan-cb');
  check('UX5修正: 不完整候选不预勾', incCb && incCb.checked === false, 'checked=' + (incCb && incCb.checked));
  check('UX5修正: 完整快照 (complete=true) 预勾', completeRow && completeRow.querySelector('.scan-cb').checked === true, 'completeRow=' + !!completeRow);
  const regBtnH = ovH && queryAll(ovH, 'button').find((b) => b.textContent && String(b.textContent).startsWith('登记选中'));
  check('UX5修正: 登记选中只计完整候选 (1 个)', regBtnH && String(regBtnH.textContent).includes('1 个'), regBtnH && regBtnH.textContent);

  // 模型列表: 推荐 TTS 不完整 → 标「⚠ 不完整」不标「可用」
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [
    { id: 'tts|en|kokoro|1', family: 'tts', language: 'en', model_id: 'kokoro-v1_0', version: 'v1.0', variant: 'v1.0', path: 'F:/hf_cache/kokoro-v1_0.pth', size_bytes: 327212226, active: true, custom: true, complete: false },
  ] });
  const mvH2 = new globalThis.ModelsView(new globalThis.AiduStore());
  const mcH2 = makeElement('div');
  mvH2.render(mcH2);
  await new Promise((r) => setTimeout(r, 60));
  const ttsSecH = queryAll(mcH2, '.model-group').find((g) => {
    const h2 = (g._children || []).find((x) => x.tagName === 'H2');
    return h2 && h2.textContent.includes('语音合成');
  });
  const ttsTextH = ttsSecH ? textOf(ttsSecH) : '';
  check('UX5修正: 推荐 TTS 不完整 → 标「⚠ 不完整」不标「可用」', ttsTextH.includes('不完整') && !ttsTextH.includes('可用'), ttsTextH.slice(0, 120));
  // 恢复 scan/register 默认, 不干扰其它段
  globalThis.AiduModelService.scan = async () => ({ ok: true, data: [] });
  globalThis.AiduModelService.list = async () => ({ ok: true, data: [] });
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

console.log('== 10. N1 (2026-08-12): 向导完成页三选一 + 代价告知 + 可重入 ==');
{
  load('views/wizard_view.js');
  globalThis.AiduModelService.scan = async (dir) => { scanDirCalls.push(dir); return { ok: true, data: [] }; };
  globalThis.AiduModelService.wizardFinish = async () => ({ ok: true });
  globalThis.AiduModelService.wizardReset = async () => { resetCalls.push(1); return { ok: true }; };
  const scanDirCalls = [];
  const resetCalls = [];
  let doneCalls = 0;

  // 完成页三选一
  const storeW = new globalThis.AiduStore();
  const wv = new globalThis.WizardView(storeW);
  wv.onDone = () => { doneCalls++; };
  wv.step = 5;
  const wc = makeElement('div');
  wv.render(wc);
  const choices = queryAll(wc, '.wizard-choice');
  const choiceLabels = choices.map((c) => textOf(c));
  check('N1: 完成页有三个选择', choiceLabels.some((t) => t.includes('导入我自己的书')) && choiceLabels.some((t) => t.includes('内置样书')) && choiceLabels.some((t) => t.includes('先去配模型')), choiceLabels.join('|'));
  const sample = choices.find((c) => textOf(c).includes('内置样书'));
  // UX5 #7: R1 内置样书从置灰变为可用 —— 点击导入样书
  check('UX5#7: 内置样书可点 (不再置灰/不再显示即将支持)', sample && sample.disabled !== true && !textOf(sample).includes('即将支持'), sample && textOf(sample));
  const sampleImportCalls = [];
  const invokeOrig = globalThis.AiduBridge.invoke;
  globalThis.AiduBridge.invoke = async (cmd) => {
    if (cmd === 'sample_book_import') { sampleImportCalls.push(1); return { ok: true, data: { edition_id: 'sample-book-default-1' } }; }
    return { ok: true, data: {} };
  };
  sample && sample.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#7: 点② → 调 sample_book_import', sampleImportCalls.length === 1, 'calls=' + sampleImportCalls.length);
  check('UX5#7: 导入后进书库 (onDone 触发)', doneCalls === 1, 'done=' + doneCalls);
  globalThis.AiduBridge.invoke = invokeOrig;
  const importBtn = choices.find((c) => textOf(c).includes('导入我自己的书'));
  importBtn.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('N1: 点「导入我自己的书」→ 调 wizardFinish + onDone 进书库', doneCalls === 2, 'done=' + doneCalls);
  const modelsBtn = choices.find((c) => textOf(c).includes('先去配模型'));
  modelsBtn.onclick();
  await new Promise((r) => setTimeout(r, 40));
  check('N1: 点「先去配模型」→ 设置页切到模型 tab 意图', storeW.state.settingsTab === 'models', 'tab=' + storeW.state.settingsTab);
  check('N1: 点「先去配模型」→ hash 跳 settings', location.hash === '#/settings', 'hash=' + location.hash);
  location.hash = '#/library';

  // 模型发现步: 代价告知 (GB + 几十分钟量级), 无模型目录时不扫 C:/
  globalThis.AiduMiscService.runtimeConfig = async () => ({ ok: true, data: {} });
  const wv2 = new globalThis.WizardView(storeW);
  wv2.step = 3;
  const wc2 = makeElement('div');
  wv2.render(wc2);
  await new Promise((r) => setTimeout(r, 80));
  const modelText = textOf(wc2);
  check('N1: 模型发现步告知总下载量 (GB)', /约需下载 [\d.]+ GB/.test(modelText), modelText.slice(0, 120));
  check('N1: 模型发现步告知单书耗时量级 (几十分钟)', modelText.includes('几十分钟'), modelText.slice(0, 120));
  check('N1: 没有模型目录时绝不扫 C:/', !scanDirCalls.includes('C:/') && !scanDirCalls.some((d) => String(d).toLowerCase().startsWith('c:') && (String(d).toLowerCase() === 'c:/' || String(d).toLowerCase() === 'c:\\')), JSON.stringify(scanDirCalls));

  // UX5 #4: 向导第 2 步 (数据目录) —— 推荐位置可见 + 完整结构引导 + 可设置
  globalThis.AiduMiscService.dataRootRecommended = async () => ({ ok: true, data: { path: 'C:/Users/x/Documents/aidulc' } });
  globalThis.AiduMiscService.libraryDirGet = async () => ({ ok: true, data: 'C:/Users/x/AppData/Roaming/aidulc' });
  const migrateCallsW = [];
  globalThis.AiduMiscService.libraryDirPickAndSet = async (d) => { migrateCallsW.push(d); return { ok: true, data: { cancelled: false, new_dir: d, backup_path: 'C:/Users/x/Documents/aidulc/backups/x', restart_required: true } }; };
  const wvData = new globalThis.WizardView(storeW);
  wvData.step = 1;
  const wcData = makeElement('div');
  wvData.render(wcData);
  await new Promise((r) => setTimeout(r, 80));
  const dataText = textOf(wcData);
  check('UX5#4: 向导第 2 步显示推荐位置 (我的文档/aidulc)', dataText.includes('C:/Users/x/Documents/aidulc'), dataText.slice(0, 100));
  check('UX5#4: 向导第 2 步结构引导 (data.db/jobs_out/models/logs)', ['data.db', 'jobs_out/', 'models/', 'logs/'].every((k) => dataText.includes(k)), dataText.slice(0, 140));
  const useRecBtn = queryAll(wcData, 'button').find((b) => b.textContent === '使用推荐位置');
  check('UX5#4: 有「使用推荐位置」按钮', !!useRecBtn);
  useRecBtn && useRecBtn.onclick();
  await new Promise((r) => setTimeout(r, 60));
  check('UX5#4: 使用推荐位置 → 调整根迁移 (libraryDirPickAndSet)', migrateCallsW.includes('C:/Users/x/Documents/aidulc'), JSON.stringify(migrateCallsW));

  // 设置页可重入: 「重新运行首次向导」→ wizardReset + 跳 #/wizard
  store.state.settingsTab = 'system';
  const sv10 = new globalThis.SettingsView(store);
  const c10 = makeElement('div');
  sv10.render(c10);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  const rerunBtn = queryAll(c10, 'button').find((b) => b.textContent === '重新运行首次向导');
  check('N1: 设置页有「重新运行首次向导」', !!rerunBtn);
  if (rerunBtn) {
    rerunBtn.onclick();
    await new Promise((r) => setTimeout(r, 40));
    check('N1: 点击 → 调 wizardReset', resetCalls.length === 1, 'reset=' + resetCalls.length);
    check('N1: 点击 → 跳 #/wizard 路由', location.hash === '#/wizard', 'hash=' + location.hash);
  }
  location.hash = '#/library';
}

console.log('== 11. M6 (2026-08-12): 主题顺序 + 跟随系统断言 + 色系一致 ==');
{
  store.state.settingsTab = 'reading';
  const sv11 = new globalThis.SettingsView(store);
  const c11 = makeElement('div');
  sv11.render(c11);
  await new Promise((r) => setTimeout(r, 80));
  store.state.settingsTab = null;
  // 主题 → 主题色 顺序: 在 form 里 主题 hint → select → 主题色 hint → chips
  const readingPane = queryAll(c11, '.settings-pane').find((p) => p.dataset.tab === 'reading');
  const form11 = readingPane && readingPane.querySelector('.settings-form');
  const seq11 = [];
  for (const ch of (form11 && form11._children) || []) {
    if (ch.tagName === 'SELECT') seq11.push('select');
    else if (ch.className && String(ch.className).includes('rd-theme-chips')) seq11.push('chips');
    else if (ch.tagName === 'DIV' && queryAll(ch, 'select').length) seq11.push('select');
    else if (ch.tagName === 'DIV') seq11.push('hint:' + (ch.textContent || '').slice(0, 3));
    else if (ch.tagName === 'LABEL') seq11.push('kid');
  }
  const seqStr = seq11.join('|');
  check('M6: 顺序 = 主题 → 下拉 → 主题色 → 色点', /hint:主题.*select.*hint:主题色.*chips/.test(seqStr), seqStr);
  // M6: 色系一致 —— SettingsView.PALETTES 与 tokens.css 的 --swatch-* 同键同量 (UX2 定 5 色系)
  const tokensCss = readFileSync(join(root, 'styles/tokens.css'), 'utf8');
  const swatchKeys = [...tokensCss.matchAll(/--swatch-([a-z]+):/g)].map((m) => m[1]);
  const paletteKeys = SettingsView.PALETTES.map(([k]) => k);
  check('M6: PALETTES 5 色系', paletteKeys.length === 5, paletteKeys.join(','));
  check('M6: PALETTES 与 tokens.css --swatch-* 一一对应', swatchKeys.length === 5 && swatchKeys.every((k) => paletteKeys.includes(k)) && paletteKeys.every((k) => swatchKeys.includes(k)), 'swatch=' + swatchKeys.join(',') + ' palette=' + paletteKeys.join(','));
  // M6: 跟随系统在系统深色下取深色令牌 (resolveTheme 断言; 门禁已有, 这里再锁一条)
  load('core/theme.js');
  check('M6: resolveTheme(system) 在系统深色下返回 dark', globalThis.AiduTheme.resolveTheme('system', true) === 'dark');
  check('M6: resolveTheme(system) 在系统浅色下返回 light', globalThis.AiduTheme.resolveTheme('system', false) === 'light');
}

console.log('== 12. UX6 #5 (2026-08-13): 章节下拉菜单 —— 章多时精确选章 (顶栏章名可点) ==');
{
  load('views/reader/chapter_menu.js');
  const jumpCalls = [];
  const trigger = makeElement('span');
  trigger.className = 'rd-title';
  const menu = new globalThis.ChapterMenu({
    triggerEl: trigger,
    getChapters: () => [
      { title: 'Introduction' }, { title: 'The Awakening' },
      { title: 'Storm' }, { title: 'Homecoming' },
    ],
    getCurrentIndex: () => 1,
    onSelect: (i) => jumpCalls.push(i),
  });
  // 触发点: 加 rd-title-btn 类 (可点暗示) + ▾
  check('UX6#5: 触发点章名加 rd-title-btn 类', trigger.classList.contains('rd-title-btn'), trigger.className);
  // 打开: 点触发点 → 弹列表
  trigger.onclick && trigger.onclick({ stopPropagation: () => {} });
  check('UX6#5: 点章名 → 下拉打开 (isOpen)', menu.isOpen(), 'open=' + menu.isOpen());
  check('UX6#5: 下拉列出全部章', menu.el && queryAll(menu.el, '.rd-chapter-menu-item').length === 4, 'items=' + (menu.el && queryAll(menu.el, '.rd-chapter-menu-item').length));
  const itemTexts = menu.el ? queryAll(menu.el, '.rd-chapter-menu-item').map((b) => b.textContent) : [];
  check('UX6#5: 章节带序号 + 章名', itemTexts[0] === '1. Introduction' && itemTexts[3] === '4. Homecoming', itemTexts.join('|'));
  const cur = menu.el && menu.el.querySelector('.rd-chapter-menu-item.current');
  check('UX6#5: 当前章高亮 (第2章 current)', cur && cur.textContent.includes('Awakening'), cur && cur.textContent);
  // 点非当前章 → 跳章 + 关闭
  const item2 = menu.el && queryAll(menu.el, '.rd-chapter-menu-item')[2];
  item2 && item2.onclick();
  check('UX6#5: 点「3. Storm」→ onSelect(2) + 关闭', jumpCalls.at(-1) === 2 && !menu.isOpen(), 'calls=' + jumpCalls.join(',') + ' open=' + menu.isOpen());
  // Esc 关闭
  trigger.onclick({ stopPropagation: () => {} });
  menu.close(); // 无 keydown stub, 直接走 close
  check('UX6#5: close 后非打开', !menu.isOpen());
  // 点当前章 → 不跳 (当前章已是 1)
  trigger.onclick({ stopPropagation: () => {} });
  const cur2 = menu.el && queryAll(menu.el, '.rd-chapter-menu-item')[1];
  const before = jumpCalls.length;
  cur2 && cur2.onclick();
  check('UX6#5: 点当前章 → 不跳章', jumpCalls.length === before, 'calls=' + jumpCalls.join(','));
}

console.log('== 13. UX7 #2 (2026-08-13): 浮动全局播放/停止按钮 ==');
{
  load('views/reader/global_stop.js');
  const toggleCalls = [];
  const gs = new globalThis.GlobalStopButton({ onToggle: () => toggleCalls.push(1) });
  check('UX7#2: 初始 hidden (无音频章节不显示)', gs.el.hidden === true, 'hidden=' + gs.el.hidden);
  gs.setVisible(true);
  check('UX7#2: setVisible(true) → 不再 hidden', gs.el.hidden === false, 'hidden=' + gs.el.hidden);
  check('UX7#2: 初始文案是播放态(▶)', gs.el.textContent === '▶', gs.el.textContent);
  gs.setPlaying(true);
  check('UX7#2: setPlaying(true) → 停止态(⏹) + playing 类', gs.el.textContent === '⏹' && gs.el.classList.contains('playing'), gs.el.textContent + '|' + gs.el.className);
  gs.el.onclick();
  check('UX7#2: 点击 → 调 onToggle (即 player.toggle())', toggleCalls.length === 1, 'calls=' + toggleCalls.length);
  gs.setPlaying(false);
  check('UX7#2: setPlaying(false) → 回到播放态(▶)', gs.el.textContent === '▶' && !gs.el.classList.contains('playing'), gs.el.textContent);
  gs.setVisible(false);
  check('UX7#2: 无音频章节 setVisible(false) → 重新 hidden', gs.el.hidden === true, 'hidden=' + gs.el.hidden);
}

console.log('== 14. UX7 #3 (2026-08-13): 书签按章持久化 + 跨章遍历面板 ==');
{
  load('views/reader/bookmarks.js');
  const jumpCalls = [];
  const bp = new globalThis.BookmarkPanel({
    getSentences: () => [{ original_text: 'Hello world.' }, { original_text: 'Second sentence.' }],
    getChapterIndex: () => 2, // 当前在第 3 章 (0-based idx 2)
    getChapterTitle: (idx) => 'Chapter ' + (idx + 1),
    onJumpChapter: (ch, i) => jumpCalls.push([ch, i]),
    listAllChapters: () => Promise.resolve({ '0': [1, 2], '2': [0] }), // 第 2 章 = 当前章, 应被排除
  });
  bp.restore([0]);
  await bp.showPanel();
  const panel = document.body._children.find((c) => c.id === 'bookmarks-panel');
  check('UX7#3: showPanel 挂出面板', !!panel, String(!!panel));
  const headers = panel ? queryAll(panel, '.bookmarks-header-other') : [];
  check('UX7#3: 有「其它章节」分节', headers.length === 1, 'headers=' + headers.length);
  const otherLists = panel ? queryAll(panel, '.bookmarks-list') : [];
  // 第一个 .bookmarks-list 是本章(1 行), 第二个是跨章(第 0 章 2 条书签)
  check('UX7#3: 跨章分节列出第 0 章的 2 条书签', otherLists[1] && otherLists[1]._children.length === 2, otherLists[1] && otherLists[1]._children.length);
  check('UX7#3: 当前章 (第 2 章) 不出现在跨章分节里', !(otherLists[1] && otherLists[1]._children.some((r) => r._children[0] && String(r._children[0].textContent).includes('Chapter 3'))));
  const row0 = otherLists[1] && otherLists[1]._children[0];
  row0 && row0.onclick();
  check('UX7#3: 点跨章书签行 → 调 onJumpChapter(0, 1)', jumpCalls.length === 1 && jumpCalls[0][0] === 0 && jumpCalls[0][1] === 1, JSON.stringify(jumpCalls));
}

console.log('== 15. 跟读校准: 整章平移 + 观感方向 ==');
{
  load('core/timing_offsets.js');
  load('views/reader/sync_calibrator.js');
  let current = 40;
  const nudges = [];
  const cal = new globalThis.SyncCalibrator({
    getHighlightIndex: () => current,
    getAnchors: () => [{ from: 0, offset: -4832 }],
    onNudge: (idx, delta) => nudges.push([idx, delta]),
    onReset: () => {},
  });
  cal.show();
  // 读数说观感, 不摆裸 ±ms —— 负偏移 = 高亮提前
  check('校准: 读数用观感描述', cal.valueEl.textContent === '高亮提前 4.83s', cal.valueEl.textContent);
  // 面板不再提"第 N 句": 正文里句子没有编号, 用户对不上; 且现在是整章平移
  check('校准: 提示说整章平移, 不提"第 N 句"',
    cal.hintEl.textContent.includes('整章') && !cal.hintEl.textContent.includes('句起生效'),
    cal.hintEl.textContent);

  const steps = queryAll(cal.el, '.rd-calibrator-step');
  steps[0].onclick();
  current = 47;               // 播放推进
  steps[0].onclick();
  check('校准: 每次微调都取**当前**句当基准 (整章语义下不需要冻结)',
    nudges.length === 2 && nudges[0][0] === 40 && nudges[1][0] === 47, JSON.stringify(nudges));
  // 四个按钮 = 提前2s / 提前0.5s / 延后0.5s / 延后2s
  check('校准: 「高亮提前」= 负偏移', nudges[0][1] === -2000, String(nudges[0][1]));
  steps[3].onclick();
  check('校准: 「高亮延后」= 正偏移', nudges[2][1] === 2000, String(nudges[2][1]));
  check('校准: 只剩微调 + 复位, 没有自动对齐按钮', queryAll(cal.el, '.rd-calibrator-align').length === 0);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);