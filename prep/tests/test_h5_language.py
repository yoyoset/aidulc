"""H5 弹性测试: 语言注册表数据驱动 (结构多语言化, 验收聚焦英文)

验证:
1. en 完整可用 (nlp 模型/tts 码/voice/prompts)
2. 未知语言 fallback en + 警告
3. 预留语言 (ja) fallback en
4. 注册表加新语言不影响其它条目 (结构弹性)
5. voice 校验 (无效 voice → 默认)
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.application.language_registry import (
    LANGUAGES,
    get_explain_system,
    get_nlp_model,
    get_spec,
    get_translate_system,
    get_tts_lang_code,
    get_tts_voice,
)


class TestEnglishComplete:
    def test_en_nlp_model(self):
        assert get_nlp_model("en") == "en_core_web_sm"

    def test_en_tts_lang_code(self):
        assert get_tts_lang_code("en") == "a"

    def test_en_voice_default(self):
        assert get_tts_voice("en") == "af_heart"

    def test_en_voice_override_valid(self):
        assert get_tts_voice("en", "af_alloy") == "af_alloy"

    def test_en_voice_override_invalid_falls_back(self):
        assert get_tts_voice("en", "bogus_voice") == "af_heart"

    def test_en_prompts(self):
        tr = get_translate_system("en")
        ex = get_explain_system("en")
        assert tr and "翻译" in tr
        assert ex and "讲解" in ex

    def test_none_language_defaults_en(self):
        assert get_nlp_model(None) == "en_core_web_sm"


class TestFallback:
    def test_unknown_language_falls_back_en(self):
        assert get_nlp_model("xx") == "en_core_web_sm"
        assert get_tts_lang_code("xx") == "a"

    def test_reserved_ja_falls_back_en(self):
        # ja 是预留条目, implemented=False → fallback en (不崩溃)
        assert LANGUAGES["ja"].implemented is False
        assert get_spec("ja").code == "en", "ja 未实现应 fallback 到 en"
        assert get_nlp_model("ja") == "en_core_web_sm"


class TestElasticity:
    def test_registry_is_data_not_code(self):
        """注册表加语言不需要改 pipeline —— 验证条目是可加数据"""
        assert "en" in LANGUAGES
        assert "ja" in LANGUAGES  # 预留
        # 每个 spec 有完整字段
        for code, spec in LANGUAGES.items():
            assert spec.code == code
            assert spec.nlp_model
            assert spec.tts_voice_default
