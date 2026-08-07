# prep/build_exe.spec —— PyInstaller onedir 构建 (照抄 comic-gen 的就地换件模式)
# 产物: dist/aidulc-prep/aidulc-prep.exe + _internal/
# 注意: 侧车运行时依赖外部二进制 (ffmpeg) 和模型 (共享池), 不打包进 _internal。

from PyInstaller.utils.hooks import collect_all
import os

# spaCy 模型是数据包, 必须 collect_all 才能带进 _internal
datas, binaries, hiddenimports = [], [], []
for pkg in [
    "en_core_web_sm",
    "llama_cpp",
    "misaki",
    "phonemizer",
    "language_tags",
    "espeakng_loader",
    "kokoro",
]:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# CUDA runtime (ggml-cuda.dll 依赖): 打包进 _internal/cuda_runtime
# 来源: comic-gen venv torch/lib (与 llama.cpp CUDA build 匹配的 CUDA 12.4)
import glob as _glob

_cuda_src = r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib"
_cuda_dlls = [
    os.path.join(_cuda_src, n)
    for n in ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll", "cufft64_11.dll", "nvrtc-builtins64_124.dll"]
]
_cuda_datas = [(d, "cuda_runtime") for d in _cuda_dlls if os.path.exists(d)]

a = Analysis(
    ["aidulc_prep/cli.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas + [
        ("aidulc_prep/schemas", "aidulc_prep/schemas"),
    ] + _cuda_datas,
    hiddenimports=[
        "spacy",
        "en_core_web_sm",
        "kokoro",
        "misaki",
        "espeakng_loader",
        "soundfile",
        "phonemizer",
        "llama_cpp",
    ] + hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="aidulc-prep",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="aidulc-prep",
)
