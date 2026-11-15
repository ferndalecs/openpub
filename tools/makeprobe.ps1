# Builds test publications with Microsoft Publisher itself, each exercising features the real
# samples don't (or only rarely) use, so the reader can be checked against known settings.
# Usage: powershell -File tools\makeprobe.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$lorem = ('Publisher wraps text around objects that sit in front of a text box. ' * 2 + 'The quick brown fox jumps over the lazy dog, again and again, until the frame is full of words. ') * 6

$app = New-Object -ComObject Publisher.Application
# Publisher's SaveAs hangs when automated, but Save works: each test publication starts as a copy
# of a small A4 sample that is emptied first.
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
function Save($d) {
    $d.Save()
    Write-Host "saved $($d.FullName)"
    $d.Close()
}
function TextBox($page, $l, $t, $w, $h, $text, $size = 11) {
    $s = $page.Shapes.AddTextbox(1, $l, $t, $w, $h)
    $s.TextFrame.TextRange.Text = $text
    $s.TextFrame.TextRange.Font.Name = 'Arial'
    $s.TextFrame.TextRange.Font.Size = $size
    return $s
}

try {
    # ---- 1. text wrapping: one page per wrap type, for a rectangle and a text box in front
    $d = NewDoc 'probe-wrap.pub'
    $types = @(0, 1, 2, 3, 4)
    for ($i = 0; $i -lt $types.Count * 2; $i++) { if ($i -gt 0) { [void]$d.Pages.Add(1, $i) } }
    for ($i = 0; $i -lt $types.Count; $i++) {
        $p = $d.Pages.Item($i * 2 + 1)
        [void](TextBox $p 50 60 495 300 $lorem)
        $r = $p.Shapes.AddShape(1, 300, 120, 150, 100)   # rectangle over the right half
        $r.Fill.ForeColor.RGB = 0x00CCFF
        try { $r.TextWrap.Type = $types[$i] } catch { Write-Host "wrap $($types[$i]) on shape: $($_.Exception.Message)" }
        $e = $p.Shapes.AddShape(9, 80, 450, 120, 120)    # an ellipse too, for tight wrapping
        [void](TextBox $p 50 420 495 300 $lorem)
        $e.ZOrder(0)                                       # bring to front
        try { $e.TextWrap.Type = $types[$i] } catch {}
        $label = TextBox $p 50 20 300 24 ("wrap type " + $types[$i] + " (read back: " + $r.TextWrap.Type + ")") 14
        $q = $d.Pages.Item($i * 2 + 2)
        [void](TextBox $q 50 60 495 300 $lorem)
        $tb = TextBox $q 300 120 150 100 'A text box in front, with a fill.'
        $tb.Fill.ForeColor.RGB = 0xCCFFCC
        try { $tb.TextWrap.Type = $types[$i] } catch {}
        [void](TextBox $q 50 420 495 300 $lorem)
        $tb2 = TextBox $q 300 480 150 100 'A text box in front, no fill.'
        try { $tb2.TextWrap.Type = $types[$i] } catch {}
        [void](TextBox $q 50 20 300 24 ("text box wrap type " + $types[$i] + " (read back: " + $tb.TextWrap.Type + ")") 14)
    }
    Save $d

    # ---- 2. linked text boxes
    $d = NewDoc 'probe-linked.pub'
    [void]$d.Pages.Add(1, 1)
    $p = $d.Pages.Item(1)
    $a = TextBox $p 50 60 230 300 ($lorem * 3)
    $b = $p.Shapes.AddTextbox(1, 315, 60, 230, 200)
    $c = $d.Pages.Item(2).Shapes.AddTextbox(1, 50, 60, 495, 150)
    $a.TextFrame.NextLinkedTextFrame = $b.TextFrame
    $b.TextFrame.NextLinkedTextFrame = $c.TextFrame
    $e = $p.Shapes.AddTextbox(1, 50, 420, 160, 120)
    $f = $p.Shapes.AddTextbox(1, 230, 420, 120, 200)
    $e.TextFrame.TextRange.Text = 'Second story. ' * 30
    $e.TextFrame.NextLinkedTextFrame = $f.TextFrame
    Save $d

    # ---- 3. lists
    $d = NewDoc 'probe-lists.pub'
    $p = $d.Pages.Item(1)
    $y = 40
    foreach ($lt in 0..12) {
        $s = TextBox $p 50 $y 240 60 "Item one`rItem two`rItem three"
        try {
            $pf = $s.TextFrame.TextRange.ParagraphFormat
            $pf.ListType = $lt
            $info = "list type $lt -> " + $pf.ListType
        } catch { $info = "list type $lt failed: " + $_.Exception.Message }
        [void](TextBox $p 300 $y 250 40 $info 9)
        $y += 62
        if ($y -gt 780) { break }
    }
    [void]$d.Pages.Add(1, 1)
    $p = $d.Pages.Item(2)
    $s = TextBox $p 50 40 240 120 "Starts at five`rsix`rseven"
    try { $s.TextFrame.TextRange.ParagraphFormat.ListType = 1; $s.TextFrame.TextRange.ParagraphFormat.ListNumberStart = 5 } catch { Write-Host $_.Exception.Message }
    $s = TextBox $p 50 180 240 120 "Bullet A`rBullet B`rBullet C"
    try { $s.TextFrame.TextRange.ParagraphFormat.ListType = 0; $s.TextFrame.TextRange.ParagraphFormat.ListBulletText = [string][char]0x2666 } catch { Write-Host $_.Exception.Message }
    $s = TextBox $p 50 320 400 200 "Tracking normal`rTracking loose`rTracking tight`rScaled 150%`rScaled 70%`rKerned VAVAVA"
    $tr = $s.TextFrame.TextRange
    try {
        $tr.Paragraphs(2, 1).Font.Tracking = 1.25
        $tr.Paragraphs(3, 1).Font.Tracking = 0.8
        $tr.Paragraphs(4, 1).Font.Scaling = 1.5
        $tr.Paragraphs(5, 1).Font.Scaling = 0.7
        $tr.Paragraphs(6, 1).Font.Kerning = 5
    } catch { Write-Host "font: $($_.Exception.Message)" }
    Save $d

    # ---- 4. WordArt, shadows, arrows, connectors, shapes
    $d = NewDoc 'probe-shapes.pub'
    $p = $d.Pages.Item(1)
    $y = 40; $x = 40
    foreach ($fx in 0..29) {
        try { [void]$p.Shapes.AddTextEffect($fx, "WordArt $fx", 'Arial Black', 36, 0, 0, $x, $y) } catch { Write-Host "text effect $fx failed" }
        $x += 180
        if ($x -gt 450) { $x = 40; $y += 75 }
    }
    [void]$d.Pages.Add(1, 1)
    $p = $d.Pages.Item(2)
    $styles = @(1, 2, 3, 4, 5, 6)   # arrowhead styles
    $y = 50
    foreach ($st in $styles) {
        $l = $p.Shapes.AddLine(60, $y, 260, $y)
        $l.Line.Weight = 2
        $l.Line.EndArrowheadStyle = $st
        $l.Line.BeginArrowheadStyle = $st
        $y += 30
    }
    $l = $p.Shapes.AddLine(60, $y, 260, $y); $l.Line.Weight = 1; $l.Line.EndArrowheadStyle = 2; $l.Line.EndArrowheadWidth = 3; $l.Line.EndArrowheadLength = 3; $y += 30
    $l = $p.Shapes.AddLine(60, $y, 260, $y); $l.Line.Weight = 1; $l.Line.EndArrowheadStyle = 2; $l.Line.EndArrowheadWidth = 1; $l.Line.EndArrowheadLength = 1; $y += 30
    foreach ($ct in 1..3) {
        $c = $p.Shapes.AddConnector($ct, 320, 50 + ($ct - 1) * 90, 520, 120 + ($ct - 1) * 90)
        $c.Line.EndArrowheadStyle = 2
        $c.Line.Weight = 1.5
    }
    $r = $p.Shapes.AddShape(1, 60, 400, 120, 80); $r.Shadow.Visible = -1
    $r = $p.Shapes.AddShape(9, 220, 400, 120, 80); $r.Shadow.Visible = -1; $r.Shadow.OffsetX = 8; $r.Shadow.OffsetY = -6; $r.Shadow.ForeColor.RGB = 0x0000FF
    $t = TextBox $p 380 400 150 80 'Shadowed text box'; $t.Line.Visible = -1; $t.Shadow.Visible = -1
    $r = $p.Shapes.AddShape(1, 60, 520, 120, 80); $r.Line.Weight = 6; $r.Line.InsetPen = -1
    $r = $p.Shapes.AddShape(1, 220, 520, 120, 80); $r.Line.Weight = 6; $r.Line.InsetPen = 0
    $r = $p.Shapes.AddShape(1, 380, 520, 120, 80); $r.Line.Weight = 6; $r.Line.Style = 3   # thin-thick
    [void]$d.Pages.Add(1, 2)
    $p = $d.Pages.Item(3)
    $x = 20; $y = 20
    foreach ($ty in 1..138) {
        try {
            $s = $p.Shapes.AddShape($ty, $x, $y, 60, 45)
            $s.Fill.ForeColor.RGB = 0xFFE0C0
            [void]$p.Shapes.AddTextbox(1, $x, $y + 46, 64, 12).TextFrame.TextRange.InsertAfter("$ty")
        } catch { }
        $x += 70
        if ($x -gt 520) { $x = 20; $y += 62 }
        if ($y -gt 780) {
            [void]$d.Pages.Add(1, $d.Pages.Count)
            $p = $d.Pages.Item($d.Pages.Count)
            $x = 20; $y = 20
        }
    }
    Save $d
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
