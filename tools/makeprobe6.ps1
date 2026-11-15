# Sixth Publisher test publication: character effects (strikethrough, small caps, all caps...).
# Usage: powershell -File tools\makeprobe6.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
try {
    $path = Join-Path $Out 'probe-effects.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
    $y = 30.0
    foreach ($fx in @('Plain', 'StrikeThrough', 'SmallCaps', 'AllCaps', 'Shadow', 'Outline', 'Emboss', 'Engrave', 'DoubleStrikeThrough')) {
        $s = $p.Shapes.AddTextbox(1, [double]60, [double]$y, [double]400, [double]30)
        $s.TextFrame.TextRange.Text = "Effect $fx on this line"
        $s.TextFrame.TextRange.Font.Name = 'Arial'
        $s.TextFrame.TextRange.Font.Size = [single]14
        if ($fx -ne 'Plain') {
            try { $s.TextFrame.TextRange.Font.$fx = -1 } catch { $s.TextFrame.TextRange.Text = "Effect $fx failed" ; Write-Host "$fx : $($_.Exception.Message)" }
        }
        $y += 40
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-effects'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
