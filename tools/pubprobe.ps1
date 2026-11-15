# Prints chosen properties of every shape on some pages, straight from Microsoft Publisher.
# Usage: powershell -File pubprobe.ps1 -Pub <file.pub> -Pages 1,2 [-Expr '$s.TextWrap.Type;$s.ID']
# (expressions separated by ;, evaluated with $s = the shape)
param(
    [Parameter(Mandatory = $true)][string]$Pub,
    [string]$Pages = '1',
    [string]$Expr = '$s.TextWrap.Type;$s.TextWrap.Side'
)
$Pub = (Resolve-Path -LiteralPath $Pub).Path
$app = New-Object -ComObject Publisher.Application
try {
    $doc = $app.Open($Pub, $true, $false, 3)
    foreach ($n in ($Pages -split ',' | ForEach-Object { [int]$_ })) {
        $p = $doc.Pages.Item($n)
        Write-Host "PAGE $n"
        foreach ($s in $p.Shapes) {
            $vals = foreach ($e in ($Expr -split ';')) { try { $v = Invoke-Expression $e; "$v" } catch { 'ERR:' + $_.Exception.Message.Substring(0, [math]::Min(40, $_.Exception.Message.Length)) } }
            Write-Host ("  {0,-22} t{1,-3} [{2,7:n1},{3,7:n1} {4,6:n1}x{5,6:n1}] {6}" -f $s.Name, [int]$s.Type, $s.Left, $s.Top, $s.Width, $s.Height, ($vals -join ' | '))
        }
    }
    $doc.Close()
} finally {
    $app.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
