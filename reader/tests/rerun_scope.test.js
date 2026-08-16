import { describe, it, expect, beforeAll } from 'vitest';

let suggest;

beforeAll(async () => {
  await import('../core/rerun_scope.js');
  suggest = globalThis.AiduRerunScope.suggest;
});

const P = (over) => Object.assign({
  explain_strategy: 'brief',
  explain_max_chars: 150,
  explain_min_sentence_chars: 0,
  voice: 'af_heart',
  speed: 1.0,
}, over || {});

describe('AiduRerunScope.suggest', () => {
  it('什么都没变 → 自动(只跑失败句)', () => {
    expect(suggest({ oldProfile: P(), newProfile: P() })).toBe('');
    expect(suggest({})).toBe('');
  });

  it('换分词模型 → 全部重跑(句子边界会变, 下游全作废)', () => {
    expect(suggest({ nlpChanged: true })).toBe('all');
  });

  it('分词优先级高于翻译引擎', () => {
    expect(suggest({ nlpChanged: true, llmChanged: true })).toBe('all');
  });

  it('换翻译引擎 → 从翻译(翻译和讲解都由它生成)', () => {
    expect(suggest({ llmChanged: true })).toBe('translate');
  });

  it('只改讲解深度 → 从讲解', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ explain_strategy: 'deep' }) })).toBe('explain');
  });

  it('只改讲解字数上限 → 从讲解', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ explain_max_chars: 100 }) })).toBe('explain');
  });

  it('只改讲解触发门槛 → 从讲解', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ explain_min_sentence_chars: 30 }) })).toBe('explain');
  });

  it('只改音色 → 从语音', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ voice: 'af_bella' }) })).toBe('tts');
  });

  it('只改语速 → 从语音', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ speed: 1.2 }) })).toBe('tts');
  });

  it('换 TTS 模型但档案没变 → 从语音', () => {
    expect(suggest({ oldProfile: P(), newProfile: P(), ttsChanged: true })).toBe('tts');
  });

  it('讲解和音色都改了 → 全部重跑', () => {
    expect(suggest({ oldProfile: P(), newProfile: P({ explain_strategy: 'deep', voice: 'af_bella' }) })).toBe('all');
  });

  it('缺一侧档案时不瞎猜, 但模型变化仍然生效', () => {
    expect(suggest({ oldProfile: null, newProfile: P({ explain_strategy: 'deep' }) })).toBe('');
    expect(suggest({ oldProfile: null, newProfile: null, ttsChanged: true })).toBe('tts');
  });

  it('旧档案没有 K33 字段(undefined)不该被当成"改了"', () => {
    const legacy = { explain_strategy: 'brief', voice: 'af_heart', speed: 1.0 };
    expect(suggest({ oldProfile: legacy, newProfile: Object.assign({}, legacy) })).toBe('');
  });
});
