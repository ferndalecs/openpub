<#
.SYNOPSIS
    Builds installer\dist\OpenPub.msi and installer\dist\OpenPubSetup.exe.

.DESCRIPTION
    Takes target\release\openpub.exe and app\assets\openpub.ico, reads the version from
    app\Cargo.toml, and builds the MSI and the Burn bundle with WiX Toolset 5.0.2.

    Needs the WiX .NET tool and three extensions (one-off setup):
        dotnet tool install --global wix --version 5.0.2
        wix extension add -g WixToolset.UI.wixext/5.0.2
        wix extension add -g WixToolset.BootstrapperApplications.wixext/5.0.2
        wix extension add -g WixToolset.Util.wixext/5.0.2      (not used at present)

.PARAMETER BuildApp
    Run "cargo build --release -p openpub" first. Without it the existing release exe is used.

.PARAMETER Manufacturer
    Publisher name shown in Add/Remove Programs (default "OpenPub").

.PARAMETER SkipValidation
    Skip the ICE validation pass (wix msi validate) after building the MSI.

.EXAMPLE
    .\build.ps1
.EXAMPLE
    .\build.ps1 -BuildApp -Manufacturer "Contoso IT"
#>
[CmdletBinding()]
param(
    [switch]$BuildApp,
    [string]$Manufacturer = "OpenPub",
    [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $here "dist"
$exe  = Join-Path $root "target\release\openpub.exe"
$icon = Join-Path $root "app\assets\openpub.ico"

# --- tools ---------------------------------------------------------------------------------
$wix = Join-Path $env:USERPROFILE ".dotnet\tools\wix.exe"
if (-not (Test-Path $wix)) {
    $cmd = Get-Command wix -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "WiX Toolset not found. Install it with: dotnet tool install --global wix --version 5.0.2" }
    $wix = $cmd.Source
}

# --- version from app\Cargo.toml ([package] section) -------------------------------------------
$version = $null
$inPackage = $false
foreach ($line in Get-Content (Join-Path $root "app\Cargo.toml")) {
    if ($line -match '^\s*\[(.+)\]\s*$') { $inPackage = ($Matches[1].Trim() -eq "package"); continue }
    if ($inPackage -and $line -match '^\s*version\s*=\s*"(\d+\.\d+\.\d+)') { $version = $Matches[1]; break }
}
if (-not $version) { throw "Could not read the version from app\Cargo.toml." }

# --- the app -------------------------------------------------------------------------------
if ($BuildApp) {
    Push-Location $root
    try {
        # cargo writes progress to stderr; judge success by its exit code, not by that output
        cmd /c "cargo build --release -p openpub 2>&1"
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed." }
    } finally { Pop-Location }
}
if (-not (Test-Path $exe))  { throw "Not found: $exe  (run .\build.ps1 -BuildApp, or: cargo build --release -p openpub)" }
if (-not (Test-Path $icon)) { throw "Not found: $icon" }

New-Item -ItemType Directory -Force $dist | Out-Null
$msi    = Join-Path $dist "OpenPub.msi"
$bundle = Join-Path $dist "OpenPubSetup.exe"
Remove-Item $msi, $bundle -Force -ErrorAction SilentlyContinue

Write-Host "OpenPub $version  ($exe, $((Get-Item $exe).LastWriteTime))"

# --- MSI -----------------------------------------------------------------------------------
& $wix build (Join-Path $here "OpenPub.wxs") `
    -arch x64 -culture en-US -pdbtype none `
    -ext WixToolset.UI.wixext `
    -d "Version=$version" -d "Manufacturer=$Manufacturer" -d "ExePath=$exe" -d "IconPath=$icon" `
    -o $msi
if ($LASTEXITCODE -ne 0) { throw "OpenPub.msi did not build." }

if (-not $SkipValidation) {
    # ICE43 / ICE57 are suppressed: they object to non-advertised Start Menu / Desktop shortcuts in
    # components with a per-machine key path, because the ICEs treat those folders as per-user. In a
    # per-machine package (ALLUSERS=1) they resolve to the all-users folders, so the per-machine key
    # path is the correct one (an HKCU key path would trigger self-repair for every other user).
    # ICE61 remains as the expected warning for AllowSameVersionUpgrades (see README).
    & $wix msi validate -sice ICE43 -sice ICE57 $msi
    if ($LASTEXITCODE -ne 0) { throw "OpenPub.msi failed ICE validation." }
}

# --- bundle --------------------------------------------------------------------------------
& $wix build (Join-Path $here "OpenPubSetup.wxs") `
    -arch x64 -culture en-US -pdbtype none `
    -ext WixToolset.BootstrapperApplications.wixext `
    -d "Version=$version" -d "Manufacturer=$Manufacturer" -d "MsiPath=$msi" -d "IconPath=$icon" `
    -o $bundle
if ($LASTEXITCODE -ne 0) { throw "OpenPubSetup.exe did not build." }

# --- product info (the ProductCode changes with every build; SCCM detection needs it) ------
function Get-MsiProperty([string]$path, [string]$name) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.GetType().InvokeMember("OpenDatabase", "InvokeMethod", $null, $installer, @($path, 0))
    $view = $db.GetType().InvokeMember("OpenView", "InvokeMethod", $null, $db, @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$name'"))
    $view.GetType().InvokeMember("Execute", "InvokeMethod", $null, $view, $null) | Out-Null
    $rec = $view.GetType().InvokeMember("Fetch", "InvokeMethod", $null, $view, $null)
    $value = if ($rec) { $rec.GetType().InvokeMember("StringData", "GetProperty", $null, $rec, 1) } else { $null }
    $view.GetType().InvokeMember("Close", "InvokeMethod", $null, $view, $null) | Out-Null
    foreach ($o in @($rec, $view, $db, $installer)) { if ($o) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }
    return $value
}
$productCode = Get-MsiProperty $msi "ProductCode"
$upgradeCode = Get-MsiProperty $msi "UpgradeCode"
[GC]::Collect(); [GC]::WaitForPendingFinalizers()

$info = @(
    "OpenPub $version"
    "Built:              $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "MSI ProductCode:    $productCode   (changes with every build)"
    "MSI UpgradeCode:    $upgradeCode   (never changes)"
    "OpenPub.msi SHA256:      $((Get-FileHash $msi -Algorithm SHA256).Hash)"
    "OpenPubSetup.exe SHA256: $((Get-FileHash $bundle -Algorithm SHA256).Hash)"
)
$info | Set-Content (Join-Path $dist "ProductInfo.txt") -Encoding ascii

Write-Host ""
$info | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "Built $msi"
Write-Host "Built $bundle"
