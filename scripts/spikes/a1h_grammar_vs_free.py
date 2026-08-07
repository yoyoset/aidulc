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
gbnf = llama_grammar.json_schema_to_gbnf(json.dumps(schema))
grammar = llama_grammar.LlamaGrammar.from_string(gbnf, verbose=False)

# 10 real sentences from Alice
batch = [
    "There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, Oh dear!",
    "In another moment down went Alice after it, never once considering how in the world she was to get out again.",
    "Either the well was very deep, or she fell very slowly, for she had plenty of time as she went down to look about her and to wonder what was going to happen next.",
    "Well! thought Alice to herself, after such a fall as this, I shall think nothing of tumbling down stairs!",
    "How brave they will all think me at home!",
    "Why, I would not say anything about it, even if I fell off the top of the house!",
    "Down, down, down.",
    "Would the fall never come to an end?",
    "I wonder how many miles I have fallen by this time?",
    "I must be getting somewhere near the centre of the earth.",
]
prompt = ("你是英语老师的讲解助手。把下面每句翻译成中文，并给出针对英语学习者的简明中文讲解（1-2句，点出语法点或难词）。"
          "严格按 JSON schema 输出，逐句对应。\n" + "\n".join(f"{i+1}. {s}" for i, s in enumerate(batch)))

for label, kwargs in [("constrained(grammar)", {"grammar": grammar}),
                      ("free(no constraint)", {})]:
    t0 = time.time()
    r = llm.create_chat_completion(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3, max_tokens=1200, **kwargs)
    dt = time.time() - t0
    content = r["choices"][0]["message"]["content"]
    tok = r["usage"]["completion_tokens"]
    print(f"{label}: {tok} tok in {dt:.1f}s = {tok/dt:.1f} t/s, finish={r['choices'][0].get('finish_reason')}")
    try:
        j = json.loads(content)
        print(f"  VALID JSON, sentences: {len(j.get('sentences', []))}")
    except Exception as e:
        print(f"  INVALID: {str(e)[:80]}")
    if label.startswith("constrained"):
        json.dump({"sentences": j["sentences"]}, open(r"F:\my_ai\aidulc\.spikes\out\quality_grammar.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
