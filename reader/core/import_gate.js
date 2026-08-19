/**
 * import_gate.js —— 导入前体检结果 → 放行名单 + 人话提示(纯逻辑, 无 DOM)
 *
 * STDIMPORT (2026-08-17): 侧车 `--audit-book` 按统一标准 S1-S6 判每本源书
 * (达标 ok / 警告 warn / 不达标 block / 判不了 unknown)。这里决定"哪些放进书库、
 * 跟用户说什么", 判据本身不在这里(在 prep 侧 core/standard.py, 一处定义)。
 *
 * AUTOSTANDARDIZE (2026-08-19): 不再有"完全拒绝"。「不放行」会挡住本来就是最需要
 * 救的那批书(格式不标准多数只是缺元信息/结构略乱, 不是读不了)。取舍改为:
 * block 的书照常进 accepted 登记, 同时进 pendingStandardize 让 Rust 侧对这些路径
 * 后台尝试自动转换——它到底是"救得回来"还是"彻底坏", 由后台任务的结果
 * (standardize_status/standardize_note) 定论, 卡片上有痕迹可查; warn 的书照常导入
 * (可能只是章节标题不好看, 不影响能读), 只提示一句。
 */
(function (global) {
  'use strict';

  /**
   * @param {string[]} paths 待导入路径
   * @param {object[]} audits 与 paths 同序的体检结果 (verdict/issues/title)
   * @returns {{accepted: string[], pendingStandardize: string[], warned: object[], messages: object[]}}
   *   pendingStandardize: 格式不标准(block)但照常进书库的书路径, 交给后台自动转换
   *   messages: [{ level: 'info'|'warning', text }] 按顺序展示给用户
   */
  function evaluate(paths, audits) {
    var list = paths || [];
    var res = audits || [];
    var accepted = [];
    var pendingStandardize = [];
    var pendingInfo = []; // 仅供消息文案 ({ name, reason })
    var warned = [];
    list.forEach(function (p, i) {
      var a = res[i] || {};
      var name = shortName(p);
      if (a.verdict === 'block') {
        // AUTOSTANDARDIZE: 不放行列表整个删掉了 —— block 照常进书库 + 后台尝试转换
        accepted.push(p);
        pendingStandardize.push(p);
        pendingInfo.push({ name: name, reason: firstIssue(a) });
        return;
      }
      if (a.verdict === 'warn') warned.push({ path: p, name: name, reason: firstIssue(a) });
      accepted.push(p);
    });
    var messages = [];
    if (pendingInfo.length) {
      messages.push({
        level: 'info',
        text: '有 ' + pendingInfo.length + ' 本书格式不标准, 已导入并在后台尝试自动转换: '
          + pendingInfo.map(function (b) { return b.name + '(' + b.reason + ')'; }).join('; '),
      });
    }
    if (warned.length) {
      messages.push({
        level: 'warning',
        text: '有 ' + warned.length + ' 本书有警告(仍已导入): '
          + warned.map(function (b) { return b.name + '(' + b.reason + ')'; }).join('; '),
      });
    }
    return { accepted: accepted, pendingStandardize: pendingStandardize, warned: warned, messages: messages };
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
