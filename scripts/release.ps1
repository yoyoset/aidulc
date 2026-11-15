# scripts/release.ps1 —— 发版: 门禁 -> 版本号 -> CHANGELOG -> 构建 -> 便携包 -> 提交 + tag
# (2026-11-15, 评估方案 D2。UTF-8 BOM, 否则 PowerShell 5.1 会把中文注释解析错乱)
#
# 用法 (仓库根目录):
#   .\scripts\release.ps1 -Version 0.2.0            # 只做前置检查并打印计划, 什么都不改
#   .\scripts\release.ps1 -Version 0.2.0 -Apply     # 真正执行
#   .\scripts\release.ps1 -Version 0.2.0 -Apply -SkipSidecar   # 侧车自上次打包后没变时跳过 (约省 10 分钟)
#
# 前置检查 (任何一条不满足都会拒绝执行, 不是警告):
#   1. 版本号格式 x.y.z, 且 tag vX.Y.Z 还不存在
#   2. 要改的文件 (Cargo.toml / tauri.conf.json / Cargo.lock / CHANGELOG.md) 没有未提交改动
#   3. docs/SMOKE_NEW_USER.md 的「走查记录」里有这个版本的一节 (发版前必须有人走过新用户清单)
# 不做: 不 push (最后只打印命令, 推不推由你定); 不删 dist 里的 .old 残留 (只提示)。
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$Apply,
    [switch]$SkipSidecar
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$tag = "v$Version"
$problems = @()

# ---- 前置检查 ----
if ($Version -notmatch '^\d+\.\d+\.\d+$') { $problems += "版本号必须是 x.y.z 格式, 收到: $Version" }
if (git tag --list $tag) { $problems += "tag $tag 已存在" }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { $problems += "当前分支是 $branch, 发版必须在 main 上" }

$touch = @("src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/Cargo.lock", "CHANGELOG.md")
$dirty = git status --porcelain -- $touch
if ($dirty) { $problems += "要修改的文件有未提交改动, 先提交或还原:`n$($dirty -join "`n")" }

$smoke = Get-Content "docs/SMOKE_NEW_USER.md" -Raw -Encoding UTF8
if ($smoke -notmatch "(?m)^### \d{4}-\d{2}-\d{2} v$([regex]::Escape($Version))\b") {
    $problems += "docs/SMOKE_NEW_USER.md 的「走查记录」里没有 v$Version 的一节 —— 发版前要有人在真实窗口里走完新用户清单并记录"
}

Write-Host "== 发版计划: $tag ==" -ForegroundColor Cyan
Write-Host "  1. scripts\check.ps1 全量门禁"
Write-Host "  2. 版本号 -> $Version (Cargo.toml / tauri.conf.json; Cargo.lock 随构建更新)"
Write-Host "  3. CHANGELOG: [Unreleased] 下新增 [$Version] 小节"
Write-Host ("  4. cargo build --release" + $(if ($SkipSidecar) { "; 侧车: 跳过" } else { "; 侧车: scripts\build_prep.ps1 (约 10 分钟)" }))
Write-Host "  5. 组装 dist\aidulc-portable (exe + prep\)"
Write-Host "  6. 提交 'release: $tag' 并打 tag (不 push)"

if ($problems.Count -gt 0) {
    Write-Host "`n前置检查未通过:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
if (-not $Apply) {
    Write-Host "`n前置检查全部通过。加 -Apply 真正执行。" -ForegroundColor Green
    exit 0
}

function Step($name, [scriptblock]$body) {
    Write-Host "`n>>> $name" -ForegroundColor Cyan
    & $body
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Write-Host "$name 失败 (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

# 保持原文件的换行风格改写
function Edit-File($path, [scriptblock]$transform) {
    $raw = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
    $new = & $transform $raw
    if ($new -eq $raw) { throw "$path 没有发生任何变化 (正则没匹配上?)" }
    [System.IO.File]::WriteAllText($path, $new, [System.Text.UTF8Encoding]::new($false))
}

Step "全量门禁" { & "$root\scripts\check.ps1" }

Step "改版本号" {
    Edit-File "src-tauri/Cargo.toml" { param($t) [regex]::Replace($t, '(?m)^version = "[^"]+"', "version = `"$Version`"", 1) }
    Edit-File "src-tauri/tauri.conf.json" { param($t) [regex]::Replace($t, '("version"\s*:\s*)"[^"]+"', "`$1`"$Version`"", 1) }
}

Step "切 CHANGELOG" {
    $date = Get-Date -Format "yyyy-MM-dd"
    Edit-File "CHANGELOG.md" { param($t)
        $nl = if ($t.Contains("`r`n")) { "`r`n" } else { "`n" }
        # 注意: .NET Framework 的 String.Replace 没有 StringComparison 重载 (PS 5.1 实测报错), 用 Regex
        [regex]::new([regex]::Escape("## [Unreleased]$nl")).Replace($t, "## [Unreleased]$nl$nl## [$Version] - $date$nl", 1)
    }
}

Step "cargo build --release (同时更新 Cargo.lock 里的版本)" {
    Push-Location "$root\src-tauri"; cargo build --release -p aidulc; $c = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $c
}

if (-not $SkipSidecar) {
    Step "重建侧车" { & "$root\scripts\build_prep.ps1" }
}

Step "组装便携包" {
    $pt = "$root\dist\aidulc-portable"
    New-Item -ItemType Directory -Force "$pt\prep" | Out-Null
    Copy-Item "$root\src-tauri\target\release\aidulc.exe" "$pt\aidulc.exe" -Force
    $src = "$root\prep\dist\aidulc-prep"
    if (-not (Test-Path "$src\aidulc-prep.exe")) { throw "找不到侧车产物 $src (没跳过侧车的话 build_prep 应该已生成)" }
    if (Test-Path "$pt\prep\_internal") { Remove-Item "$pt\prep\_internal" -Recurse -Force }
    Copy-Item "$src\_internal" "$pt\prep\_internal" -Recurse -Force
    Copy-Item "$src\aidulc-prep.exe" "$pt\prep\aidulc-prep.exe" -Force
    $v = (Get-Item "$pt\aidulc.exe").VersionInfo.ProductVersion
    if ($v -ne $Version) { throw "便携包里 aidulc.exe 的版本号是 $v, 期望 $Version" }
    Write-Host "  便携包 exe 版本 $v ✓"
    $olds = Get-ChildItem $pt -Recurse -Force | Where-Object { $_.Name -like "*.old" }
    if ($olds) { Write-Host "  提示: 便携包里有 .old 残留 (体积冗余, 发给别人前手动删):`n    $($olds.FullName -join "`n    ")" -ForegroundColor Yellow }
}

Step "提交并打 tag" {
    git add src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
    git commit -m "release: $tag" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
    git tag -a $tag -m "aidulc $tag"
}

Write-Host "`n发版完成 (本地)。要推送请自己执行:" -ForegroundColor Green
Write-Host "  git push origin main; git push origin $tag"
