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
# The test windows open on another monitor without taking the keyboard, and the debug build's
# console window isn't shown (as in out\runtest.ps1).
if (-not $env:OPENPUB_TEST_POS) {
    Add-Type -AssemblyName System.Windows.Forms
    $other = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
    $env:OPENPUB_TEST_POS = if ($other) { "{0},{1}" -f ($other.Bounds.X + 20), ($other.Bounds.Y + 20) } else { "20,20" }
}
function Run($script, $log, [switch]$Kill, $file = $pub) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = '"' + $file + '" "--eval=' + $script + '"'
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    # (read as it comes: part 1 waits for its KILL-ME line)
    $lines = New-Object System.Collections.Generic.List[string]
    $reader = $p.StandardOutput
    $task = $reader.ReadLineAsync()
    for ($i = 0; $i -lt 240; $i++) {
        if ($task.Wait(500)) {
            if ($null -eq $task.Result) { break }
            $lines.Add($task.Result)
            if ($Kill -and $task.Result -match 'KILL-ME') { $p.Kill(); $p.WaitForExit(); break }
            $task = $reader.ReadLineAsync()
        } elseif ($p.HasExited) { break }
    }
    if (-not $p.HasExited) { $p.Kill(); Write-Host 'TIMEOUT' }
    Set-Content -LiteralPath $log -Value $lines -Encoding UTF8
    $lines | Select-String 'OK|FAIL|COPY' | ForEach-Object { $_.Line }
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
Write-Host '== part 4: a publication in a folder the person can only read'
$ro = Join-Path (Get-Location) 'out\rec-ro'
if (Test-Path $ro) { & icacls $ro /remove:d "$env:USERNAME" | Out-Null; Remove-Item $ro -Recurse -Force }
New-Item -ItemType Directory $ro | Out-Null
$roPub = Join-Path $ro 'worksheet.pub'
Copy-Item 'samples\Worksheet_8.pub' $roPub
# no new files or changes in the folder for this user (as on a teacher's share); reading and
# listing still work (the generic W right would also take away the right to open anything)
& icacls $ro /deny "${env:USERNAME}:(OI)(CI)(WD,AD,WEA,WA)" | Out-Null
try {
    Run 'tools\rectest-d.js' 'out\log-rec-d.txt' -file $roPub
    $files = Get-ChildItem -LiteralPath $ro -Force | ForEach-Object { $_.Name }
    Check 'nothing was written in the read-only folder' (($files -join ',') -eq 'worksheet.pub')
    $line = Get-Content 'out\log-rec-d.txt' | Select-String 'COPY (.+)$' | Select-Object -First 1
    if ($line) { $c = $line.Matches[0].Groups[1].Value.Trim(); Check '...and closing removed the copy kept in the user''s folder' (-not (Test-Path -LiteralPath $c)) }
}
finally {
    & icacls $ro /remove:d "$env:USERNAME" | Out-Null
    Remove-Item $ro -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "SUMMARY (files) $ok OK, $fail FAIL"
