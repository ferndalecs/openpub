# Second set of Publisher test publications: wrapping edge cases and lists.
# Usage: powershell -File tools\makeprobe2.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$lorem = ('Publisher wraps text around objects that sit in front of a text box. The quick brown fox jumps over the lazy dog, again and again, until the frame is full of words. ') * 4
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
    try { $s = $page.Shapes.AddTextbox(1, [double]$l, [double]$t, [double]$w, [double]$h) } catch { throw "AddTextbox($l, $t, $w, $h) [$($l.GetType().Name) $($t.GetType().Name)]: $($_.Exception.Message)" }
    $s.TextFrame.TextRange.Text = $text
    $s.TextFrame.TextRange.Font.Name = 'Arial'
    $s.TextFrame.TextRange.Font.Size = $size
    return $s
}
try {
    $d = NewDoc 'probe-wrap2.pub'
    $p = $d.Pages.Item(1)
    # each case: a text frame 240 wide, 120 high, and a "through" rectangle over it
    $cases = @(
        @{ label = 'A: big rect sticking out on all sides, opaque'; l = -10; t = -10; w = 260; h = 140; tr = 0 },
        @{ label = 'B: same, 78% transparent'; l = -10; t = -10; w = 260; h = 140; tr = 0.78 },
        @{ label = 'C: covers frame except 2pt on the left, opaque'; l = 2; t = -10; w = 250; h = 140; tr = 0 },
        @{ label = 'D: same as C, 78% transparent'; l = 2; t = -10; w = 250; h = 140; tr = 0.78 },
        @{ label = 'E: half the frame, 78% transparent'; l = 120; t = 20; w = 100; h = 60; tr = 0.78 },
        @{ label = 'F: half the frame, opaque, wrap square'; l = 120; t = 20; w = 100; h = 60; tr = 0; wrap = 1 }
    )
    $i = 0
    foreach ($c in $cases) {
        $x = 40 + ($i % 2) * 270; $y = 40 + [math]::Floor($i / 2) * 250
        [void](TextBox $p $x $y 240 20 $c.label 9)
        $f = TextBox $p $x ($y + 30) 240 120 $lorem
        $r = $p.Shapes.AddShape(1, [double]($x + $c.l), [double]($y + 30 + $c.t), [double]$c.w, [double]$c.h)
        $r.Fill.ForeColor.RGB = 0xFFCC99
        $r.Fill.Transparency = [single]$c.tr
        if ($c.wrap) { $r.TextWrap.Type = [int]$c.wrap } else { $r.TextWrap.Type = 3 }
        $i++
    }
    $d.Save(); $d.Close(); Write-Host "saved probe-wrap2"

    # lists, set with SetListType (ListType is read-only)
    $d = NewDoc 'probe-lists2.pub'
    $p = $d.Pages.Item(1)
    $y = 30
    foreach ($lt in 0..12) {
        $s = TextBox $p 50 $y 220 52 "Item one`rItem two`rItem three"
        try {
            $s.TextFrame.TextRange.ParagraphFormat.SetListType($lt, [string][char]0x2022)
            $info = "SetListType $lt -> ListType " + $s.TextFrame.TextRange.ParagraphFormat.ListType + ' sep ' + $s.TextFrame.TextRange.ParagraphFormat.ListNumberSeparator
        } catch { $info = "list type $lt failed: " + $_.Exception.Message }
        [void](TextBox $p 300 $y 260 40 $info 8)
        $y += 56
    }
    [void]$d.Pages.Add(1, 1)
    $p = $d.Pages.Item(2)
    $s = TextBox $p 50 40 240 80 "Starts at five`rsix`rseven"
    try { $s.TextFrame.TextRange.ParagraphFormat.SetListType(1); $s.TextFrame.TextRange.ParagraphFormat.ListNumberStart = 5 } catch { Write-Host "start: $($_.Exception.Message)" }
    $s = TextBox $p 50 140 240 80 "Diamond A`rDiamond B"
    try { $s.TextFrame.TextRange.ParagraphFormat.SetListType(0, [string][char]0x2666) } catch { Write-Host "bullet: $($_.Exception.Message)" }
    $s = TextBox $p 50 240 240 80 "Separator ) one`rtwo"
    try { $pf = $s.TextFrame.TextRange.ParagraphFormat; $pf.SetListType(1); $pf.ListNumberSeparator = 2 } catch { Write-Host "sep: $($_.Exception.Message)" }
    $s = TextBox $p 50 340 400 200 "Tracking normal`rTracking loose`rTracking tight`rScaled 150%`rScaled 70%`rKerned VAVAVA`rSuperscript x2 and subscript H2O"
    $tr = $s.TextFrame.TextRange
    try { $tr.Paragraphs(2, 1).Font.Tracking = 1.25 } catch { Write-Host "tracking: $($_.Exception.Message)" }
    try { $tr.Paragraphs(3, 1).Font.Tracking = 0.8 } catch {}
    try { $tr.Paragraphs(4, 1).Font.Scaling = 1.5 } catch { Write-Host "scaling: $($_.Exception.Message)" }
    try { $tr.Paragraphs(5, 1).Font.Scaling = 0.7 } catch {}
    try { $tr.Paragraphs(6, 1).Font.Kerning = 5 } catch {}
    try { $tr.Paragraphs(7, 1).Characters(14, 1).Font.Superscript = -1; $tr.Paragraphs(7, 1).Characters(31, 1).Font.Subscript = -1 } catch { Write-Host "script: $($_.Exception.Message)" }
    $d.Save(); $d.Close(); Write-Host "saved probe-lists2"
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
