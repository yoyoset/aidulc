# 打包 prep 侧车 (PyInstaller onedir, 就地换件不碰用户数据)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location "$root\prep"

$dist_dir = "dist\aidulc-prep"
$stage_out = "build\stage\aidulc-prep"

if (Get-Process -Name "aidulc-prep" -ErrorAction SilentlyContinue) {
    Write-Host "aidulc-prep is running, close it first." -ForegroundColor Red
    exit 1
}

Write-Host "Building to staging dir..." -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m PyInstaller build_exe.spec --noconfirm --clean `
    --distpath "build\stage" --workpath "build\work"
if ($LASTEXITCODE -ne 0) { Write-Host "PyInstaller build failed" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $dist_dir)) {
    New-Item -ItemType Directory -Path (Split-Path $dist_dir) -Force | Out-Null
    Move-Item $stage_out $dist_dir
} else {
    if (Test-Path "$dist_dir\_internal") { Remove-Item "$dist_dir\_internal" -Recurse -Force }
    Move-Item "$stage_out\_internal" "$dist_dir\_internal"
    Move-Item "$stage_out\aidulc-prep.exe" "$dist_dir\aidulc-prep.exe" -Force
}
Remove-Item "build\stage" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Done: $dist_dir\aidulc-prep.exe" -ForegroundColor Green
