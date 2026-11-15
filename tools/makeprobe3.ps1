# Third set of Publisher test publications: list (numbering) formats and separators.
# Usage: powershell -File tools\makeprobe3.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
function NewDoc($name) {
    $path = Join-Path $Out $name
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
    return $d
}
function TextBox($page, $l, $t, $w, $h, $text, $size = 10) {
    $s = $page.Shapes.AddTextbox(1, [double]$l, [double]$t, [double]$w, [double]$h)
    $s.TextFrame.TextRange.Text = $text
    $s.TextFrame.TextRange.Font.Name = 'Arial'
    $s.TextFrame.TextRange.Font.Size = [single]$size
    return $s
}
try {
    $d = NewDoc 'probe-lists3.pub'
    $p = $d.Pages.Item(1)
    $y = 20.0
    foreach ($lt in 0..12) {
        $s = TextBox $p 40 $y 200 40 "Item one`rItem two"
        $info = "type $lt"
        try {
            $s.TextFrame.TextRange.ParagraphFormat.SetListType([int]$lt)
            $info += ' -> ' + $s.TextFrame.TextRange.ParagraphFormat.ListType
        } catch { $info += ' failed: ' + $_.Exception.Message.Substring(0, 30) }
        [void](TextBox $p 260 $y 300 20 $info 8)
        $y += 42
    }
    [void]$d.Pages.Add(1, 1)
    $p = $d.Pages.Item(2)
    $y = 20.0
    foreach ($sep in 0..14) {
        $s = TextBox $p 40 $y 200 40 "Item one`rItem two"
        $info = "separator $sep"
        try {
            $pf = $s.TextFrame.TextRange.ParagraphFormat
            $pf.SetListType(2)
            $pf.ListNumberSeparator = [int]$sep
            $info += ' -> type ' + $pf.ListType + ' sep ' + $pf.ListNumberSeparator
        } catch { $info += ' failed: ' + $_.Exception.Message.Substring(0, 30) }
        [void](TextBox $p 260 $y 300 20 $info 8)
        $y += 42
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-lists3'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
