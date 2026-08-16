/**
 * core/builtin_profiles.js —— 内建档案参数 + 音色候选 (纯逻辑, 零 DOM)
 *
 * 2026-08-09 硬编码去重: 此前 `default`/`kid` 内建档案参数在 import_service.js 和
 * settings_view.js 各写一份, 音色列表只存在于 settings_view —— 改一处忘另一处会静默漂移。
 * 这里是前端唯一真相源; 档案表为空时由 import_service 兜底、settings_view 补行都读它。
 *
 * 注意: 音色候选的"真实"清单在侧车 prep/aidulc_prep/application/language_registry.py
 * (tts_voices), 前端暂无 IPC 暴露它 —— 本文件是前端侧兜底, 两侧不一致时以侧车为准。
 */
(function (global) {
  'use strict';

  /** 内建档案 (查不到档案 / 档案表为空时兜底; 用户自建/编辑后以 DB 为准) */
  const BUILTIN_PROFILES = {
    default: {
      id: 'default', name: '成人自读',
      explain_strategy: 'brief', voice: 'af_heart', speed: 1.0,
      highlight_granularity: 'sentence',
      explain_max_chars: 150, explain_min_sentence_chars: 0,
    },
    kid: {
      id: 'kid', name: '陪小孩读',
      explain_strategy: 'deep', voice: 'af_heart', speed: 0.9,
      highlight_granularity: 'word',
      explain_max_chars: 150, explain_min_sentence_chars: 0,
    },
  };

  /** 音色候选 (可用性取决于已装模型, 保留提示) */
  const VOICES = [
    ['af_heart', 'af_heart · 女声温暖 (默认)'],
    ['af_bella', 'af_bella · 女声明亮'],
    ['af_nicole', 'af_nicole · 女声自然'],
    ['af_sarah', 'af_sarah · 女声柔和'],
    ['am_michael', 'am_michael · 男声沉稳'],
    ['am_fenrir', 'am_fenrir · 男声低沉'],
    ['am_adam', 'am_adam · 男声明亮'],
    ['am_echo', 'am_echo · 男声清晰'],
  ];

  /** 取内建档案参数 (拷贝, 避免调用方改动污染常量表); 未知 id 回退 default。 */
  function builtinProfile(id) {
    const key = id || 'default';
    return { ...(BUILTIN_PROFILES[key] || BUILTIN_PROFILES.default) };
  }

  /** 给档案列表补上缺失的内建项 (default 队首 / kid 队尾), 返回新数组。 */
  function ensureBuiltins(profiles) {
    const out = (profiles || []).slice();
    if (!out.some((p) => p && p.id === 'default')) out.unshift({ ...BUILTIN_PROFILES.default });
    if (!out.some((p) => p && p.id === 'kid')) out.push({ ...BUILTIN_PROFILES.kid });
    return out;
  }

  global.AiduBuiltinProfiles = { BUILTIN_PROFILES, VOICES, builtinProfile, ensureBuiltins };
})(window);
