import os, time, numpy as np
os.environ.setdefault("HF_HOME", r"F:\hf_cache")
import onnxruntime as rt
from kokoro_onnx import Kokoro

tmp = r"F:\my_ai\aidulc\.spikes\tmp"
sess = rt.InferenceSession(os.path.join(tmp, "kokoro-v1.0.onnx"), providers=["CPUExecutionProvider"])
print("inputs:")
for i in sess.get_inputs(): print(f"  {i.name} {i.shape} {i.type}")
print("outputs:")
for o in sess.get_outputs(): print(f"  {o.name} {o.shape} {o.type}")

kokoro = Kokoro(model_path=os.path.join(tmp, "kokoro-v1.0.onnx"), voices_path=os.path.join(tmp, "voices-v1.0.bin"))
phonemes = kokoro.tokenizer.phonemize("The quick brown fox jumps over the lazy dog.", "en-us")
print("phonemes:", repr(phonemes))
tokens = np.array(kokoro.tokenizer.tokenize(phonemes), dtype=np.int64)
print("tokens:", tokens)
voice = kokoro.get_voice_style("af_heart")[len(tokens)]
tokens_in = np.array([[0, *tokens, 0]])
print("input_ids shape:", tokens_in.shape, "style shape:", voice.shape)
r = sess.run(None, {"input_ids": tokens_in, "style": np.array(voice, dtype=np.float32), "speed": np.array([1], dtype=np.int32)})
print("num outputs:", len(r))
for i, o in enumerate(r):
    print(f"  out{i}: shape={o.shape} dtype={o.dtype} min={o.min():.4f} max={o.max():.4f}")
