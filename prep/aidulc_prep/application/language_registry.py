"""
application/language_registry.py —— 语言↔行为注册表 (H5)

第一性原理: 语言是数据, 不是代码。语言对应的 nlp 模型 / TTS 语言码 / 音色 /
提示词模板都是注册表条目。验收聚焦英文, 结构为多语言随时可加。

未知语言 → fallback 'en' + 明确警告 (不崩溃)。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable

log = logging.getLogger("aidulc.language")

# 提示词模板 (接受源语言/目标语言参数, 返回 system prompt)
def _en_to_zh_system(source_lang: str, target_lang: str) -> str:
    return (
        "你是专业的字幕翻译员。将用户给出的带编号英文文本逐行翻译成简体中文。要求:"
        "逐行对应翻译, 严格保留原有的\"编号.\"格式, 每行只输出一条译文, 不要合并或拆分行, "
        "不要添加编号之外的任何解释、注释或原文。"
    )


def _en_to_zh_explain(source_lang: str, target_lang: str) -> str:
    return (
        "你是英语老师的讲解助手。对每个句子输出 JSON: {\"original_text\": 原文, \"translation\": 中文翻译, "
        "\"explanation\": 中文讲解}。\n"
        "讲解要求: 只讲真难的, 1-2 句点破核心语法点或固定搭配, 直接说语法术语, 简洁。"
    )


@dataclass(frozen=True)
class LanguageSpec:
    code: str
    nlp_model: str                       # spaCy 模型名
    tts_lang_code: str | None            # Kokoro: 'a'=美音
    tts_voice_default: str
    tts_voices: tuple[str, ...] = ()
    translate_system: Callable[[str, str], str] | None = None
    explain_system: Callable[[str, str], str] | None = None
    implemented: bool = True


LANGUAGES: dict[str, LanguageSpec] = {
    "en": LanguageSpec(
        code="en",
        nlp_model="en_core_web_sm",
        tts_lang_code="a",
        tts_voice_default="af_heart",
        tts_voices=("af_heart", "af_alloy", "af_bella", "am_michael", "am_onyx"),
        translate_system=_en_to_zh_system,
        explain_system=_en_to_zh_explain,
    ),
    # 预留条目: 结构就位, 未验收。接入 = 填 spec + catalog 加模型, 不改 pipeline。
    "ja": LanguageSpec(
        code="ja",
        nlp_model="ja_core_news_sm",
        tts_lang_code="j",
        tts_voice_default="zf_xiaoxiao",
        tts_voices=("zf_xiaoxiao", "zf_xiaoni", "zf_xiaoyi"),
        translate_system=None,
        explain_system=None,
        implemented=False,
    ),
}

DEFAULT_LANG = "en"


def get_spec(language: str | None) -> LanguageSpec:
    code = (language or DEFAULT_LANG).lower()
    spec = LANGUAGES.get(code)
    if spec is None:
        log.warning("未知语言 %r, fallback 到 %s (提示: 语言是注册表条目, 可加)", code, DEFAULT_LANG)
        return LANGUAGES[DEFAULT_LANG]
    if not spec.implemented:
        log.warning("语言 %r 已预留但未实现, fallback 到 %s", code, DEFAULT_LANG)
        return LANGUAGES[DEFAULT_LANG]
    return spec


def get_nlp_model(language: str | None) -> str:
    return get_spec(language).nlp_model


def get_tts_lang_code(language: str | None) -> str | None:
    return get_spec(language).tts_lang_code


def get_tts_voice(language: str | None, voice: str | None = None) -> str:
    spec = get_spec(language)
    if voice and voice in spec.tts_voices:
        return voice
    return spec.tts_voice_default


def get_translate_system(language: str | None, target: str = "zh-CN") -> str | None:
    spec = get_spec(language)
    return spec.translate_system(spec.code, target) if spec.translate_system else None


def get_explain_system(language: str | None, target: str = "zh-CN") -> str | None:
    spec = get_spec(language)
    return spec.explain_system(spec.code, target) if spec.explain_system else None
