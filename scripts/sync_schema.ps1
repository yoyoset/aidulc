# 同步 contracts/ → prep/aidulc_prep/schemas/ (打包时 schema 随侧车走)
param([string]$Contracts = "F:\my_ai\aidulc\contracts", [string]$Out = "F:\my_ai\aidulc\prep\aidulc_prep\schemas")
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Copy-Item "$Contracts\bookpack.schema.json" "$Out\bookpack.schema.json" -Force
Copy-Item "$Contracts\job_request.schema.json" "$Out\job_request.schema.json" -Force
Copy-Item "$Contracts\progress.schema.json" "$Out\progress.schema.json" -Force
Write-Output "schemas synced -> $Out"
