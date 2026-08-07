param(
    [int]$Port = 8091,
    [int]$Np = 8,
    [int]$Concurrency = 8,
    [int]$PerWorker = 4,
    [int]$PromptLen = 200,
    [string]$Model = "F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
)
$ErrorActionPreference = "Stop"
$llama = "F:\my_ai\subgen\dist\translator\llama-server.exe"
$log = "F:\my_ai\aidulc\.spikes\tmp\llama_stress.log"
$health = "http://127.0.0.1:$Port/health"

$proc = Start-Process -FilePath $llama -ArgumentList @("-m", $Model, "-ngl", "99", "-np", $Np, "--port", "$Port", "-c", "8192", "--no-warmup") -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw "not ready" }
    Write-Output "READY (np=$Np conc=$Concurrency per=$PerWorker promptlen=$PromptLen)"

    $samples = 1..$PromptLen | ForEach-Object { "The quick brown fox jumps over the lazy dog number $_." }
    $sampleText = $samples -join " "
    $body = @{
        model = "qwen3"
        messages = @(@{ role = "user"; content = "Translate the following English text into Chinese:\n$sampleText" })
        temperature = 0.3
    } | ConvertTo-Json -Depth 5

    $jobScript = {
        param($u, $b, $n)
        $out = @()
        for ($k = 0; $k -lt $n; $k++) {
            try {
                $r = Invoke-RestMethod -Uri $u -Method Post -ContentType "application/json" -Body $b -TimeoutSec 900
                $out += [pscustomobject]@{ prompt = $r.usage.prompt_tokens; completion = $r.usage.completion_tokens; ok = $true }
            } catch { $out += [pscustomobject]@{ prompt = 0; completion = 0; ok = $false } }
        }
        $out
    }

    $jobs = @()
    $swAll = [System.Diagnostics.Stopwatch]::StartNew()
    for ($w = 0; $w -lt $Concurrency; $w++) {
        $jobs += Start-Job -ScriptBlock $jobScript -ArgumentList "http://127.0.0.1:$Port/v1/chat/completions", $body, $PerWorker
    }
    $results = $jobs | Wait-Job | Receive-Job
    $swAll.Stop()
    $jobs | Remove-Job -Force

    $totalOut = 0; $totalIn = 0; $errs = 0
    foreach ($res in $results) {
        if ($null -eq $res) { $errs++; continue }
        foreach ($r in $res) {
            if ($r.ok) { $totalOut += $r.completion; $totalIn += $r.prompt } else { $errs++ }
        }
    }
    $secs = $swAll.Elapsed.TotalSeconds
    Write-Output "RESULT: requests=$($Concurrency*$PerWorker) total_prompt=$totalIn total_completion=$totalOut wall_secs=$([math]::Round($secs,1)) aggregate_tps=$([math]::Round($totalOut/$secs,1)) errors=$errs"
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Write-Output "server stopped"
}
