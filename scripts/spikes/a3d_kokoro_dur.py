import os, time
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
import torch
from huggingface_hub import hf_hub_download
from phonemizer.backend.espeak.wrapper import EspeakWrapper
import espeakng_loader
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
from misaki import en, espeak

HF = r"F:\hf_cache"
MODEL = os.path.join(HF, r"models--hexgrad--Kokoro-82M\snapshots\f3ff3571791e39611d31c381e3a41a3af07b4987\kokoro-v1_0.pth")
CONFIG = os.path.join(HF, r"models--hexgrad--Kokoro-82M\snapshots\f3ff3571791e39611d31c381e3a41a3af07b4987\config.json")
VOICE = os.path.join(HF, r"models--hexgrad--Kokoro-82M\snapshots\f3ff3571791e39611d31c381e3a41a3af07b4987\voices\af_heart.pt")

print("device:", "cuda" if torch.cuda.is_available() else "cpu")
t0 = time.time()
g2p = en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))
model = __import__("kokoro.model", fromlist=["KModel"]).KModel(config=CONFIG, model=MODEL)
model.eval()
model.to("cuda" if torch.cuda.is_available() else "cpu")
print(f"model loaded in {time.time()-t0:.1f}s")

ref_s = torch.load(VOICE, map_location="cpu", weights_only=True)

text = "The quick brown fox jumps over the lazy dog."
t0 = time.time()
phonemes, _ = g2p(text)
print("phonemes:", repr(phonemes))
with torch.no_grad():
    out = model(phonemes, ref_s, speed=1.0, return_output=True)
dt = time.time() - t0
print(f"forward in {dt:.2f}s, audio len {out.audio.shape[-1]} = {out.audio.shape[-1]/24000:.2f}s")
print("pred_dur len:", out.pred_dur.shape, "sum:", out.pred_dur.sum().item())

# Map phoneme groups to words: phonemes string is space-separated phoneme symbols
groups = phonemes.strip().split()
print("phoneme groups (one per word, mostly):", len(groups))
print("first 6:", groups[:6])
print("pred_dur first 6:", out.pred_dur[:6].tolist())

# dur per group
idx = 1  # skip leading pad token
word_dur_frames = []
for g in groups:
    cnt = 0
    for ch in g:
        if ch in model.vocab:
            cnt += 1
        else:
            cnt += 0
    word_dur_frames.append(out.pred_dur[idx:idx+cnt].sum().item())
    idx += cnt
print("word durs (frames at 24000Hz):", word_dur_frames)
print("word durs (seconds):", [round(f/24000, 3) for f in word_dur_frames])
print("total audio secs:", out.audio.shape[-1]/24000)
