# Seventh Publisher test publication: text boxes with 1, 2 and 3 columns and different gaps.
# Usage: powershell -File tools\makeprobe7.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$lorem = ('Columns of text flow down one column and carry on at the top of the next. The quick brown fox jumps over the lazy dog, again and again. ') * 7
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
try {
    $path = Join-Path $Out 'probe-columns.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
    $y = 30.0
    foreach ($c in @(@(1, 0), @(2, 0), @(3, 0), @(2, 36), @(4, 18))) {
        $s = $p.Shapes.AddTextbox(1, [double]40, [double]$y, [double]500, [double]130)
        $s.TextFrame.TextRange.Text = $lorem
        $s.TextFrame.TextRange.Font.Name = 'Arial'
        $s.TextFrame.TextRange.Font.Size = [single]9
        $s.Line.Visible = -1
        $s.Line.ForeColor.RGB = 0xC0C0C0
        $s.Line.Weight = [single]0.25
        $s.TextFrame.Columns = [int]$c[0]
        if ($c[1] -gt 0) { $s.TextFrame.ColumnSpacing = [single]$c[1] }
        Write-Host ("columns {0} spacing read back {1}" -f $s.TextFrame.Columns, $s.TextFrame.ColumnSpacing)
        $y += 150
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-columns'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
