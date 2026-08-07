import os, time
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
import torch
from phonemizer.backend.espeak.wrapper import EspeakWrapper
import espeakng_loader
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

from kokoro import KPipeline

HF = r"F:\hf_cache"
SNAP = os.path.join(HF, r"models--hexgrad--Kokoro-82M\snapshots\f3ff3571791e39611d31c381e3a41a3af07b4987")
MODEL = os.path.join(SNAP, "kokoro-v1_0.pth")
CONFIG = os.path.join(SNAP, "config.json")

print("device:", "cuda" if torch.cuda.is_available() else "cpu")
t0 = time.time()
pipe = KPipeline(lang_code="a", model=True, device="cuda")
pipe.model = __import__("kokoro.model", fromlist=["KModel"]).KModel(config=CONFIG, model=MODEL).to("cuda").eval()
print(f"loaded in {time.time()-t0:.1f}s")

text = "The quick brown fox jumps over the lazy dog."
t0 = time.time()
total = 0
for i, res in enumerate(pipe(text, voice="af_heart", speed=1.0)):
    out = res.output
    dur = len(out.audio) / 24000
    total += dur
    dt = time.time() - t0
    print(f"chunk{i}: audio {dur:.2f}s in {dt:.2f}s (realtime x{dur/dt:.1f})")
    print(f"  tokens with timestamps:")
    for t in res.tokens:
        ws = "'" if t.whitespace else ""
        print(f"    {t.text!r}{ws}: start={t.start_ts:.3f} end={t.end_ts:.3f} dur={t.end_ts-t.start_ts:.3f}s")
    t0 = time.time()
print(f"total audio: {total:.2f}s")

# speed test with realtime calc
print("\n--- speed test on longer sentence ---")
long_text = "The committee finally reached an agreement after hours of heated discussion, and everyone seemed relieved that the matter was settled at last."
t0 = time.time()
for i, res in enumerate(pipe(long_text, voice="af_heart", speed=1.0)):
    dur = len(res.output.audio) / 24000
    dt = time.time() - t0
    print(f"chunk{i}: {dur:.2f}s audio in {dt:.2f}s (realtime x{dur/dt:.1f})")
    t0 = time.time()
