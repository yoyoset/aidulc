import os, time, json, re
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama
import spacy

MODEL = r"F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
SRC = r"F:\my_ai\aidulc\.spikes\fixtures\alice.txt"
OUT = r"F:\my_ai\aidulc\.spikes\out\quality_sample.json"

os.makedirs(os.path.dirname(OUT), exist_ok=True)
text = open(SRC, encoding="utf-8").read()
# take chapter 1 region
start = text.find("CHAPTER I")
start = text.find("\n", start) + 1
chunk = text[start:start+40000]
# strip Gutenberg header artifacts
sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", chunk) if 20 < len(s.strip()) < 200]
sentences = [s for s in sentences if not s.startswith("Project Gutenberg")]
print(f"candidate sentences: {len(sentences)}")
sentences = sentences[:20]
print(f"using 20 sentences")

nlp = spacy.load("en_core_web_sm")

llm = Llama(model_path=MODEL, n_gpu_layers=99, n_ctx=16384, verbose=False)
print("llm loaded")

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

results = []
t0all = time.time()
for i, s in enumerate(sentences):
    doc = nlp(s)
    segments = [[t.text, t.tag_, t.lemma_] for t in doc]
    t0 = time.time()
    r = llm.create_chat_completion(
        messages=[{
            "role": "user",
            "content": (
                "你是小学英语老师的讲解助手。对下面的英语句子输出：中文翻译、针对英语学习者的简明讲解（用中文，1-2句，点出语法点或难词）。"
                f"\n\n句子: {s}"
            ),
        }],
        temperature=0.3, max_tokens=200,
        response_format={"type": "json_schema", "json_schema": {"name": "explain", "schema": schema}},
    )
    dt = time.time() - t0
    content = r["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(content)
        tr = parsed["sentences"][0]["translation"] if parsed.get("sentences") else ""
        ex = parsed["sentences"][0]["explanation"] if parsed.get("sentences") else ""
    except Exception as e:
        tr, ex = f"PARSE FAIL: {e}", content[:100]
    results.append({"sentence": s, "translation": tr, "explanation": ex, "secs": round(dt, 1), "tokens": r["usage"]["completion_tokens"]})
    print(f"[{i+1}/20] {dt:.1f}s: {s[:50]}...")

total = time.time() - t0all
json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"wrote {OUT} in {total:.0f}s total")
