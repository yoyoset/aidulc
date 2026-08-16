/**
 * import_gate.js —— 导入前体检结果 → 放行名单 + 人话提示(纯逻辑, 无 DOM)
 *
 * STDIMPORT (2026-08-17): 侧车 `--audit-book` 按统一标准 S1-S6 判每本源书
 * (达标 ok / 警告 warn / 不达标 block / 判不了 unknown)。这里决定"哪些放进书库、
 * 跟用户说什么", 判据本身不在这里(在 prep 侧 core/standard.py, 一处定义)。
 *
 * 取舍: block 的书直接不导入——它们跑下去必然在 parse 阶段失败, 让它们躺在书库里
 * 只会让用户以为"导进来了就是好的"; warn 的书照常导入(可能只是章节标题不好看,
 * 不影响能读), 只提示一句。
 */
(function (global) {
  'use strict';

  /**
   * @param {string[]} paths 待导入路径
   * @param {object[]} audits 与 paths 同序的体检结果 (verdict/issues/title)
   * @returns {{accepted: string[], blocked: object[], warned: object[], messages: object[]}}
   *   messages: [{ level: 'error'|'warning', text }] 按顺序展示给用户
   */
  function evaluate(paths, audits) {
    var list = paths || [];
    var res = audits || [];
    var accepted = [];
    var blocked = [];
    var warned = [];
    list.forEach(function (p, i) {
      var a = res[i] || {};
      var name = shortName(p);
      if (a.verdict === 'block') {
        blocked.push({ path: p, name: name, reason: firstIssue(a) });
        return; // 不放行
      }
      if (a.verdict === 'warn') warned.push({ path: p, name: name, reason: firstIssue(a) });
      accepted.push(p);
    });
    var messages = [];
    if (blocked.length) {
      messages.push({
        level: 'error',
        text: '有 ' + blocked.length + ' 本书不符合导入标准, 已跳过: '
          + blocked.map(function (b) { return b.name + '(' + b.reason + ')'; }).join('; '),
      });
    }
    if (warned.length) {
      messages.push({
        level: 'warning',
        text: '有 ' + warned.length + ' 本书有警告(仍已导入): '
          + warned.map(function (b) { return b.name + '(' + b.reason + ')'; }).join('; '),
      });
    }
    return { accepted: accepted, blocked: blocked, warned: warned, messages: messages };
  }

  function firstIssue(a) {
    var issues = (a && a.issues) || [];
    if (issues.length && issues[0].message) return issues[0].message;
    return a && a.error ? a.error : '未知问题';
  }

  function shortName(p) {
    var base = String(p || '').split(/[\\/]/).pop();
    return base.replace(/\.[^.]+$/, '').split(' (')[0];
  }

  global.AiduImportGate = { evaluate: evaluate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
