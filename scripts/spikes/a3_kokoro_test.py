import os, time, numpy as np
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
from kokoro_onnx import Kokoro

tmp = r"F:\my_ai\aidulc\.spikes\tmp"
print("loading kokoro...")
t0 = time.time()
kokoro = Kokoro(model_path=os.path.join(tmp, "kokoro-v1.0.onnx"), voices_path=os.path.join(tmp, "voices-v1.0.bin"))
print(f"loaded in {time.time()-t0:.1f}s")
print("voices:", list(kokoro.get_voices())[:8])

text = "The quick brown fox jumps over the lazy dog."
t0 = time.time()
samples, sr = kokoro.create(text, voice="af_heart", speed=1.0)
dt = time.time() - t0
dur = len(samples) / sr
print(f"TTS: {dur:.2f}s audio for {len(text)} chars in {dt:.2f}s wall (realtime x{dur/dt:.1f}), sr={sr}")

import soundfile as sf
sf.write(os.path.join(tmp, "kokoro_test.wav"), samples, sr)
print("wrote kokoro_test.wav")

# speed test on a longer sentence
long_text = "The committee finally reached an agreement after hours of heated discussion, and everyone seemed relieved that the matter was settled at last."
t0 = time.time()
samples2, _ = kokoro.create(long_text, voice="af_heart", speed=1.0)
dt = time.time() - t0
dur2 = len(samples2) / sr
print(f"long TTS: {dur2:.2f}s audio in {dt:.2f}s (realtime x{dur2/dt:.1f})")

# phoneme timing: phonemize to see granularity
phonemes = kokoro.tokenizer.phonemize(long_text, "en-us")
print("phonemes:", phonemes)
