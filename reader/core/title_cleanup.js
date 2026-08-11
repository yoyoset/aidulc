/**
 * core/title_cleanup.js —— 书名/作者清洗 (G5, 2026-08-11)
 * 零 DOM 纯函数。把来源站文件名 (如 `Because of Winn-Dixie (Kate DiCamillo)
 * (z-library.sk, 1lib.sk, z-lib.sk).epub`) 拆成 书名 + 作者 两行:
 *   1. 剥掉扩展名 (.epub/.pdf/.txt)
 *   2. 剥掉来源站后缀 (z-library.* / 1lib.* / z-lib.* 等已知站名)
 *   3. 括号里的人名提取为作者 (整段括号当作者; 解析不出来就保留原串, 不硬塞)
 *
 * 规则是保守的: 任何一步不确定都保留原文, 绝不把猜错的结果当"清洗后"。
 */

(function (global) {
  'use strict';

  const SOURCE_SITES = [
    'z-library', 'z-lib', '1lib', 'libgen', 'annas-archive', 'anna\u2019s-archive',
    'b-ok', 'b-ok.cc', '1lib.to', 'z-lib.org', 'bookfi', 'pdfdrive',
  ];

  /** 扩展名列表 (有把握的阅读格式; 别的保留原样) */
  const EXTS = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'fb2', 'docx'];

  /** 从文件名里剥扩展名。`name.epub` → `name`; 无已知扩展名 → 原样。 */
  function stripExt(filename) {
    const lower = filename.toLowerCase();
    for (const ext of EXTS) {
      const suffix = '.' + ext;
      if (lower.endsWith(suffix)) return filename.slice(0, -suffix.length);
    }
    return filename;
  }

  /** 剥来源站后缀: `... (z-library.sk, 1lib.sk)` → `...` */
  function stripSourceSites(title) {
    // 去掉整块都是站名列表的括号组: `(z-library.sk, 1lib.sk, z-lib.sk)` → 空
    return title
      .replace(/\(([^()]*)\)/g, (whole, inner) => {
        return isSourceSiteBlock(inner) ? '' : whole;
      })
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function isSourceSiteBlock(inner) {
    const tokens = inner.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.every((t) => {
      const bare = t.replace(/\.(com|net|org|sk|to|cc|info|ru|me|io|xyz)\b/g, '');
      return SOURCE_SITES.some((s) => bare === s || bare.startsWith(s + '.') || bare.startsWith(s + ' '));
    });
  }

  /**
   * 提取作者: 找到**最后一个**括号块, 若块内不含明显非人名内容 (站名/多文件词) 视为作者。
   * 保守: 有多余括号/作者串含数字或站名 → 返回 null (保留原文)。
   */
  function extractAuthor(title) {
    // 只找整个串最后一对括号
    const lastOpen = title.lastIndexOf('(');
    const lastClose = title.lastIndexOf(')');
    if (lastOpen < 0 || lastClose < 0 || lastClose < lastOpen) return null;
    // 括号后还有内容 (如 `... (author) extra`) → 不猜
    if (title.slice(lastClose + 1).trim()) return null;
    const inner = title.slice(lastOpen + 1, lastClose).trim();
    if (!inner) return null;
    // 站名列表 → 不是作者
    if (isSourceSiteBlock(inner)) return null;
    // 作者名不应含数字 / 超长 / 逗号分隔的多个词(站名列表风格) —— 保守
    if (/\d/.test(inner)) return null;
    if (inner.length > 60) return null;
    if (inner.includes(',')) return null;
    // 一般形如 "Kate DiCamillo" 或 "Lois Lowry" —— 1-4 个词都接受, 但全大写缩写等怪串保留
    return inner;
  }

  /**
   * 主入口: 文件名 → { title, author }。
   * 拆不出作者 → author = null, title 保留原串 (去掉扩展名+来源站后缀后的)。
   */
  function parseBookTitle(filename) {
    let t = stripExt(String(filename || '')).trim();
    if (!t) return { title: '', author: null };
    t = stripSourceSites(t);
    const author = extractAuthor(t);
    if (author != null) {
      // 从末尾剥掉作者括号: `Because of Winn-Dixie (Kate DiCamillo)` → 书名
      const idx = t.lastIndexOf('(' + author + ')');
      if (idx >= 0) {
        const title = t.slice(0, idx).trim();
        return { title: title || t, author };
      }
    }
    return { title: t, author };
  }

  global.AiduTitleCleanup = { parseBookTitle, stripExt, stripSourceSites, extractAuthor };
})(window);
