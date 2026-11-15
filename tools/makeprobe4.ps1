# Fourth Publisher test publication: vertical alignment (middle, bottom) of text at different sizes,
# line counts and line spacings.
# Usage: powershell -File tools\makeprobe4.ps1 -Out samples\probe
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
try {
    $d = NewDoc 'probe-valign.pub'
    [void]$d.Pages.Add(1, 1)
    $cases = @()
    foreach ($font in @('Arial', 'Calibri')) {
        foreach ($size in @(10, 24)) {
            foreach ($lines in @(1, 3)) {
                foreach ($sp in @(0, 2)) { $cases += @{ font = $font; size = $size; lines = $lines; sp = $sp } }
            }
        }
    }
    $i = 0
    foreach ($c in $cases) {
        $pageNo = 1 + [math]::Floor($i / 8)
        $k = $i % 8
        $p = $d.Pages.Item($pageNo)
        $y = 30 + $k * 100
        foreach ($va in @(1, 2)) {
            $x = 40 + ($va - 1) * 270
            $s = $p.Shapes.AddTextbox(1, [double]$x, [double]$y, [double]250, [double]90)
            $text = (@(1..$c.lines) | ForEach-Object { "Line $_ $($c.font) $($c.size)" }) -join "`r"
            $s.TextFrame.TextRange.Text = $text
            $s.TextFrame.TextRange.Font.Name = $c.font
            $s.TextFrame.TextRange.Font.Size = [single]$c.size
            $s.Line.Visible = -1
            $s.Line.ForeColor.RGB = 0xC0C0C0
            $s.Line.Weight = [single]0.25
            try { $s.TextFrame.VerticalTextAlignment = [int]$va } catch { Write-Host "valign: $($_.Exception.Message)" }
            if ($c.sp -eq 2) {
                try { $s.TextFrame.TextRange.ParagraphFormat.LineSpacingRule = 2 } catch { Write-Host "spacing rule: $($_.Exception.Message)" }
            }
        }
        $i++
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-valign'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
