# 聚合门禁, 对标 aidu 的 `npm run check`。一条命令串起本项目全部质量检查,
# 任一项失败则整体非零退出(供人工/未来 CI 调用), 结尾打印每项 PASS/FAIL 摘要。
#
# clippy 的"参数过多/类型复杂"警告(结构性问题, 集中在 jobs.rs 等命令层, 详见
# S2 架构收口计划)当前有 8 处已知存量, 用 $ClippyBaseline 放行存量、禁止新增
# ——警告数超过基线才判失败; 等 S2 拆分 jobs.rs 把这些真正修掉后, 把这个数字
# 调低, 不要调高。
param(
    [int]$ClippyBaseline = 8
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$results = @()

function Run-Check {
    param([string]$Name, [scriptblock]$Action)
    Write-Output ""
    Write-Output "=== $Name ==="
    & $Action
    $ok = ($LASTEXITCODE -eq 0) -or ($null -eq $LASTEXITCODE)
    $script:results += [PSCustomObject]@{ Name = $Name; Pass = $ok }
    if (-not $ok) {
        Write-Output "--- $Name 失败 (exit $LASTEXITCODE) ---"
    }
}

# 1. schema 一致性 (contracts/ <-> prep/aidulc_prep/schemas/)
Run-Check "schema:verify" {
    & "$root\scripts\sync_schema.ps1" -Verify
}

# 2. Rust 格式
Run-Check "cargo fmt --check" {
    Push-Location "$root\src-tauri"
    cargo fmt --check
    Pop-Location
}

# 3. Rust clippy (基线放行存量, 禁止新增)
Run-Check "cargo clippy (baseline<=$ClippyBaseline)" {
    Push-Location "$root\src-tauri"
    $output = cargo clippy --release -p aidulc 2>&1 | Out-String
    Write-Output $output
    $count = ([regex]::Matches($output, '(?m)^warning:')).Count
    Pop-Location
    Write-Output "clippy 警告数: $count (基线: $ClippyBaseline)"
    if ($count -gt $ClippyBaseline) {
        Write-Output "超过基线, 说明引入了新警告 —— 请修复新增项, 不要调高 -ClippyBaseline 绕过"
        $global:LASTEXITCODE = 1
    } else {
        $global:LASTEXITCODE = 0
    }
}

# 4. Rust 测试 (必须单线程, 见 memory/pipeline.md: 并行有共享临时 DB 状态冲突)
Run-Check "cargo test --release -- --test-threads=1" {
    Push-Location "$root\src-tauri"
    cargo test --release -p aidulc -- --test-threads=1
    Pop-Location
}

# 5. Python 测试
Run-Check "pytest" {
    & "$root\prep\.venv\Scripts\python.exe" -m pytest "$root\prep\tests" -q
}

# 6. 前端测试
Run-Check "vitest" {
    Push-Location "$root\reader"
    npx vitest run
    Pop-Location
}

Write-Output ""
Write-Output "=================================="
Write-Output "汇总"
Write-Output "=================================="
$allPass = $true
foreach ($r in $results) {
    $mark = if ($r.Pass) { "PASS" } else { "FAIL"; $allPass = $false }
    Write-Output ("{0,-40} {1}" -f $r.Name, $mark)
}
Write-Output "=================================="

if ($allPass) {
    Write-Output "全部通过"
    exit 0
} else {
    Write-Output "存在失败项, 见上方明细"
    exit 1
}
