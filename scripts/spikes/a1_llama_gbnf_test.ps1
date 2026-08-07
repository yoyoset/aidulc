param(
    [int]$Port = 8088,
    [int]$Np = 1,
    [string]$Model = "F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
)
$ErrorActionPreference = "Stop"
$llama = "F:\my_ai\subgen\dist\translator\llama-server.exe"
$log = "F:\my_ai\aidulc\.spikes\tmp\llama_np$Np.log"
$health = "http://127.0.0.1:$Port/health"

$proc = Start-Process -FilePath $llama -ArgumentList @("-m", $Model, "-ngl", "99", "-np", $Np, "--port", "$Port", "-c", "8192", "--no-warmup") -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw "llama-server did not become ready. Log tail:"; Get-Content $log -Tail 20 }
    Write-Output "READY after ~$i s (np=$Np)"

    function Send-Chat([string]$body) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120
        $sw.Stop()
        $usage = $r.usage
        $out = $r.choices[0].message.content
        $tps = if ($usage.completion_tokens -gt 0) { [math]::Round($usage.completion_tokens / $sw.Elapsed.TotalSeconds, 1) } else { 0 }
        return [pscustomobject]@{ ms = $sw.Elapsed.TotalMilliseconds; in = $usage.prompt_tokens; out = $usage.completion_tokens; tps = $tps; content = $out }
    }

    # Test 1: json_schema constrained decoding
    $schema = '{"type":"object","properties":{"translation":{"type":"string"},"explanation":{"type":"string"}},"required":["translation","explanation"]}'
    $body1 = @{
        model = "qwen3"
        messages = @(@{ role = "user"; content = "Translate to Chinese and explain briefly: 'He broke the news to her carefully.' Return JSON." })
        response_format = @{ type = "json_schema"; json_schema = @{ name = "explain"; schema = ($schema | ConvertFrom-Json) } }
        temperature = 0.3
    } | ConvertTo-Json -Depth 10
    $r1 = Send-Chat $body1
    Write-Output "TEST1 json_schema: ms=$($r1.ms) out=$($r1.out) tps=$($r1.tps)"
    Write-Output "  content=$($r1.content)"
    $parsed = $r1.content | ConvertFrom-Json
    Write-Output "  valid_json=$($null -ne $parsed.translation -and $null -ne $parsed.explanation)"

    # Test 2: 5x plain chat (translation) throughput
    $tpsAcc = @()
    for ($n = 1; $n -le 5; $n++) {
        $body2 = @{
            model = "qwen3"
            messages = @(@{ role = "user"; content = "Translate this English sentence into natural Chinese. Output ONLY the translation, no explanation. Sentence: 'The committee finally reached an agreement after hours of heated discussion.'" })
            temperature = 0.3
        } | ConvertTo-Json -Depth 5
        $r2 = Send-Chat $body2
        $tpsAcc += $r2.tps
        Write-Output "TEST2 run$n : ms=$($r2.ms) out=$($r2.out) tps=$($r2.tps)"
    }
    Write-Output "TEST2 avg tps = $([math]::Round(($tpsAcc | Measure-Object -Average).Average, 1))"
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Write-Output "server stopped"
}
