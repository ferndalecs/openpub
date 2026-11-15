# Asks Microsoft Word for Office's own autoshape definitions (VML shapetypes: path, formulas,
# default adjust values, text rectangles), which web/shapes.js is built from.
# Word in Word-2003 compatibility mode stores autoshapes as VML, one <v:shapetype> per type.
# Usage: powershell -File tools\vmlshapes.ps1 -Out out\shapes\vml.docx
param([string]$Out = 'out\shapes\vml.docx')
$ErrorActionPreference = 'Stop'
$dir = Split-Path $Out -Parent
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
$Out = Join-Path (Resolve-Path $dir).Path (Split-Path $Out -Leaf)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Add()
    $doc.SetCompatibilityMode(11)
    $x = 10; $y = 10; $n = 0
    foreach ($t in 1..137) {
        try {
            $s = $doc.Shapes.AddShape($t, $x, $y, 60, 45)
            $s.AlternativeText = "auto $t"
            $n++
        } catch { Write-Host "type $t failed" }
        $x += 70
        if ($x -gt 450) { $x = 10; $y += 55 }
        if ($y -gt 700) { $y = 10 }
    }
    foreach ($c in 1..3) {
        $s = $doc.Shapes.AddConnector($c, 10, 10 + $c * 30, 200, 60 + $c * 30)
        $s.AlternativeText = "connector $c"
    }
    $s = $doc.Shapes.AddLine(10, 300, 200, 300)
    $doc.SaveAs2($Out, 12)
    Write-Host "saved $Out ($n autoshapes)"
    $doc.Close(0)
} finally {
    $word.Quit()
}

