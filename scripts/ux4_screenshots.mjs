/**
 * scripts/ux4_screenshots.mjs —— UX4 真机截图生成器 (2026-08-12)
 *
 * 用真实 Chrome (headless) 加载 reader/index.html —— 真实 CSS/字体/布局渲染。
 * 只 stub window.__TAURI__ (invoke 分发), 应用本体 main.js/views/services 全是线上代码,
 * 不是测试替身。截图是"真机渲染结果", 不是 smoke 的 DOM 断言。
 *
 * 两种会话:
 *   mode=done    向导已完成 → 截 M1 红卡/折叠 / M2 专注模式 / M4 模型+扫描候选 / M5 更改结果 / M6 主题顺序
 *   mode=wizard  向导未完成 → 截 N1 完成页三选一
 *
 * 依赖: Chrome (自动探测), Node >= 21 (全局 WebSocket), 无第三方包。
 * 用法: node scripts/ux4_screenshots.mjs [done|wizard]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX = 'file:///' + join(ROOT, 'reader', 'index.html').replace(/\\/g, '/');
const OUT = join(ROOT, 'docs', 'UX4_screenshots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(1); }
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* stub __TAURI__: invoke 分发到 handlers                                 */
/* ------------------------------------------------------------------ */
function bridgeSource(mode) {
  return `(() => {
    const H = {
      // ---- 通用 boot / shell ----
      wizard_state: () => (${mode === 'wizard'} ? { step: 0, status: 'pending', total: 6 } : { step: 6, status: 'done', total: 6 }),
      wizard_submit: () => {},
      wizard_finish: () => {},
      users_list: () => [{ id: 'me', name: '我' }, { id: 'u-kid', name: '孩子' }],
      profile_list: () => [
        { id: 'default', name: '成人自读', explain_strategy: 'brief', voice: 'af_heart', speed: 1.0, highlight_granularity: 'sentence' },
        { id: 'kid', name: '陪小孩读', explain_strategy: 'deep', voice: 'af_bella', speed: 0.9, highlight_granularity: 'word' },
      ],
      settings_get: () => ({ font_size: 19, line_height: 1.85, content_width: 660, theme: 'light', palette: 'clay', child_mode: false }),
      library_dir_get: () => 'D:/aidulc-data',
      data_migration_status: () => ({ portable: false, data_dir: 'D:/aidulc-data', db_path: 'D:/aidulc-data/data.db', out_dir: 'D:/aidulc-data/jobs_out', pending: false }),
      components_health: () => [
        { id: 'prep', name: 'prep 侧车', healthy: true, detail: '就绪' },
        { id: 'ffmpeg', name: 'ffmpeg', healthy: true, detail: '就绪' },
        { id: 'llm', name: 'LLM 模型', healthy: true, detail: 'Qwen3 4B', update_channel: '无更新渠道' },
        { id: 'tts', name: 'TTS 模型', healthy: true, detail: 'Kokoro', update_channel: '无更新渠道' },
        { id: 'pymupdf', name: 'PyMuPDF', healthy: true, detail: '就绪' },
      ],
      runtime_config: () => ({
        llm_model: 'D:/aidulc-data/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        tts_model: 'D:/aidulc-data/models/kokoro-v1_0.pth',
        default_model_dir: 'D:/aidulc-data/models',
        hf_cache_dir: 'F:/hf_cache',
        ffmpeg: 'C:/ffmpeg/ffmpeg.exe',
      }),
      online_config_get: () => ({ endpoint: '', model: '', key_configured: false, lookup_enabled: false, whole_book_enabled: false }),
      sync_status: () => ({ status: 'unconfigured', configured: false, user_id: 'me', pending_count: 0 }),
      backends_list: () => [],
      log_from_frontend: () => {},
      // ---- 书库 (M1) ----
      library_list: (args) => {
        const kind = args && args.kind;
        if (kind === 'original') {
          return [
            { id: 's1', title: 'Alice (Lewis Carroll).epub', kind: 'original', status: 'done',
              source_language: 'en', chapter_count: 0, failed_count: 0,
              source_path: 'C:/Books/Alice.epub', pack_state: 'missing',
              editions: [
                { id: 'job-1786205609337-11852-1', title: 'Alice 译本', status: 'ready', pack_state: 'missing',
                  source_id: 's1', profile_id: 'default', chapter_count: 12,
                  llm_id: 'llm|en|qwen3-4b|2507-q4_k_m', tts_id: 'tts|en|kokoro|v1',
                  pack_dir: 'D:/aidulc-data/jobs_out/job-1786205609337-11852-1' },
              ] },
            { id: 's2', title: 'Number the Stars.epub', kind: 'original', status: 'pending',
              source_language: 'en', source_path: 'C:/Books/Star.epub', editions: [] },
            { id: 's3', title: 'The Old Man and the Sea (Ernest Hemingway).epub', kind: 'original', status: 'done',
              source_language: 'en', source_path: 'C:/Books/OldMan.epub', pack_state: 'ok',
              editions: [
                { id: 'e-ok-1', title: '老人与海 译本', status: 'ready', pack_state: 'ok',
                  source_id: 's3', profile_id: 'default', chapter_count: 8,
                  llm_id: 'llm|en|qwen3-4b|2507-q4_k_m', tts_id: 'tts|en|kokoro|v1',
                  pack_dir: 'D:/aidulc-data/jobs_out/e-ok-1' },
              ] },
          ];
        }
        return [];
      },
      library_remove: () => {},
      job_list: () => [],
      // ---- 生词本 / 复习 (M2) ----
      vocab_all: () => [
        { word: 'reticent', lemma: 'reticent', stage: 'review', interval_ms: 3 * 86400000, next_review: Date.now() - 1000, meaning: '沉默寡言的', phonetic: '/r/', context: 'He was reticent about the war.', edition_id: 'job-1786205609337-11852-1', chapter_index: 2, sentence_index: 5, updated_at: Date.now() },
        { word: 'languid', lemma: 'languid', stage: 'learning', interval_ms: 10 * 60000, next_review: Date.now() - 500, meaning: '倦怠的', context: 'A languid summer afternoon.', edition_id: 'job-1786205609337-11852-1', chapter_index: 3, sentence_index: 1, updated_at: Date.now() },
        { word: 'bank', lemma: 'bank', stage: 'new', next_review: null, meaning: '银行', context: 'He went to the bank.', updated_at: Date.now() },
        { word: 'quiet', lemma: 'quiet', stage: 'new', next_review: null, meaning: '安静的', context: 'Keep quiet, please.', updated_at: Date.now() },
        { word: 'murmur', lemma: 'murmur', stage: 'new', next_review: null, meaning: '低语', context: 'She murmured a reply.', updated_at: Date.now() },
        { word: 'glance', lemma: 'glance', stage: 'new', next_review: null, meaning: '瞥一眼', context: 'A quick glance around.', updated_at: Date.now() },
      ],
      srs_preview: () => ({ options: [1, 2, 3, 4].map((g) => ({ grade: g, human: ['1 分钟', '10 分钟', '3 天', '8 天'][g - 1] })) }),
      edition_lookup: () => ({ id: 'job-1786205609337-11852-1', title: 'Alice 译本', chapter_count: 12, source_id: 's1' }),
      // ---- 模型 (M4) ----
      models_list: () => [
        { id: 'llm|en|qwen3-4b|2507-q4_k_m', family: 'llm', language: 'en', model_id: 'Qwen3-4B-Instruct-2507-Q4_K_M', version: '2507-Q4_K_M', variant: 'Q4_K_M', path: 'F:/hf_cache/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size_bytes: 2497280256, active: true, custom: false, asset_status: 'recommended' },
        { id: 'tts|en|kokoro|v1', family: 'tts', language: 'en', model_id: 'kokoro-v1_0', version: 'v1.0', variant: 'v1.0', path: 'F:/hf_cache/kokoro-v1_0.pth', size_bytes: 327212226, active: true, custom: false, asset_status: 'recommended' },
      ],
      models_scan: (args) => {
        const dir = (args && (args.modelDir || args.model_dir)) || '';
        if (String(dir).toLowerCase().includes('hf_cache')) {
          return [
            { path: 'F:/hf_cache/hub/models--spacy--en_core_web_sm/snapshots/abc/model.bin', file_name: 'model.bin', size_bytes: 1000, family_hint: 'nlp', registered: false },
            { path: 'F:/hf_cache/ggml-large-v3.bin', file_name: 'ggml-large-v3.bin', size_bytes: 2000, family_hint: 'asr', registered: false },
            { path: 'F:/hf_cache/ggml-silero-v5.1.2.bin', file_name: 'ggml-silero-v5.1.2.bin', size_bytes: 3000, family_hint: 'vad', registered: false },
          ];
        }
        return [
          { path: 'D:/aidulc-data/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', file_name: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size_bytes: 2497280256, family_hint: 'llm', registered: true },
          { path: 'D:/aidulc-data/models/kokoro-v1_0.pth', file_name: 'kokoro-v1_0.pth', size_bytes: 327212226, family_hint: 'tts', registered: false },
        ];
      },
      models_register: () => 'ok',
      models_set_family: () => {},
      models_set_recommended: () => {},
      models_remove: () => {},
      book_binding: () => ({}),
      models_book_binding: () => ({}),
      // ---- 设置 / 书库位置 (M5) ----
      library_dir_pick_and_set: () => ({ cancelled: false, old_dir: 'D:/aidulc-data', new_dir: 'D:/aidulc-data-new', book_count: 3, restart_required: true }),
      library_dir_pick: () => ({ cancelled: true }),
      library_dir_scan: () => ({ dir: 'D:/ext-lib', importable: [], existing: [] }),
      library_dir_import: () => ({ imported: 0, failed: [] }),
      log_path: () => ({ path: 'D:/aidulc-data/logs/aidulc.log' }),
      // ---- 杂项兜底 ----
      pick_files: () => ({ cancelled: true }),
      'plugin:opener|open_path': () => {},
    };
    window.__TAURI__ = {
      core: { invoke: (cmd, args) => Promise.resolve(H[cmd] ? H[cmd](args || {}) : {}) },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  })();`;
}

