import os, time, json
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama, llama_grammar

llm = Llama(model_path=r"F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf", n_gpu_layers=99, n_ctx=16384, verbose=False)

schema = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "original_text": {"type": "string"},
                    "translation": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["original_text", "translation", "explanation"],
            },
        }
    },
    "required": ["sentences"],
}

# Method 1: explicit grammar from json_schema_to_gbnf
gbnf = llama_grammar.json_schema_to_gbnf(json.dumps(schema))
grammar = llama_grammar.LlamaGrammar.from_string(gbnf, verbose=False)
print("grammar built")

# batch of 3 sentences
batch = [
    "The quick brown fox jumps over the lazy dog.",
    "He broke the news to her carefully.",
    "She gave up smoking last year.",
]
prompt = "Translate each sentence to Chinese and explain briefly. Output JSON:\n" + "\n".join(f"{i+1}. {s}" for i, s in enumerate(batch))

t0 = time.time()
r = llm.create_chat_completion(
    messages=[{"role": "user", "content": prompt}],
    temperature=0.3, max_tokens=600,
    grammar=grammar,
)
dt = time.time() - t0
content = r["choices"][0]["message"]["content"]
print(f"grammar method: {dt:.1f}s, {r['usage']['completion_tokens']} tok -> {r['usage']['completion_tokens']/dt:.1f} t/s")
try:
    j = json.loads(content)
    print("VALID JSON, sentences:", len(j["sentences"]))
    for s in j["sentences"]:
        print(f"  {s['original_text'][:40]!r} -> {s['translation'][:30]!r} | {s['explanation'][:30]!r}")
except Exception as e:
    print("INVALID:", str(e)[:200])
    print(repr(content[:300]))
