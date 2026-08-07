import os, time
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
import torch
from kokoro.model import KModel
from kokoro.pipeline import KPipeline

MODEL = r"F:\hf_cache\models--hexgrad--Kokoro-82M\snapshots\f3ff3571791e39611d31c381e3a41a3af07b4987\kokoro-v1_0.pth"
device = "cuda" if torch.cuda.is_available() else "cpu"
print("device:", device)
model = KModel(model=MODEL, config={"version": "1.0"})
model.to(device)
pipe = KPipeline(lang_code="a", model=model, device=device)

text = "The quick brown fox jumps over the lazy dog."
t0 = time.time()
for i, (gs, ps, audio) in enumerate(pipe(text, voice="af_heart", speed=1.0, split_pattern=r"\s+")):
    dt = time.time() - t0
    dur = len(audio) / 24000
    print(f"chunk{i}: audio {dur:.2f}s generated in {dt:.2f}s (realtime x{dur/dt:.1f}), ps={ps[:80]!r}")
    t0 = time.time()

# Direct forward to inspect dur output
print("--- direct forward ---")
