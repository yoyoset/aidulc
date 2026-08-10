#!/usr/bin/env node
/**
 * import_old_aidu.mjs —— 一次性:旧 AIDU 生词 → .aidu-data v3 (P1-D, 2026-08-10)
 *
 * 背景 (实测): 用户旧生词**不在** CF KV (AIDU_DB namespace 0 键), 实际在旧 AIDU Chrome
 * 扩展的 chrome.storage.local 里 (key `vocab_default`, 完整 envelope {vocab, dictionary})。
 * 本脚本把从扩展导出的 `vocab_default.json` / `dictionary_default.json` 转成
 * `.aidu-data` v3, 之后走 app 现成的 `transfer_import` → `import_aidu_data`
 * (updatedAt 新者胜合并) 导入本地 vocab 表 (user=me), 不另造一套导入逻辑。
 *
 * 规范化 (这是旧格式 → 新格式唯一必须做的转换):
 *   - 旧 entry 的 `interval` 是"天"(含浮点), 新调度器用 `intervalMs`(毫秒)。
 *     旧数据没有 intervalMs → 用 interval × 86400000 补上, 否则评分后下次间隔会被
 *     当成 0(1 分钟)重置, 复习计划坏掉。
 *   - 丢弃 `_key`(serde 忽略, 但留着脏)。
 *   - 其余字段原样保留 (stage/easeFactor/nextReview/reviews/updatedAt/addedAt/
 *     lastReview/deepData/collocations/context/meaning/phonetic/level/pos/senseId),
 *     Rust normalize_vocab_entry 补齐缺省。
 *   - 字典条目原样透传 (dict_repo.upsert 存整包 payload)。
 *
 * 用法:
 *   node scripts/import_old_aidu.mjs --vocab <vocab_default.json> [--dict <dictionary_default.json>] --out <out.json>
 *   node scripts/import_old_aidu.mjs --self-test   # 内置断言
 */
'use strict';

import { readFileSync, writeFileSync } from 'fs';

const DAY_MS = 86400000;

function normalizeVocabEntry(raw) {
  const e = { ...raw };
  delete e._key;
  // lemma 是 DB 主键成分 (upsert_sync 用 norm.lemma 拼 key), 必须小写, 否则大写 lemma
  // 会写进 me:default:Ability 而读取用 me:default:ability 查不到 → 词"消失"。
  if (typeof e.lemma === 'string') e.lemma = e.lemma.toLowerCase();
  if (e.intervalMs == null && typeof e.interval === 'number' && e.interval > 0) {
    e.intervalMs = Math.round(e.interval * DAY_MS);
  }
  return e;
}

export function buildAiduDataV3({ vocab, dict }) {
  const out = { version: 3, timestamp: Date.now(), data: { vocab: {}, dictionaries: {} } };
  if (vocab && typeof vocab === 'object') {
    const map = {};
    for (const [key, entry] of Object.entries(vocab)) {
      const norm = normalizeVocabEntry(entry);
      const lemma = String(norm.lemma || key || '').toLowerCase();
      if (!lemma) continue;
      map[lemma] = norm;
    }
    out.data.vocab['vocab_default'] = map;
  }
  if (dict && typeof dict === 'object') {
    out.data.dictionaries['dictionary_default'] = dict;
  }
  return out;
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--self-test')) return selfTest() ? 0 : 1;
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const vocabPath = get('--vocab');
  const dictPath = get('--dict');
  const outPath = get('--out');
  if (!vocabPath || !outPath) {
    console.error('用法: node scripts/import_old_aidu.mjs --vocab <vocab.json> [--dict <dict.json>] --out <out.json>');
    return 1;
  }
  const vocab = loadJson(vocabPath);
  const dict = dictPath ? loadJson(dictPath) : null;
  const v3 = buildAiduDataV3({ vocab, dict });
  writeFileSync(outPath, JSON.stringify(v3, null, 2), 'utf8');
  const vn = Object.keys(v3.data.vocab.vocab_default || {}).length;
  const dn = Object.keys(v3.data.dictionaries.dictionary_default || {}).length;
  console.log(`写 ${outPath}: vocab=${vn} 条, dictionary=${dn} 条`);
  return 0;
}

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
  };
  const v3 = buildAiduDataV3({
    vocab: {
      ability: { _key: 'ability', word: 'ability', lemma: 'Ability', meaning: '能力', stage: 'review', interval: 3, easeFactor: 1.3, nextReview: 1785664197048, reviews: 6, updatedAt: 1785577797048, addedAt: 1772953964358 },
      mastered_word: { _key: 'mastered_word', word: 'mastered_word', lemma: 'mastered_word', stage: 'mastered', interval: 0, nextReview: 0, updatedAt: 1785577797048 },
      with_ms: { word: 'with_ms', lemma: 'with_ms', stage: 'review', interval: 2, intervalMs: 999, updatedAt: 1 },
    },
    dict: { bank: { lemma: 'bank', meaning: '银行', senses: [] } },
  });
  const m = v3.data.vocab.vocab_default;
  check('interval 天 → intervalMs', m.ability.intervalMs === 3 * DAY_MS, m.ability.intervalMs);
  check('lemma 小写化', m.ability.lemma === 'ability', m.ability.lemma);
  check('_key 已丢弃', !('_key' in m.ability), m.ability);
  check('mastered interval 0 → intervalMs 保持', m.mastered_word.intervalMs == null, m.mastered_word);
  check('已有 intervalMs 不被覆盖', m.with_ms.intervalMs === 999, m.with_ms);
  check('字典原样透传', v3.data.dictionaries.dictionary_default.bank.meaning === '银行');
  check('版本 v3', v3.version === 3);
  console.log(`self-test: ${pass} 通过 / ${fail} 失败`);
  return fail === 0;
}

if (import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  process.exit(main(process.argv));
}
