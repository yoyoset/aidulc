"""LLM 输入 sanitize: 孤立代理字符不能让推理直接崩 (2026-08-20)

实测复现: 用户查 "bring" 词义报 "LLM 推理失败: 'utf-8' codec can't encode
character '\\udc9d' in position 472: surrogates not allowed"。位置 472 落在
context(书里摘的原句)里——EPUB 解析链路某一步偶尔会把一个残缺的 UTF-16 代理对
留成孤立代理字符, 这种字符在 Python str 里合法存在、一路传到 LLM 调用出口都不
报错, 只有 llama_cpp 把 prompt 编码成 UTF-8 字节喂给 C 库时才第一次触发
UnicodeEncodeError。

不去追是哪本书哪句话产生的坏字符(那是解析器的事), 只锁住"LlmServer.complete()
不管收到什么, 喂给底层引擎的一定是能被 utf-8 编码的字符串"这一条契约。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.llm.server import LlmServer


class FakeLlm:
    """假的 llama_cpp.Llama 实例: 记录收到的 messages, 模拟 create_chat_completion
    在遇到无法编码的字符时真的抛 UnicodeEncodeError(复现用户看到的原始异常类型)。"""

    def __init__(self):
        self.received_messages = None

    def create_chat_completion(self, messages, temperature=0.3, max_tokens=400):
        self.received_messages = messages
        for m in messages:
            m["content"].encode("utf-8")  # 复现底层真实会做的事: 编码成 utf-8 字节
        return {"choices": [{"message": {"content": "{}"}}]}


class FakeLlamaModule:
    def __init__(self, fake_llm):
        self._fake_llm = fake_llm

    def Llama(self, **kw):
        return self._fake_llm


def make_server(tmp_path, monkeypatch, fake_llm):
    model = tmp_path / "m.gguf"
    model.write_bytes(b"x")
    monkeypatch.setitem(sys.modules, "llama_cpp", FakeLlamaModule(fake_llm))
    return LlmServer(str(model))


def test_lone_surrogate_in_content_does_not_crash_inference(tmp_path, monkeypatch):
    fake_llm = FakeLlm()
    srv = make_server(tmp_path, monkeypatch, fake_llm)
    poisoned = "word: bring\ncontext: a sentence with a bad char \udc9d here"

    # 修复前: create_chat_completion 内部 encode("utf-8") 会真的抛 UnicodeEncodeError,
    # complete() 应该把它包装成 EngineError(不是让原始异常裸露给上层)——但更重要的是
    # 修复后根本不该走到"抛错"这条路: sanitize 已经在调用前把坏字符替换掉了。
    result = srv.complete([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": poisoned},
    ])
    assert result == "{}"
    sent = fake_llm.received_messages[1]["content"]
    assert "\udc9d" not in sent, "孤立代理字符必须在喂给引擎前被清洗掉"
    sent.encode("utf-8")  # 不抛才算数: 证明确实是合法 utf-8 了


def test_normal_content_unaffected(tmp_path, monkeypatch):
    """对照组: 正常文本原样传递, 不能被 sanitize 误伤(比如把正常中英文/标点改掉)。"""
    fake_llm = FakeLlm()
    srv = make_server(tmp_path, monkeypatch, fake_llm)
    normal = "word: bring\ncontext: She will bring the book tomorrow. 她明天会带书来。"
    srv.complete([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": normal},
    ])
    assert fake_llm.received_messages[1]["content"] == normal
