# Ground truth from the installed Microsoft Publisher: page PNGs + a JSON dump of every shape.
# Usage: powershell -File truth.ps1 -Pub <file.pub> -Out <dir> [-Pages 1,2,9] [-NoPng]
param(
    [Parameter(Mandatory = $true)][string]$Pub,
    [Parameter(Mandatory = $true)][string]$Out,
    [int[]]$Pages = @(),
    [switch]$NoPng
)
$ErrorActionPreference = 'Stop'
$Pub = (Resolve-Path -LiteralPath $Pub).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path

function Try-Get([scriptblock]$b) { try { & $b } catch { $null } }

function Dump-Shape($s) {
    $o = [ordered]@{
        name     = $s.Name
        type     = [int]$s.Type
        auto     = Try-Get { [int]$s.AutoShapeType }
        left     = [math]::Round($s.Left, 2)
        top      = [math]::Round($s.Top, 2)
        width    = [math]::Round($s.Width, 2)
        height   = [math]::Round($s.Height, 2)
        rotation = Try-Get { [math]::Round($s.Rotation, 2) }
        z        = Try-Get { [int]$s.ZOrderPosition }
    }
    $fill = Try-Get { if ($s.Fill.Visible) { '{0:X6}' -f [int]$s.Fill.ForeColor.RGB } else { $null } }
    if ($fill) { $o.fillBGR = $fill }
    $line = Try-Get { if ($s.Line.Visible) { '{0:X6}/{1}' -f [int]$s.Line.ForeColor.RGB, $s.Line.Weight } else { $null } }
    if ($line) { $o.line = $line }
    if ($s.Type -eq 6) {
        $o.children = @($s.GroupItems | ForEach-Object { Dump-Shape $_ })
    }
    $hasTable = Try-Get { [int]$s.HasTable }
    if ($hasTable) {
        $t = $s.Table
        $o.table = [ordered]@{
            cols  = @($t.Columns | ForEach-Object { [math]::Round($_.Width, 2) })
            rows  = @($t.Rows | ForEach-Object { [math]::Round($_.Height, 2) })
            cells = @(foreach ($row in $t.Rows) {
                  $cr = $row.Cells
                  for ($ci = 1; $ci -le $cr.Count; $ci++) {
                    $cell = $cr.Item($ci)
                    $tr = $cell.TextRange
                    [ordered]@{
                        r = $cell.Row; c = $cell.Column; w = [math]::Round($cell.Width, 2); h = [math]::Round($cell.Height, 2)
                        merged = Try-Get { [int]$cell.HasMerged }
                        ml = $cell.MarginLeft; mt = $cell.MarginTop; mr = $cell.MarginRight; mb = $cell.MarginBottom
                        va = Try-Get { [int]$cell.VerticalTextAlignment }
                        fill = Try-Get { if ($cell.Fill.Visible) { '{0:X6}' -f [int]$cell.Fill.ForeColor.RGB } else { $null } }
                        bl = Try-Get { $cell.BorderLeft.Weight }; bt = Try-Get { $cell.BorderTop.Weight }
                        br = Try-Get { $cell.BorderRight.Weight }; bb = Try-Get { $cell.BorderBottom.Weight }
                        font = $tr.Font.Name; size = $tr.Font.Size; bold = Try-Get { [int]$tr.Font.Bold }
                        align = Try-Get { [int]$tr.ParagraphFormat.Alignment }
                        text = $tr.Text
                    }
                  }
                })
        }
    }
    $hasText = Try-Get { [int]$s.HasTextFrame }
    if ($hasText -and -not $hasTable) {
        $tf = $s.TextFrame
        $tr = $tf.TextRange
        $o.text = [ordered]@{
            ml = $tf.MarginLeft; mt = $tf.MarginTop; mr = $tf.MarginRight; mb = $tf.MarginBottom
            va = Try-Get { [int]$tf.VerticalTextAlignment }
            cols = Try-Get { [int]$tf.Columns }
            autofit = Try-Get { [int]$tf.AutoFitText }
            orient = Try-Get { [int]$tf.Orientation }
            text = $tr.Text
        }
        $paras = @()
        $n = Try-Get { [int]$tr.ParagraphsCount }
        for ($i = 1; $i -le [math]::Min($n, 60); $i++) {
            $p = $tr.Paragraphs($i, 1)
            $pf = $p.ParagraphFormat
            $paras += [ordered]@{
                font = $p.Font.Name; size = $p.Font.Size; bold = [int]$p.Font.Bold
                align = Try-Get { [int]$pf.Alignment }
                first = Try-Get { $pf.FirstLineIndent }; left = Try-Get { $pf.LeftIndent }; right = Try-Get { $pf.RightIndent }
                before = Try-Get { $pf.SpaceBefore }; after = Try-Get { $pf.SpaceAfter }
                ls = Try-Get { $pf.LineSpacing }; lsRule = Try-Get { [int]$pf.LineSpacingRule }
                list = Try-Get { [int]$pf.ListType }
                top = Try-Get { [math]::Round($p.BoundTop, 2) }; bleft = Try-Get { [math]::Round($p.BoundLeft, 2) }
                bw = Try-Get { [math]::Round($p.BoundWidth, 2) }; bh = Try-Get { [math]::Round($p.BoundHeight, 2) }
                lines = Try-Get { [int]$p.LinesCount }
                text = $p.Text
            }
        }
        $o.text.paras = $paras
    }
    $o
}

$app = New-Object -ComObject Publisher.Application
try {
    $doc = $app.Open($Pub, $true, $false, 3)   # read-only, pbDoNotSaveChanges
    $ps = $doc.PageSetup
    $result = [ordered]@{
        file = $Pub
        pageWidth = $ps.PageWidth; pageHeight = $ps.PageHeight
        pageCount = $doc.Pages.Count
        masters = @(); pages = @()
    }
    foreach ($m in $doc.MasterPages) {
        $result.masters += [ordered]@{ index = $m.PageIndex; name = $m.Name; shapes = @($m.Shapes | ForEach-Object { Dump-Shape $_ }) }
    }
    foreach ($p in $doc.Pages) {
        $idx = [int]$p.PageIndex
        if ($Pages.Count -and ($Pages -notcontains $idx)) { continue }
        Write-Host "page $idx"
        $result.pages += [ordered]@{
            index = $idx; number = $p.PageNumber
            width = $p.Width; height = $p.Height
            master = Try-Get { $p.Master.Name }
            shapes = @($p.Shapes | ForEach-Object { Dump-Shape $_ })
        }
        if (-not $NoPng) {
            $png = Join-Path $Out ('page-{0:D3}.png' -f $idx)
            $p.SaveAsPicture($png, 3)   # pbPictureResolutionCommercialPrint_150dpi = 3
        }
    }
    $result | ConvertTo-Json -Depth 12 | Out-File -Encoding utf8 (Join-Path $Out 'truth.json')
    $doc.Close()
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
Write-Host "done -> $Out"
