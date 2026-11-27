# Ninth Publisher test publication: horizontal scaling of characters (Format > Character Spacing >
# Scaling), and a picture shown inside a shape.
# Usage: powershell -File tools\makeprobe9.ps1 -Out samples\probe
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
if (Get-Process MSPUB -ErrorAction SilentlyContinue) { throw 'Publisher is open: close it first (this script starts and quits its own copy).' }
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
try {
    $path = Join-Path $Out 'probe-scaling.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
    $y = 40.0
    foreach ($sc in @(100, 50, 75, 150, 200)) {
        $s = $p.Shapes.AddTextbox(1, [double]40, [double]$y, [double]500, [double]60)
        $s.TextFrame.TextRange.Text = "Scaling $sc% - The quick brown fox jumps over the lazy dog."
        $s.TextFrame.TextRange.Font.Name = 'Arial'
        $s.TextFrame.TextRange.Font.Size = [single]14
        try { $s.TextFrame.TextRange.Font.Scaling = [single]$sc } catch { Write-Host "FAILED scaling $sc : $($_.Exception.Message)" }
        Write-Host ("scaling {0} read back {1}" -f $sc, $s.TextFrame.TextRange.Font.Scaling)
        $y += 80
    }
    # part of a line scaled
    $s = $p.Shapes.AddTextbox(1, [double]40, [double]$y, [double]500, [double]60)
    $s.TextFrame.TextRange.Text = 'Normal then narrow then normal again.'
    $s.TextFrame.TextRange.Font.Name = 'Calibri'
    $s.TextFrame.TextRange.Font.Size = [single]16
    try { $s.TextFrame.TextRange.Characters(13, 6).Font.Scaling = [single]60 } catch { Write-Host "FAILED part : $($_.Exception.Message)" }
    $d.Save(); $d.Close(); Write-Host 'saved probe-scaling'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
