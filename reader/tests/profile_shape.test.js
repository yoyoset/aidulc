/**
 * profile_shape.test.js —— profile 组装不许漏字段 (按 contracts 校验, 不是按硬编码清单)
 *
 * 2026-08-18: K33 加 explain_max_chars / explain_min_sentence_chars 之后, 前后端
 * 一共四条路径各写一份显式白名单。8/16 修了"重跑保持原档案"那条, 漏了"新书导入"
 * 那条 —— 用户设的讲解字数上限/触发门槛在新书上被静默丢弃, 无任何报错, 直到
 * 8/18 跑 The Giver 从"废话率没降下来"倒查才发现。
 *
 * 这条测试的判据来自 contracts/job_request.schema.json 本身, 不是再抄一遍字段名:
 * 往契约里加第八个字段, 这里会先红, 逼着组装侧同步。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(here, '..', '..', 'contracts', 'job_request.schema.json'), 'utf8'),
);
const CONTRACT_KEYS = Object.keys(schema.properties.profile.properties);

let B;
beforeAll(async () => {
  globalThis.window = globalThis;
  await import('../core/builtin_profiles.js');
  B = globalThis.AiduBuiltinProfiles;
});

describe('profile 组装 (fromRow) 对齐 contracts', () => {
  it('契约里声明的每个字段都必须出现在组装结果里', () => {
    const out = B.fromRow({ id: 'default' });
    const missing = CONTRACT_KEYS.filter((k) => !(k in out));
    expect(missing, `组装结果漏了契约字段: ${missing.join(', ')}`).toEqual([]);
  });

  it('契约里的 K33 两个字段必须在(这正是 8/18 丢掉的那两个)', () => {
    expect(CONTRACT_KEYS).toContain('explain_max_chars');
    expect(CONTRACT_KEYS).toContain('explain_min_sentence_chars');
  });

  it('用户在档案表里设的值原样透传, 不被默认值覆盖', () => {
    const out = B.fromRow({
      id: 'default', name: '成人自读', explain_strategy: 'brief',
      voice: 'am_adam', speed: 1.2, highlight_granularity: 'word',
      explain_max_chars: 50, explain_min_sentence_chars: 80,
    });
    expect(out.explain_max_chars).toBe(50);
    expect(out.explain_min_sentence_chars).toBe(80);
    expect(out.voice).toBe('am_adam');
    expect(out.speed).toBe(1.2);
  });

  it('0 是合法值, 不能被 || 当成假值吃掉', () => {
    // explain_min_sentence_chars=0 表示"全部讲", 是用户真实可选的一档;
    // 用 `r.x || base.x` 写会把它悄悄变成内建默认。
    const out = B.fromRow({ id: 'default', explain_min_sentence_chars: 0, speed: 0 });
    expect(out.explain_min_sentence_chars).toBe(0);
    expect(out.speed).toBe(0);
  });

  it('空行 / 未知 id 回退内建默认, 字段依然齐全', () => {
    for (const row of [null, {}, { id: 'no-such-profile' }]) {
      const out = B.fromRow(row, 'default');
      expect(CONTRACT_KEYS.filter((k) => !(k in out))).toEqual([]);
      expect(typeof out.explain_max_chars).toBe('number');
    }
  });
});
