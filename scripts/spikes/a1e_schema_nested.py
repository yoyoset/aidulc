import os, time, json
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama

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

r = llm.create_chat_completion(
    messages=[{"role": "user", "content": "Translate and explain this sentence: 'The quick brown fox jumps over the lazy dog.'"}],
    temperature=0.3, max_tokens=200,
    response_format={"type": "json_schema", "json_schema": {"name": "explain", "schema": schema}},
)
content = r["choices"][0]["message"]["content"]
print("content:", repr(content))
try:
    j = json.loads(content)
    print("VALID JSON, sentences:", len(j.get("sentences", [])))
except Exception as e:
    print("INVALID:", e)
