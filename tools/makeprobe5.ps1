# Fifth Publisher test publication: words too long for their line (letters, underscores, mixed).
# Usage: powershell -File tools\makeprobe5.ps1 -Out samples\probe
# -Base: any existing one-page A4 publication, copied as the starting point.
param([string]$Out = 'samples\probe', [string]$Base = (Join-Path $PSScriptRoot '..\samples\Worksheet_8.pub'))
$ErrorActionPreference = 'Stop'
$Out = (Resolve-Path $Out).Path
$app = New-Object -ComObject Publisher.Application
$base = (Resolve-Path -LiteralPath $Base).Path
try {
    $path = Join-Path $Out 'probe-longword.pub'
    Copy-Item $base $path -Force
    $d = $app.Open($path, $false, $false, 3)
    while ($d.Pages.Count -gt 1) { $d.Pages.Item($d.Pages.Count).Delete() }
    $p = $d.Pages.Item(1)
    while ($p.Shapes.Count -gt 0) { $p.Shapes.Item(1).Delete() }
    foreach ($m in $d.MasterPages) { while ($m.Shapes.Count -gt 0) { $m.Shapes.Item(1).Delete() } }
    $texts = @(
        'A__________________________',
        'Supercalifragilisticexpialidociously',
        '__________________________B after',
        'Two words then______________________________ more',
        'x ________________________________________',
        'A_________ B_________ C_________ D_________',
        'http://www.example.org/a/very/long/address/indeed.html',
        '1.________________________________________'
    )
    $y = 30.0
    foreach ($t in $texts) {
        $s = $p.Shapes.AddTextbox(1, [double]60, [double]$y, [double]130, [double]70)
        $s.TextFrame.TextRange.Text = $t
        $s.TextFrame.TextRange.Font.Name = 'Calibri'
        $s.TextFrame.TextRange.Font.Size = [single]14
        $s.Line.Visible = -1
        $s.Line.ForeColor.RGB = 0xC0C0C0
        $s.Line.Weight = [single]0.25
        $y += 80
    }
    $d.Save(); $d.Close(); Write-Host 'saved probe-longword'
}
finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
