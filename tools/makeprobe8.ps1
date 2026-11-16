# Eighth Publisher test publication: page backgrounds, BorderArt, and text wrapping round a
# shape in centred, right-aligned and column text.
# Usage: powershell -File tools\makeprobe8.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$lorem = ('Text flows on both sides of a shape placed in the middle of it. The quick brown fox jumps over the lazy dog, again and again. ') * 9
if (Get-Process MSPUB -ErrorAction SilentlyContinue) { throw 'Publisher is open: close it first (this script starts and quits its own copy).' }
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
function Clear-Doc($d) {
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
}
function Try-Do([string]$what, [scriptblock]$b) { try { & $b } catch { Write-Host "FAILED $what : $($_.Exception.Message)" } }
try {
    # --- page backgrounds: solid, gradient, none, pattern
    $path = Join-Path $Out 'probe-background.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    Clear-Doc $d
    [void]$d.Pages.Add(3, 1)
    for ($i = 1; $i -le 4; $i++) {
        $p = $d.Pages.Item($i)
        $s = $p.Shapes.AddTextbox(1, [double]60, [double]60, [double]300, [double]40)
        $s.TextFrame.TextRange.Text = "Background page $i"
        Try-Do "background $i" {
            if ($i -ne 3) {
                if (-not $p.Background.Exists) { $p.Background.Create() }
                $f = $p.Background.Fill
                $f.Visible = -1
                if ($i -eq 1) { $f.Solid(); $f.ForeColor.RGB = 0x40C0FF }
                if ($i -eq 2) { $f.ForeColor.RGB = 0xFFE0C0; $f.BackColor.RGB = 0xFFFFFF; $f.TwoColorGradient(1, 1) }
                if ($i -eq 4) { $f.ForeColor.RGB = 0x00A000; $f.BackColor.RGB = 0xFFFFFF; $f.Patterned(12) }
                Write-Host ("page {0} background type {1} fore {2:X6}" -f $i, $f.Type, $f.ForeColor.RGB)
            }
        }
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-background'

    # --- BorderArt on a rectangle, a text box and (if there is one to hand) different weights
    $path = Join-Path $Out 'probe-borderart.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    Clear-Doc $d
    $p = $d.Pages.Item(1)
    $names = @()
    $names = @(foreach ($b in $d.BorderArts) { [string]$b.Name })
    Write-Host ("{0} border arts" -f $names.Count)
    $y = 40.0; $k = 0
    foreach ($w in @(8, 16, 24, 12)) {
        $s = $p.Shapes.AddShape(1, [double]60, [double]$y, [double]220, [double]120)
        $s.Fill.Visible = 0
        $name = if ($names.Count -gt $k * 7) { $names[$k * 7] } else { $null }
        Try-Do "borderart $k" {
            if ($name) { $s.BorderArt.Set($name) }
            $s.BorderArt.Weight = [single]$w
            Write-Host ("shape {0}: '{1}' weight {2} exists {3}" -f $k, $s.BorderArt.Name, $s.BorderArt.Weight, $s.BorderArt.Exists)
        }
        $y += 150; $k++
    }
    $t = $p.Shapes.AddTextbox(1, [double]320, [double]40, [double]220, [double]120)
    $t.TextFrame.TextRange.Text = 'A text box with a picture border.'
    Try-Do 'textbox borderart' { if ($names.Count) { $t.BorderArt.Set($names[0]) }; $t.BorderArt.Weight = [single]14 }
    $d.Save(); $d.Close(); Write-Host 'saved probe-borderart'

    # --- wrapping in centred, right-aligned and column text
    $path = Join-Path $Out 'probe-wrap3.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    Clear-Doc $d
    $p = $d.Pages.Item(1)
    $y = 30.0
    foreach ($c in @(@(2, 1, 0), @(3, 1, 0), @(1, 2, 0), @(1, 3, 0), @(1, 1, 1))) {
        # alignment (1 left, 2 centre, 3 right), columns, shape at the left edge?
        $s = $p.Shapes.AddTextbox(1, [double]40, [double]$y, [double]500, [double]140)
        $s.TextFrame.TextRange.Text = $lorem
        $s.TextFrame.TextRange.Font.Name = 'Arial'
        $s.TextFrame.TextRange.Font.Size = [single]9
        $s.TextFrame.TextRange.ParagraphFormat.Alignment = [int]$c[0]
        if ($c[1] -gt 1) { $s.TextFrame.Columns = [int]$c[1] }
        $s.Line.Visible = -1; $s.Line.ForeColor.RGB = 0xC0C0C0; $s.Line.Weight = [single]0.25
        $x = if ($c[2]) { 30 } elseif ($c[1] -gt 1) { 150 } else { 250 }
        $r = $p.Shapes.AddShape(1, [double]$x, [double]($y + 35), [double]90, [double]60)
        $r.Fill.ForeColor.RGB = 0xE0C080
        $r.TextWrap.Type = 1
        $y += 152
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-wrap3'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
