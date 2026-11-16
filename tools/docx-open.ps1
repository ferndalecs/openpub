# Opens a Word document made by OpenPub in Word (its own hidden copy) to check that Word accepts
# it, and lists the links on its shapes.
# Usage: powershell -File tools\docx-open.ps1 out\test.docx
param([Parameter(Mandatory = $true)][string]$Docx)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Docx).Path
$w = New-Object -ComObject Word.Application
$w.Visible = $false
$w.DisplayAlerts = 0
try {
    $d = $w.Documents.Open($path, $false, $true, $false)
    Write-Host ("opened: {0} page(s), {1} shapes, {2} hyperlinks" -f $d.ComputeStatistics(2), $d.Shapes.Count, $d.Hyperlinks.Count)
    foreach ($h in $d.Hyperlinks) { Write-Host ("  link type {0}: {1}" -f $h.Type, $h.Address) }
    $d.Close($false)
}
finally {
    $w.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w)
}
