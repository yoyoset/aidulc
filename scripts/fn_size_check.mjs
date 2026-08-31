/**
 * scripts/fn_size_check.mjs —— "单个函数不得过长"门禁
 *
 * 为什么加这条 (2026-08-31 治理): 原来只有"文件总行数"一条判据, 它有两个毛病 ——
 * 对 registry.rs / store_mod.rs 这类**结构性增长**的文件, 总行数注定年年撞线, 于是
 * 每次加代码的人要么手动调大数字、要么无视门禁 (实测某次审计时 10 个文件同时飘红
 * 却没人管, 就是这个规则自身失效的结果); 反过来, 它又抓不住"文件不算长但里面有个
 * 400 行的巨型函数"。
 *
 * 真正让代码难读难改的是**单个函数塞了太多事**: settings_view.js 当年的病是一个
 * render() 里塞了 5 个 tab, library_view.js 的病是三个上百行的模态挤在一个类里 ——
 * 两次都是函数级的问题, 不是文件级的。这条判据直接对着病因。
 *
 * 治理方式抄 clippy 基线那一套 (项目里已在用、大家也认): 只有一个数字 —— "超标函数
 * 总数", **只能降不能加**。不按文件登记豁免清单, 免得又变成一份没人维护的名册。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/file_size_baseline.json'), 'utf8'));
const MAX = cfg.maxFunctionLines;
const BASELINE = cfg.functionOverBaseline;

/** Rust: 任意缩进的 fn 定义 */
const RS_SIG = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z0-9_]+)/;
/** JS: class 方法 (`name(args) {` 独占一行结尾) */
const JS_METHOD = /^\s*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$/;
/** JS: 具名函数声明 */
const JS_FN = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
/** 这些是控制流关键字, 形状像方法但不是 */
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'tests') continue;
      walk(p, out);
    } else if (name.endsWith('.rs') || (name.endsWith('.js') && !name.endsWith('.test.js'))) {
      out.push(p);
    }
  }
  return out;
}

/** 粗暴去掉字符串/行注释里的花括号, 免得深度算错 */
function stripNoise(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/"(\\.|[^"\\])*"/g, '""')
    .replace(/'(\\.|[^'\\])*'/g, "''")
    .replace(/`(\\.|[^`\\])*`/g, '``');
}

function scan(path) {
  const isRs = path.endsWith('.rs');
  const lines = readFileSync(path, 'utf8').split('\n');
  const found = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const m = isRs ? RS_SIG.exec(raw) : (JS_METHOD.exec(raw) || JS_FN.exec(raw));
    if (m && !NOT_A_NAME.has(m[1])) {
      let depth = 0;
      let started = false;
      let j = i;
      for (; j < lines.length; j++) {
        const s = stripNoise(lines[j]);
        for (const c of s) {
          if (c === '{') { depth++; started = true; } else if (c === '}') depth--;
        }
        if (started && depth <= 0) break;
      }
      found.push({ name: m[1], lines: j - i + 1, at: i + 1 });
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
}

const roots = [join(ROOT, 'src-tauri/src'), join(ROOT, 'reader')];
const offenders = [];
let total = 0;
for (const r of roots) {
  for (const f of walk(r)) {
    for (const fn of scan(f)) {
      total++;
      if (fn.lines > MAX) {
        offenders.push({ ...fn, file: relative(ROOT, f).split(sep).join('/') });
      }
    }
  }
}
offenders.sort((a, b) => b.lines - a.lines);

console.log(`扫描 ${total} 个函数/方法, 超过 ${MAX} 行的有 ${offenders.length} 个 (基线 ${BASELINE}):`);
for (const o of offenders) {
  console.log(`  ${String(o.lines).padStart(5)} 行  ${o.name}  ${o.file}:${o.at}`);
}

if (offenders.length > BASELINE) {
  console.log('');
  console.log(`超标函数从 ${BASELINE} 涨到 ${offenders.length} —— 这个数字只能降不能加。`);
  console.log('新写的函数超过上限, 说明它塞了多件事, 按真实职责边界拆开;');
  console.log('不要为了让门禁变绿去调大 functionOverBaseline。');
  process.exit(1);
}
if (offenders.length < BASELINE) {
  console.log('');
  console.log(`比基线少了 ${BASELINE - offenders.length} 个 —— 把 scripts/file_size_baseline.json 的`);
  console.log(`functionOverBaseline 降到 ${offenders.length}, 锁住这次改进。`);
  process.exit(1);
}
console.log('持平基线。');
