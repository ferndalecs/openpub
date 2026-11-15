# Exports Publisher's ground truth (page images + shape dump) for every sample that doesn't
# have one yet. Usage: powershell -File tools\truth-all.ps1 [-Force]
param([switch]$Force)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$list = python tools\samples.py
foreach ($line in $list) {
    $slug, $path = $line -split "`t", 2
    $out = Join-Path $root "truth\$slug"
    if (-not $Force -and (Test-Path (Join-Path $out 'truth.json'))) { Write-Host "skip $slug"; continue }
    Write-Host "== $slug"
    $t = Get-Date
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\truth.ps1 -Pub $path -Out $out | Select-Object -Last 1
    Write-Host ("   {0:n0} s" -f ((Get-Date) - $t).TotalSeconds)
}
Write-Host "all done"
