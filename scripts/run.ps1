# 构建并启动 aidulc.exe (R0, 2026-08-07)。
#
# 存在原因: 前端资源在编译期经 generate_context! 嵌进二进制, 只跑
# target/release/aidulc.exe 很可能还是旧界面(缺 cargo build 那一步)。本脚本
# 把"先构建再启动"焊成一步, 避免手工再跑到旧二进制。
param(
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $NoBuild) {
    Push-Location "$root\src-tauri"
    cargo build --release -p aidulc
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Error "构建失败 (exit $LASTEXITCODE)"
        exit 1
    }
    Pop-Location
}

$exe = "$root\src-tauri\target\release\aidulc.exe"
if (-not (Test-Path $exe)) {
    Write-Error "找不到 $exe (先跑 scripts\build.ps1 或去掉 -NoBuild)"
    exit 1
}
Write-Output "启动 $exe"
& $exe
exit $LASTEXITCODE
