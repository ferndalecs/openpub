# Lists the windows (title, class, visibility) that belong to running Publisher processes, to see
# which dialog an automated Publisher is waiting on. Usage: powershell -File pubwindows.ps1
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PubWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  public static List<string> List(uint want) {
    var r = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var line = string.Format("{0} [{1}] visible={2} '{3}'", h, c, IsWindowVisible(h), t);
      if (c.ToString() == "#32770") {
        EnumChildWindows(h, (k, m) => { var tt = new StringBuilder(512); GetWindowText(k, tt, 512); if (tt.Length > 0) line += " | " + tt; return true; }, IntPtr.Zero);
      }
      r.Add(line);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@
foreach ($p in Get-Process MSPUB -ErrorAction SilentlyContinue) {
    Write-Host "MSPUB $($p.Id) started $($p.StartTime)"
    [PubWin]::List([uint32]$p.Id) | Where-Object { $_ -match 'visible=True' -or $_ -match '#32770' } | ForEach-Object { "  $_" }
}
