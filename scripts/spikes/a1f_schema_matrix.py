import os, time, json
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama

llm = Llama(model_path=r"F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf", n_gpu_layers=99, n_ctx=16384, verbose=False)

schemas = {
    "array_of_strings": {
        "type": "array",
        "items": {"type": "string"},
    },
    "object_flat": {
        "type": "object",
        "properties": {"translation": {"type": "string"}, "explanation": {"type": "string"}},
        "required": ["translation", "explanation"],
    },
    "array_of_objects_flat": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {"translation": {"type": "string"}, "explanation": {"type": "string"}},
            "required": ["translation", "explanation"],
        },
    },
    "object_with_array": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {"type": "string"},
            }
        },
        "required": ["items"],
    },
}

for name, schema in schemas.items():
    r = llm.create_chat_completion(
        messages=[{"role": "user", "content": "Translate 'The quick brown fox jumps over the lazy dog.' to Chinese and briefly explain it in Chinese. Return JSON."}],
        temperature=0.3, max_tokens=150,
        response_format={"type": "json_schema", "json_schema": {"name": "test", "schema": schema}},
    )
    content = r["choices"][0]["message"]["content"]
    try:
        json.loads(content)
        ok = "VALID"
    except Exception as e:
        ok = f"INVALID: {str(e)[:60]}"
    print(f"=== {name}: {ok}")
    print("  ", repr(content[:150]))
    print()
