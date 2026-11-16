/**
 * views/settings/notify_section.js —— E3: 设置页"处理完成通知"开关
 * 单独成文件, 不再给已经很长的 system_tab.js::render 加行数。
 */
(function (global) {
  'use strict';

  function mount(parent) {
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const N = global.AiduNotify;
    const sec = el('div', 'settings-section');
    sec.appendChild(el('h2', null, '处理完成通知'));
    const row = el('div', 'settings-row');
    const label = el('label', 'log-info');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = N.isEnabled();
    label.append(box, document.createTextNode(' 备料完成或失败时, 如果 aidulc 不在前台, 弹一条系统通知'));
    const hint = el('span', 'log-info');
    row.append(label, hint);
    sec.appendChild(row);
    parent.appendChild(sec);

    const refreshHint = (perm) => {
      if (!box.checked) { hint.textContent = ''; return; }
      if (perm === 'denied') hint.textContent = ' 系统已禁止本应用发通知, 需在 Windows 设置 → 通知 里放行。';
      else if (perm === 'unsupported') hint.textContent = ' 当前环境不支持系统通知, 仍会在应用内提示。';
      else hint.textContent = '';
    };
    box.onchange = () => {
      N.setEnabled(box.checked);
      if (!box.checked) { refreshHint(); return; }
      // 打开开关 = 用户手势, 这里才向系统要权限
      N.requestPermission().then(refreshHint);
    };
    refreshHint(global.Notification ? global.Notification.permission : 'unsupported');
    return sec;
  }

  global.AiduNotifySection = { mount };
})(window);