/* ------------------------------------------------------------------ */
/* CDP 客户端 (极简, Node 全局 WebSocket)                                  */
/* ------------------------------------------------------------------ */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Cdp(ws);
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result ? r.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJs(cdp, expression)) return;
    } catch (e) { /* 页面可能还在加载 */ }
    await sleep(250);
  }
  throw new Error('waitFor 超时: ' + expression);
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(OUT, name + '.png');
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('截图:', file);
}

async function dumpDom(cdp, label, selector) {
  const expr = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, 12).map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()).join(' | ')`;
  const t = await evalJs(cdp, expr);
  console.log('DOM[' + label + '] ' + selector + ':', String(t).slice(0, 300));
}

async function click(cdp, sel, text, opts) {
  const exact = opts && opts.exact;
  const expr = `(() => {
    const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
    const el = ${text ? `els.find((e) => { const t = (e.textContent||'').trim(); return ${exact ? `t === ${JSON.stringify(text)}` : `t.includes(${JSON.stringify(text)})`}; })` : 'els[0]'};
    if (!el) return false;
    el.click();
    return true;
  })()`;
  const ok = await evalJs(cdp, expr);
  if (!ok) throw new Error('click 未找到: ' + sel + ' / ' + text);
}

/* ------------------------------------------------------------------ */
/* 会话 A: 向导已完成                                                   */
/* ------------------------------------------------------------------ */
async function sessionDone(cdp) {
  await cdp.send('Page.navigate', { url: INDEX });
  await waitFor(cdp, `document.querySelector('#app') && !!document.querySelector('.app-nav')`, 20000);

  // --- M1: 书库 红卡 + 折叠 ---
  await evalJs(cdp, `location.hash = '#/library'`);
  await waitFor(cdp, `document.querySelectorAll('.book-card').length >= 3`);
  await sleep(600);
  await dumpDom(cdp, 'M1 redcard', '.book-card .book-badge.badge-err');
  await shot(cdp, 'ux4-m1-library-redcard');
  await click(cdp, '.edition-toggle', '译本');
  await sleep(400);
  await dumpDom(cdp, 'M1 expanded', '.edition-body .edition-card button');
  await shot(cdp, 'ux4-m1-editions-expanded');

  // --- M2: 生词本 → 开始复习 → 专注模式 ---
  await evalJs(cdp, `location.hash = '#/vocab'`);
  await waitFor(cdp, `!!document.querySelector('.vocab-today-card')`);
  await sleep(500);
  await click(cdp, 'button', '开始复习');
  await waitFor(cdp, `!!document.querySelector('.review-grid')`, 10000);
  await sleep(500);
  await dumpDom(cdp, 'M2 focus', '.review-word, .review-grade-label');
  await shot(cdp, 'ux4-m2-review-focus');

  // --- M4: 模型与依赖 + 扫描候选 ---
  await evalJs(cdp, `location.hash = '#/models'`);
  await waitFor(cdp, `!!document.querySelector('.model-group')`);
  await sleep(500);
  await shot(cdp, 'ux4-m4-models-page');
  await click(cdp, 'button', '扫描已有模型');
  await waitFor(cdp, `!!document.querySelector('.scan-path-row')`);
  await sleep(300);
  await click(cdp, 'button', '扫描', { exact: true });
  await waitFor(cdp, `document.querySelectorAll('.scan-candidate').length >= 3`, 10000);
  await sleep(500);
  await dumpDom(cdp, 'M4 candidates', '.scan-candidate .book-badge, .scan-candidate .scan-fname');
  await shot(cdp, 'ux4-m4-scan-candidates');
  // 关掉扫描弹窗, 避免盖住后续设置页截图
  await click(cdp, 'button', '关闭', { exact: true });
  await sleep(300);

  // --- M5: 设置 → 系统与书库 → 更改结果 ---
  // #/models 已把设置页切到"模型与依赖" tab, 必须点回"系统与书库" (直接设同值 hash 不触发 hashchange)
  await evalJs(cdp, `location.hash = '#/settings'`);
  await waitFor(cdp, `!!document.querySelector('.settings-tabs')`);
  await sleep(300);
  await click(cdp, '.settings-tab', '系统与书库', { exact: true });
  await waitFor(cdp, `!!document.querySelector('.settings-section') && !document.querySelector('.settings-section[style*="display"]')`);
  await sleep(400);
  await click(cdp, 'button', '更改…', { exact: true });
  await waitFor(cdp, `(document.body.textContent||'').includes('原目录 3 本书未移动')`, 10000);
  await sleep(300);
  await dumpDom(cdp, 'M5 change', '.settings-section .import-tip');
  await shot(cdp, 'ux4-m5-change-result');

  // --- M6: 阅读显示 tab → 主题顺序 ---
  await click(cdp, '.settings-tab', '阅读显示');
  await waitFor(cdp, `!!document.querySelector('.rd-theme-chips')`);
  await sleep(400);
  await dumpDom(cdp, 'M6 order', '.settings-form .settings-hint');
  await shot(cdp, 'ux4-m6-theme-order');
}

/* ------------------------------------------------------------------ */
/* 会话 B: 向导未完成 → 完成页三选一                                      */
/* ------------------------------------------------------------------ */
async function sessionWizard(cdp) {
  await cdp.send('Page.navigate', { url: INDEX });
  await waitFor(cdp, `!!document.querySelector('.wizard-view')`, 20000);
  await sleep(400);
  // 跳过 5 步 → 完成页 (第 6 步无底部导航)
  for (let i = 0; i < 5; i++) {
    await click(cdp, 'button', '跳过');
    await sleep(200);
  }
  await waitFor(cdp, `document.querySelectorAll('.wizard-choice').length >= 3`);
  await sleep(400);
  await dumpDom(cdp, 'N1 done', '.wizard-choice');
  await shot(cdp, 'ux4-n1-wizard-done');
}

async function main() {
  const mode = process.argv[2] || 'done';
  const profile = mkdtempSync(join(tmpdir(), 'ux4-chrome-'));
  const port = 9330 + Math.floor(Math.random() * 100);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    await sleep(1600);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 CDP page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeSource(mode) });
    if (mode === 'wizard') await sessionWizard(cdp);
    else await sessionDone(cdp);
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch (e) {} }
    try { chrome.kill(); } catch (e) {}
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('完成');
}

main().catch((e) => { console.error('失败:', e && e.message || e); process.exit(1); });
