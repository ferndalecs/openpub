# Recovery test: a window makes changes and is killed (a crash); the next window to open the
# publication gets them back; saving or closing normally removes the copy.
# Usage (from the openpub folder, after cargo build -p openpub):  powershell -File tools\rectest.ps1
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path 'target\debug\openpub.exe').Path
$dir = Join-Path (Get-Location) 'out\rec'
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
New-Item -ItemType Directory $dir | Out-Null
Copy-Item 'samples\Worksheet_8.pub' (Join-Path $dir 'rectest.pub')
$pub = Join-Path $dir 'rectest.pub'
$copy = Join-Path $dir '~$rectest.pub.recovery.opub'
$ok = 0; $fail = 0
function Check($name, $cond) { if ($cond) { $script:ok++; Write-Host "OK   $name" } else { $script:fail++; Write-Host "FAIL $name" } }
function Run($script, $log, [switch]$Kill) {
    $p = Start-Process -FilePath $exe -ArgumentList @('"' + $pub + '"', "--eval=$script") -RedirectStandardOutput $log -PassThru
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        if ($p.HasExited) { break }
        if ($Kill -and (Test-Path $log) -and (Select-String -Path $log -Pattern 'KILL-ME' -Quiet)) { $p.Kill(); $p.WaitForExit(); break }
    }
    if (-not $p.HasExited) { $p.Kill(); Write-Host 'TIMEOUT' }
    Get-Content $log | Select-String 'OK|FAIL|COPY' | ForEach-Object { $_.Line }
}

Write-Host '== part 1: changes, then a crash'
Run 'tools\rectest-a.js' 'out\log-rec-a.txt' -Kill
Check 'after the crash the copy is still next to the publication' (Test-Path -LiteralPath $copy)
Check '...hidden' ((Test-Path -LiteralPath $copy) -and ((Get-Item -LiteralPath $copy -Force).Attributes -band [IO.FileAttributes]::Hidden))

Write-Host '== part 2: the next window offers it back'
Run 'tools\rectest-b.js' 'out\log-rec-b.txt'
Check 'after saving, the copy and its lock are gone' (-not (Test-Path -LiteralPath $copy) -and -not (Test-Path -LiteralPath "$copy.lock"))
Check 'the saved file is there' (Test-Path (Join-Path $dir 'rectest-saved.opub'))

Write-Host '== part 3: closing normally, new publications'
Run 'tools\rectest-c.js' 'out\log-rec-c.txt'
Check 'closing normally leaves no copy next to the publication' (-not (Test-Path -LiteralPath $copy))
$line = Get-Content 'out\log-rec-c.txt' | Select-String 'COPY (.+)$' | Select-Object -First 1
if ($line) { $fallback = $line.Matches[0].Groups[1].Value.Trim(); Check "...nor in the user's folder" (-not (Test-Path -LiteralPath $fallback)) }
Write-Host "SUMMARY (files) $ok OK, $fail FAIL"
