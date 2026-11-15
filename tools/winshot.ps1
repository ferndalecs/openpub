# Starts the app with a file, waits, saves a picture of its window, then closes it.
# Usage: powershell -File winshot.ps1 -Exe <openpub.exe> -Out <png> [-File <pub>] [-Wait 8]
param([string]$Exe, [string]$Out, [string]$File = '', [int]$Wait = 8, [string]$Extra = '', [string]$Log = '')
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][WinShot]::SetProcessDPIAware()
$argList = @()
if ($File) { $argList = @('"' + (Resolve-Path -LiteralPath $File).Path + '"') }
if ($Extra) { $argList += $Extra }
$sp = @{ FilePath = $Exe; PassThru = $true }
if ($argList.Count) { $sp.ArgumentList = $argList }
if ($Log) { $sp.RedirectStandardOutput = $Log }
$p = Start-Process @sp
Start-Sleep -Seconds $Wait
$p.Refresh()
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Host "no window (exited: $($p.HasExited))"; exit 1 }
$r = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][WinShot]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "saved $Out ($w x $ht) title: $($p.MainWindowTitle)"
$p.CloseMainWindow() | Out-Null
Start-Sleep -Milliseconds 800
if (-not $p.HasExited) { $p.Kill() }
