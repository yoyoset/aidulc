/**
 * core/sync_credential.js —— 同步"连接"表单的纯判定逻辑 (2026-11-16)
 *
 * 用户反馈: 填了 Worker URL 之后完全不知道下一步填什么。原来界面只有一个
 * "ROOT_SECRET 或 6 位邀请码"的输入框, 没说清哪种场合用哪个。这里把"你填的是什么、
 * 它会被当成什么用、还缺什么"判出来, 由界面实时显示成一句人话。
 */
(function (global) {
  'use strict';

  /** 凭据类型: 6 位纯数字 = 邀请码 (add-device/invite-user), 其它非空 = ROOT_SECRET */
  function credentialKind(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'empty';
    return /^\d{6}$/.test(s) ? 'code' : 'secret';
  }

  /** 地址是否像样: 必须 http(s)://主机。不联网、不猜补全 (补错了比报错更糟) */
  function urlProblem(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '先填同步地址';
    if (!/^https?:\/\//i.test(s)) return '地址要以 https:// 开头, 如 https://sync.你的域名';
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s) && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(s)) {
      return '地址看起来不完整 (缺域名)';
    }
    return '';
  }

  /** 连接按钮旁的一句提示: 告诉用户当前输入会被怎么用, 还缺什么 */
  function connectHint(url, cred) {
    const up = urlProblem(url);
    if (up) return up;
    switch (credentialKind(cred)) {
      case 'empty':
        return '再填凭据: 这是你的第一台设备 → 填部署服务器时设的 ROOT_SECRET; 已有别的设备连着 → 在那台设备上点「添加另一台电脑」得到 6 位码, 填在这里。';
      case 'code':
        return '识别为 6 位邀请码 (10 分钟内有效), 点「连接」把这台电脑加进去。';
      default:
        return '识别为 ROOT_SECRET (首台设备用), 点「连接」。';
    }
  }

  /** 能不能点连接 */
  function canConnect(url, cred) {
    return !urlProblem(url) && credentialKind(cred) !== 'empty';
  }

  /** 给界面用: 把 sync_auth_device 的参数拼好 */
  function authArgs(url, cred) {
    const kind = credentialKind(cred);
    const v = String(cred || '').trim();
    return {
      workerUrl: String(url || '').trim(),
      rootSecret: kind === 'secret' ? v : null,
      code: kind === 'code' ? v : null,
    };
  }

  global.AiduSyncCredential = { credentialKind, urlProblem, connectHint, canConnect, authArgs };
})(typeof window !== 'undefined' ? window : globalThis);
