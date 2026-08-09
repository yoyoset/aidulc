/**
 * core/follow_presets.js —— 逐句跟读的命名预设 (纯逻辑, 零 DOM, S5)
 *
 * 设计 §2.7: 「重复次数 / 留白毫秒 / 速度」三个裸输入框换成三个命名预设,
 * 每个是一组参数。数字仍可展开微调, 但默认不出现。
 */
(function (global) {
  'use strict';

  const FOLLOW_PRESETS = {
    first: {
      key: 'first',
      name: '初听',
      repeat: 1,
      gapMs: 0,
      speed: 1.0,
      blind: false,
      desc: '先整段听懂',
    },
    shadow: {
      key: 'shadow',
      name: '跟读',
      repeat: 2,
      gapMs: 900,
      speed: 0.9,
      blind: false,
      desc: '留白就是你开口的时间',
    },
    blind: {
      key: 'blind',
      name: '盲跟',
      repeat: 3,
      gapMs: 1200,
      speed: 0.8,
      blind: true,
      desc: '脱离文字, 靠耳朵',
    },
    kid: {
      key: 'kid',
      name: '孩子',
      repeat: 3,
      gapMs: 1500,
      speed: 0.7,
      blind: false,
      desc: '慢速多遍, 留白更长, 陪读友好',
    },
  };

  const PRESET_ORDER = ['first', 'shadow', 'blind', 'kid'];

  /**
   * 应用预设到 ShadowMachine 兼容对象 (需有 setRepeat/setGap/setSpeed)。
   * 返回预设对象; 未知 key 返回 null 不改任何值。
   */
  function applyPreset(presetKey, shadow) {
    const p = FOLLOW_PRESETS[presetKey];
    if (!p) return null;
    shadow.setRepeat(p.repeat);
    shadow.setGap(p.gapMs);
    shadow.setSpeed(p.speed);
    return p;
  }

  function presetByKey(key) {
    return FOLLOW_PRESETS[key] || null;
  }

  function allPresets() {
    return PRESET_ORDER.map((k) => FOLLOW_PRESETS[k]);
  }

  global.AiduFollowPresets = {
    FOLLOW_PRESETS,
    PRESET_ORDER,
    applyPreset,
    presetByKey,
    allPresets,
  };
})(window);
