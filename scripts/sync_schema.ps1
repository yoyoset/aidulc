# contracts/ <-> prep/aidulc_prep/schemas/ 的唯一同步/校验入口。
#
# 默认(无参数): 从 contracts/ 拷贝到 prep/schemas/(打包时 schema 随侧车走)。
# -Verify: 不拷贝, 只比对两边内容是否一致, 不一致则退出码非0(供 check.ps1 门禁调用)。
#   这条存在的原因: 此前只有拷贝脚本, 改了 contracts/ 忘记手动跑一次不会有任何报错,
#   侧车会静默拿旧 schema 校验 —— 这是 R3(契约漂移)防线的真实缺口, 补上校验而非只补拷贝。
param(
    [string]$Contracts = "F:\my_ai\aidulc\contracts",
    [string]$Out = "F:\my_ai\aidulc\prep\aidulc_prep\schemas",
    [switch]$Verify
)

$files = @("bookpack.schema.json", "job_request.schema.json", "progress.schema.json")

if ($Verify) {
    $mismatch = $false
    foreach ($f in $files) {
        $src = Join-Path $Contracts $f
        $dst = Join-Path $Out $f
        if (-not (Test-Path $dst)) {
            Write-Error "缺失: $dst (contracts/ 有 $f 但 prep/schemas/ 没有 -- 运行 scripts\sync_schema.ps1 同步)"
            $mismatch = $true
            continue
        }
        $srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash $dst -Algorithm SHA256).Hash
        if ($srcHash -ne $dstHash) {
            Write-Error "漂移: $f 在 contracts/ 与 prep/schemas/ 内容不一致 -- 运行 scripts\sync_schema.ps1 同步"
            $mismatch = $true
        }
    }
    if ($mismatch) {
        exit 1
    }
    Write-Output "schema 校验通过: contracts/ 与 prep/schemas/ 一致"
    exit 0
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($f in $files) {
    Copy-Item (Join-Path $Contracts $f) (Join-Path $Out $f) -Force
}
Write-Output "schemas synced -> $Out"
