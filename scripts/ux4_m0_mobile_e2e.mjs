/**
 * scripts/ux4_m0_mobile_e2e.mjs —— M0 验收: 干净浏览器 + 本地 worker 端到端 (2026-08-12)
 *
 * 验收口径 (GOAL UX4 M0): "干净浏览器打开配对链接 → 今日待复习显示非 0; 控制台无
 * InvalidStateError"。
 *
 * 做法:
 *   1. 本地起真实 worker (cloud/worker/src/server.mjs, 同一份 index.js 业务代码)
 *      + 临时 KV 目录; 桌面推 20 个到期词 + 5 个新词进服务端。
 *   2. 全新 Chrome profile (干净浏览器) 打开 cloud/mobile/index.html 的配对链接
 *      `#t=<手机token>&u=http://127.0.0.1:PORT` —— 走线上 app.js 的 boot 路径
 *      (applyPairing → loadEntry → syncInBackground)。
 *   3. 断言: #today-num 非 0; 控制台无 InvalidStateError。截图入报告。
 *
 * 依赖: Chrome, Node >= 21 (WebSocket/fetch), 无第三方包。
 * 用法: node scripts/ux4_m0_mobile_e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../cloud/worker/src/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs', 'UX4_screenshots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      else if (m.method) this.events.push(m); };
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new Cdp(ws); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
}

async function main() {
  const kvDir = mkdtempSync(join(tmpdir(), 'ux4-m0-kv-'));
  const ROOT_SECRET = 'ux4-m0-secret-' + Math.random().toString(36).slice(2, 8);
  const port = 8090 + Math.floor(Math.random() * 60);
  let server;
  try {
    server = startServer({ host: '127.0.0.1', port, kvDir, rootSecret: ROOT_SECRET, log: () => {} });

    // ---- 1. 桌面: 换 token + 推 25 词 (20 到期 + 5 新) ----
    const base = `http://127.0.0.1:${port}`;
    const auth = await (await fetch(base + '/v1/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_secret: ROOT_SECRET, device_name: '主电脑' }) })).json();
    if (!auth.ok || !auth.token) throw new Error('桌面换 token 失败: ' + JSON.stringify(auth));
    const now = Date.now();
    const words = {};
    for (let i = 0; i < 20; i++) { const k = 'due' + i; words[k] = { word: k, lemma: k, meaning: '到期词 ' + i, stage: 'review', interval_ms: 3 * 86400000, ease_factor: 2.5, reviews: 3, next_review: now - 1000, updated_at: now - 100000 + i }; }
    for (let i = 0; i < 5; i++) { const k = 'newword' + i; words[k] = { word: k, lemma: k, meaning: '新词 ' + i, stage: 'new', next_review: null, updated_at: now - 5000 + i }; }
    const push = await (await fetch(base + '/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token }, body: JSON.stringify({ words }) })).json();
    if (!push.ok) throw new Error('桌面推词失败: ' + JSON.stringify(push).slice(0, 200));
    console.log('服务端已就绪: 推', Object.keys(words).length, '词, wrote=', push.wrote);

    // 手机独立 token (add-device 流程, 干净手机的凭据)
    const code = await (await fetch(base + '/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token }, body: JSON.stringify({ type: 'add-device' }) })).json();
    const phoneAuth = await (await fetch(base + '/v1/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.code, device_name: '手机' }) })).json();
    if (!phoneAuth.ok || !phoneAuth.token) throw new Error('手机 token 失败: ' + JSON.stringify(phoneAuth));
    console.log('手机 token 已就绪 (独立凭据, user=' + phoneAuth.user_id + ')');

    // ---- 2. 干净 Chrome + 配对链接 ----
    const mobileIndex = 'file:///' + join(ROOT, 'cloud', 'mobile', 'index.html').replace(/\\/g, '/');
    const pairUrl = mobileIndex + '#t=' + encodeURIComponent(phoneAuth.token) + '&u=' + encodeURIComponent(base);
    const profile = mkdtempSync(join(tmpdir(), 'ux4-m0-chrome-'));
    const cport = 9400 + Math.floor(Math.random() * 100);
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${cport}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let cdp;
    try {
      await sleep(1600);
      const targets = await (await fetch(`http://127.0.0.1:${cport}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
      await cdp.send('Page.navigate', { url: pairUrl });

      // 等 boot: today-num 被填 + chip 不再是"同步中"
      const t0 = Date.now();
      let todayNum = null, chip = '', rows = 0;
      while (Date.now() - t0 < 20000) {
        try {
          const r = await cdp.send('Runtime.evaluate', { expression: `(() => {
            const tn = document.getElementById('today-num');
            const chipEl = document.getElementById('sync-chip');
            return JSON.stringify({ today: tn ? tn.textContent : null, chip: chipEl ? chipEl.textContent : null, rows: document.querySelectorAll('.word-row').length });
          })()`, returnByValue: true });
          const s = JSON.parse(r.result.value);
          todayNum = s.today; chip = s.chip; rows = s.rows;
          if (todayNum !== null && todayNum !== '0' && s.chip === '已同步') break;
          if (s.chip && s.chip.startsWith('同步失败')) break;
          if (s.chip && s.chip === '离线') break;
        } catch (e) { /* 页面加载中 */ }
        await sleep(400);
      }
      console.log('手机端最终状态: today-num=' + todayNum + ' chip=' + chip + ' word-rows=' + rows);

      // 控制台错误收集 (InvalidStateError 断言)
      const allErr = cdp.events.filter((m) =>
        (m.method === 'Runtime.exceptionThrown') ||
        (m.method === 'Log.entryAdded' && ['error', 'warning'].includes((m.params.entry || {}).level)) ||
        (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes((m.params.type || ''))));
      const errText = allErr.map((m) => {
        if (m.method === 'Runtime.exceptionThrown') return JSON.stringify(m.params.exceptionDetails || {}).slice(0, 200);
        if (m.method === 'Log.entryAdded') return (m.params.entry && m.params.entry.text) || '';
        if (m.method === 'Runtime.consoleAPICalled') return (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
        return '';
      }).join('\n');
      console.log('控制台 error/warning 条数:', allErr.length);
      const hasInvalidState = /InvalidStateError/i.test(errText);
      console.log('含 InvalidStateError:', hasInvalidState);
      if (errText.trim()) console.log('控制台内容(排查用):', errText.slice(0, 500));

      // ---- 3. 断言 + 截图 ----
      const ok = todayNum !== null && Number(todayNum) > 0 && !hasInvalidState;
      const todayNumValue = todayNum === null ? 'null' : todayNum;
      console.log(ok ? 'PASS: 今日待复习=' + todayNumValue + ' 且无 InvalidStateError' : 'FAIL: today=' + todayNumValue + ' invalidState=' + hasInvalidState + ' err=' + errText.slice(0, 300));

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, 'ux4-m0-mobile-clean.png');
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('截图:', file);
      process.exit(ok ? 0 : 1);
    } finally {
      try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
      try { chrome.kill(); } catch (e) {}
      try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    }
  } finally {
    try { server && server.stop(); } catch (e) {}
    try { rmSync(kvDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('失败:', e && e.message || e); process.exit(1); });
