import os, sys, time
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama

MODEL = r"F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
print("loading model...")
t0 = time.time()
llm = Llama(model_path=MODEL, n_gpu_layers=99, n_ctx=16384, n_threads=8, verbose=False)
print(f"loaded in {time.time()-t0:.1f}s, gpu_layers used")

def bench(n=5):
    tt = []
    for i in range(n):
        t0 = time.time()
        r = llm.create_chat_completion(
            messages=[{"role": "user", "content": "Translate this English sentence into natural Chinese. Output ONLY the translation, no explanation. Sentence: 'The committee finally reached an agreement after hours of heated discussion.'"}],
            temperature=0.3, max_tokens=64,
        )
        dt = time.time() - t0
        tok = r["usage"]["completion_tokens"]
        tt.append(tok / dt)
        print(f"run{i+1}: {tok} tok in {dt:.2f}s -> {tok/dt:.1f} t/s")
    print(f"AVG: {sum(tt)/len(tt):.1f} t/s")

bench(5)

# json_schema constrained decode test
schema = {
    "type": "object",
    "properties": {
        "translation": {"type": "string"},
        "explanation": {"type": "string"},
    },
    "required": ["translation", "explanation"],
}
t0 = time.time()
r = llm.create_chat_completion(
    messages=[{"role": "user", "content": "Translate to Chinese and explain briefly: 'He broke the news to her carefully.' Return JSON."}],
    temperature=0.3, max_tokens=128,
    response_format={"type": "json_schema", "json_schema": {"name": "explain", "schema": schema}},
)
dt = time.time() - t0
content = r["choices"][0]["message"]["content"]
print(f"json_schema: {r['usage']['completion_tokens']} tok in {dt:.2f}s")
print("content:", content)
