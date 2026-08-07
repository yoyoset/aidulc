import os, time, json, re
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib")
os.add_dll_directory(r"F:\my_ai\comic-gen\.venv\Lib\site-packages\llama_cpp\lib")
from llama_cpp import Llama

MODEL = r"F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
SRC = r"F:\my_ai\aidulc\.spikes\fixtures\alice.txt"
OUT = r"F:\my_ai\aidulc\.spikes\out\quality_sample_v2.json"

text = open(SRC, encoding="utf-8").read()
start = text.find("CHAPTER I")
start = text.find("\n", start) + 1
chunk = text[start:start+30000]

def clean_json(content):
    c = content.strip()
    c = re.sub(r"^```(?:json)?\s*", "", c)
    c = re.sub(r"\s*```$", "", c)
    try:
        return json.loads(c), True
    except Exception:
        # try to fix truncated: find last complete }
        depth = 0
        for i, ch in enumerate(c):
            if ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(c[:i+1]), True
                    except Exception:
                        return None, False
        return None, False

llm = Llama(model_path=MODEL, n_gpu_layers=99, n_ctx=16384, verbose=False)
print("llm loaded")

# real sentences (no chapter headers) via spaCy-free manual list from earlier run
sentences = [
    "There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, Oh dear!",
    "In another moment down went Alice after it, never once considering how in the world she was to get out again.",
    "Either the well was very deep, or she fell very slowly, for she had plenty of time as she went down to look about her and to wonder what was going to happen next.",
    "Well! thought Alice to herself, after such a fall as this, I shall think nothing of tumbling down stairs!",
    "How brave they will all think me at home!",
    "Why, I would not say anything about it, even if I fell off the top of the house!",
    "Would the fall never come to an end?",
    "I wonder how many miles I have fallen by this time?",
    "I must be getting somewhere near the centre of the earth.",
    "I wonder if I shall fall right through the earth!",
    "Curiouser and curiouser!",
    "Now, Dinah, tell me the truth: did you ever eat a bat?",
    "It was all very well to say Drink me, but the wise little Alice was not going to do that in a hurry.",
    "This bottle was not marked poison, so Alice ventured to taste it.",
    "She took down a jar from one of the shelves as she passed; it was labelled ORANGE MARMALADE.",
    "The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down, so suddenly that Alice had not a moment to think about stopping herself before she found herself falling down a very deep well.",
    "First, she tried to look down and make out what she was coming to, but it was too dark to see anything.",
    "Down, down, down. Would the fall never come to an end?",
    "She generally gave herself very good advice, though she very seldom followed it.",
    "And she tried to fancy what the flame of a candle is like after the candle is blown out.",
]

results = []
t0all = time.time()
for i, s in enumerate(sentences):
    prompt = ("你是英语老师的讲解助手。把下面的英语句子翻译成中文，并给出针对英语学习者的简明中文讲解（1-2句，点出语法点、固定搭配或难词）。"
              f"只输出 JSON：{{\"sentences\":[{{\"original_text\":\"原文\",\"translation\":\"中文翻译\",\"explanation\":\"中文讲解\"}}]}}\n\n句子: {s}")
    t0 = time.time()
    r = llm.create_chat_completion(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3, max_tokens=250)
    dt = time.time() - t0
    content = r["choices"][0]["message"]["content"]
    parsed, ok = clean_json(content)
    if ok and parsed.get("sentences"):
        item = parsed["sentences"][0]
        results.append({"sentence": s, "translation": item.get("translation", ""), "explanation": item.get("explanation", ""), "ok": True, "secs": round(dt, 1)})
        print(f"[{i+1}/20] OK {dt:.1f}s")
    else:
        results.append({"sentence": s, "raw": content[:200], "ok": False, "secs": round(dt, 1)})
        print(f"[{i+1}/20] FAIL {dt:.1f}s: {content[:80]}")

total = time.time() - t0all
json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
nok = sum(1 for x in results if x["ok"])
print(f"\n{OUT}: {nok}/20 ok in {total:.0f}s ({total/20:.1f}s/句 avg, {20/total*60:.0f} 句/分)")
