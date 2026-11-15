# Opens a .docx in Word (read-only, no repair) and saves it as PDF; fails if Word can't open it.
# Usage: powershell -File docx-check.ps1 -Docx <file.docx> -Pdf <out.pdf>
param(
    [Parameter(Mandatory = $true)][string]$Docx,
    [Parameter(Mandatory = $true)][string]$Pdf
)
$ErrorActionPreference = 'Stop'
$Docx = (Resolve-Path -LiteralPath $Docx).Path
$Pdf = [System.IO.Path]::GetFullPath($Pdf)
$word = New-Object -ComObject Word.Application
$code = 0
try {
    $word.Visible = $false
    $word.DisplayAlerts = 0
    # ConfirmConversions=false, ReadOnly=true, AddToRecentFiles=false, ..., OpenAndRepair=false
    $m = [Type]::Missing
    $doc = $word.Documents.Open($Docx, $false, $true, $false, $m, $m, $m, $m, $m, $m, $m, $false, $false)
    $pages = $doc.ComputeStatistics(2)
    $doc.ExportAsFixedFormat($Pdf, 17)
    Write-Output "opened OK; pages=$pages; pdf=$Pdf"
    $doc.Close($false)
} catch {
    Write-Output "FAILED: $($_.Exception.Message)"
    $code = 1
} finally {
    $word.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
exit $code
