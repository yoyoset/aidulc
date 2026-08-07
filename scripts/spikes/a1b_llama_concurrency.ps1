param(
    [int]$Port = 8090,
    [int]$Np = 8,
    [int]$Concurrency = 8,
    [int]$PerWorker = 3,
    [string]$Model = "F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
)
$ErrorActionPreference = "Stop"
$llama = "F:\my_ai\subgen\dist\translator\llama-server.exe"
$log = "F:\my_ai\aidulc\.spikes\tmp\llama_conc$Concurrency.log"
$health = "http://127.0.0.1:$Port/health"

$proc = Start-Process -FilePath $llama -ArgumentList @("-m", $Model, "-ngl", "99", "-np", $Np, "--port", "$Port", "-c", "8192", "--no-warmup") -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw "not ready"; Get-Content $log -Tail 20 }
    Write-Output "READY (np=$Np conc=$Concurrency)"

    $body = @{
        model = "qwen3"
        messages = @(@{ role = "user"; content = "Translate this English sentence into natural Chinese. Output ONLY the translation, no explanation. Sentence: 'The committee finally reached an agreement after hours of heated discussion.'" })
        temperature = 0.3
    } | ConvertTo-Json -Depth 5

    $jobs = @()
    $swAll = [System.Diagnostics.Stopwatch]::StartNew()
    for ($w = 0; $w -lt $Concurrency; $w++) {
        $jobs += Start-Job -ScriptBlock {
            param($u, $b)
            $r = Invoke-RestMethod -Uri $u -Method Post -ContentType "application/json" -Body $b -TimeoutSec 600
            [pscustomobject]@{ prompt = $r.usage.prompt_tokens; completion = $r.usage.completion_tokens; ok = $true }
        } -ArgumentList "http://127.0.0.1:$Port/v1/chat/completions", $body
    }
    $results = $jobs | Wait-Job | Receive-Job
    $swAll.Stop()
    $jobs | Remove-Job -Force
    $totalOut = 0; $totalIn = 0; $errs = 0
    foreach ($res in $results) {
        if ($null -eq $res -or -not $res.ok) { $errs++; continue }
        $totalOut += $res.completion
        $totalIn += $res.prompt
    }
    $secs = $swAll.Elapsed.TotalSeconds
    Write-Output "RESULT: concurrency=$Concurrency total_prompt=$totalIn total_completion=$totalOut wall_secs=$([math]::Round($secs,1)) aggregate_tps=$([math]::Round($totalOut/$secs,1)) errors=$errs"
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Write-Output "server stopped"
}
