# prep/setup.ps1 —— 建侧车 venv 并按锁文件装回同一套依赖 (2026-11-15 改: 此前只装 pytest)
#
# 用法 (在 prep 目录): .\setup.ps1
# 装的是 requirements.lock 里的精确版本。两个已知的人工环节见该文件头注释:
#   1. torch 是 CUDA 构建, 锁文件里已带 PyTorch 官方索引 (--extra-index-url)。
#   2. llama_cpp_python 的 CUDA 构建来源没法从元数据确认 —— 装完先跑下面的自检,
#      `llama_cpp` 导入失败或只有 CPU 时, 查 requirements.lock 头注释的说明。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.lock
if ($LASTEXITCODE -ne 0) { Write-Host "依赖安装失败, 见上方 pip 输出" -ForegroundColor Red; exit 1 }

# 自检: 三方一致 + 测试能跑
$env:PYTHONIOENCODING = "utf-8"
& .\.venv\Scripts\python.exe ..\scripts\check_venv_lock.py
if ($LASTEXITCODE -ne 0) { exit 1 }
& .\.venv\Scripts\python.exe -m pytest tests -q
