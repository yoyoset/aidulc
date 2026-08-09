# 部署手机 PWA 到 Cloudflare Pages (V7, P0 更新机制 2026-08-10)
#
# P0 防呆: SW 更新检查只比 sw.js 字节。若本次发布没 bump BUILD_VERSION, sw.js 字节
# 不变 → 已装用户永远拿旧壳。本脚本强制版本递增:
#   1. 读 sw.js 里的 BUILD_VERSION 与 build-info.js 里的版本, 两处必须一致
#   2. 与 .last-deployed-version (脚本同目录标记文件) 比, 相同则拒绝部署
#      ("先 bump 版本再部署")
#   3. 通过后 wrangler pages deploy, 并把版本写入标记文件
param(
    [string]$ProjectName = "aidulc-mobile",
    [string]$Branch = "main"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mobile = "$root\cloud\mobile"
$marker = "$mobile\.last-deployed-version"
Set-Location $mobile

# 1. 校验两处版本一致
$sw = Get-Content "$mobile\sw.js" -Raw
if ($sw -notmatch "const BUILD_VERSION = '([^']+)'") {
    Write-Error "sw.js 里找不到 const BUILD_VERSION (字面量必须嵌入 sw.js, SW 更新检查只比字节)"
}
$swVer = $Matches[1]
$bi = Get-Content "$mobile\build-info.js" -Raw
if ($bi -notmatch "AIDULC_BUILD_VERSION = '([^']+)'") {
    Write-Error "build-info.js 里找不到 AIDULC_BUILD_VERSION"
}
$biVer = $Matches[1]
if ($swVer -ne $biVer) {
    Write-Error "版本不一致: sw.js=$swVer build-info.js=$biVer (两处必须同步)"
}
Write-Host "构建版本: $swVer"

# 2. 与上次部署比, 相同则拒绝
$last = ""
if (Test-Path $marker) { $last = (Get-Content $marker -Raw).Trim() }
if ($swVer -eq $last) {
    Write-Error "版本 $swVer 已部署过 (.last-deployed-version=$last)。`n先 bump cloud/mobile/sw.js 和 build-info.js 的 BUILD_VERSION 再部署 —— 否则 SW 字节不变, 已装用户永远拿旧壳。"
}

# 3. 部署
wrangler pages deploy . --project-name $ProjectName --branch $Branch
if ($LASTEXITCODE -ne 0) {
    Write-Error "wrangler pages deploy 失败 (exit $LASTEXITCODE)"
}

# 4. 记录已部署版本
Set-Content -Path $marker -Value $swVer -Encoding UTF8 -NoNewline
Write-Host "部署完成, 记录版本 $swVer"
