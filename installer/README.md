# OpenPub installers

| File | What it is |
|---|---|
| `dist\OpenPub.msi` | Windows Installer package (x64, per-machine). **Use this one for SCCM / Intune / GPO.** |
| `dist\OpenPubSetup.exe` | Setup program (WiX Burn bundle) that wraps the same MSI. For people installing by hand; also silent-capable. |
| `dist\ProductInfo.txt` | Version, MSI ProductCode and SHA-256 hashes of the build. |
| `DefaultAssociations.xml` | Sample default-app file mapping `.pub` and `.opub` to OpenPub. |

Deploy **one or the other** to a machine, not both (the bundle keeps its own Add/Remove Programs
entry and hides the MSI's).

## Build

```powershell
cd installer
.\build.ps1              # uses the existing target\release\openpub.exe
.\build.ps1 -BuildApp    # runs "cargo build --release -p openpub" first
.\build.ps1 -Manufacturer "Contoso IT"    # publisher name shown in Add/Remove Programs
```

One-off setup: WiX Toolset 5.0.2 and its extensions.

```powershell
dotnet tool install --global wix --version 5.0.2
wix extension add -g WixToolset.UI.wixext/5.0.2
wix extension add -g WixToolset.BootstrapperApplications.wixext/5.0.2
```

The version comes from `app\Cargo.toml`. Sources: `OpenPub.wxs` (MSI), `OpenPubSetup.wxs` (bundle).

Build output: one expected warning, **ICE61** ("should remove only older versions of itself"). It is
deliberate: the MSI also replaces an installed build *of the same version* (`AllowSameVersionUpgrades`),
so a rebuilt 0.1.0 cleanly replaces an earlier 0.1.0 instead of installing alongside it. ICE43 and
ICE57 are switched off in `build.ps1`: they complain about ordinary (non-advertised) all-users
shortcuts in a per-machine package, which is the intended design here.

The installers are **not code-signed**. Sign `OpenPub.msi` and `OpenPubSetup.exe` with your
organisation's certificate if SmartScreen / AppLocker / WDAC policies require it (a Burn bundle must be
signed with the detach/reattach procedure: `wix burn detach`, sign the engine, `wix burn reattach`,
sign the bundle).

## What gets installed

- `C:\Program Files\OpenPub\openpub.exe` (single file)
- Start Menu shortcut "OpenPub" (all users); optional desktop shortcut (all users)
- Registry, all under `HKLM`:
  - `Software\Classes\OpenPub.Publication` ("Publisher Document") and `Software\Classes\OpenPub.Document`
    ("OpenPub Document"): icon and `shell\open\command` = `"<folder>\openpub.exe" "%1"`
  - `Software\Classes\.opub` = `OpenPub.Document`
  - `Software\Classes\.pub\OpenWithProgids` (OpenPub offered in "Open with")
  - `Software\Classes\.pub` = `OpenPub.Publication` (only when `ASSOCIATEPUB=1`)
  - `Software\Classes\Applications\openpub.exe` (FriendlyAppName, SupportedTypes)
  - `Software\OpenPub\Capabilities` + `Software\RegisteredApplications` (Settings > Default apps)
  - `Software\Microsoft\Windows\CurrentVersion\App Paths\openpub.exe`
  - `Software\OpenPub`: `Version`, `InstallPath` (for detection)

Uninstalling removes all of the above.

## Properties

Usable on the `msiexec` command line and, with the same names, on the `OpenPubSetup.exe` command line.

| Property | Default | Meaning |
|---|---|---|
| `ASSOCIATEPUB` | `1` | `1`: also set the machine default for `.pub` to OpenPub. `0`: only register OpenPub as an available "Open with" handler for `.pub`. Use `0` on PCs that keep Microsoft Publisher. |
| `DESKTOPSHORTCUT` | `0` | `1`: create an all-users desktop shortcut. |
| `INSTALLFOLDER` | `%ProgramFiles%\OpenPub` | Install directory. |

`.opub` is always associated with OpenPub. The options are not remembered between versions: pass the
same properties again when deploying an upgrade.

## SCCM command lines

### MSI (recommended)

Install (silent, defaults):

```
msiexec /i "OpenPub.msi" /qn /norestart
```

Install with options and a log:

```
msiexec /i "OpenPub.msi" /qn /norestart ASSOCIATEPUB=0 DESKTOPSHORTCUT=1 INSTALLFOLDER="D:\Apps\OpenPub" /l*v "C:\Windows\Temp\OpenPub-install.log"
```

Uninstall (either form; the ProductCode of a build is in `dist\ProductInfo.txt`, and SCCM reads it
from the MSI when you create the application):

```
msiexec /x "OpenPub.msi" /qn /norestart
msiexec /x {PRODUCT-CODE-GUID} /qn /norestart /l*v "C:\Windows\Temp\OpenPub-uninstall.log"
```

- Upgrade: just install the newer MSI with the same command line; it removes the old version itself.
- Log switch: `/l*v "<file>"`. Progress bar only, no questions: `/qb!` or `/passive` instead of `/qn`.
- Return codes: `0` success, `3010` success but restart needed, `1602` cancelled, `1603` failure,
  `1618` another installation is in progress.
- Run as SYSTEM / "Install for system". No user interaction, no restart expected.

### Setup program (alternative)

```
OpenPubSetup.exe /quiet /norestart
OpenPubSetup.exe /quiet /norestart ASSOCIATEPUB=0 DESKTOPSHORTCUT=1 INSTALLFOLDER="D:\Apps\OpenPub"
OpenPubSetup.exe /passive /norestart
OpenPubSetup.exe /uninstall /quiet /norestart
OpenPubSetup.exe /quiet /norestart /log "C:\Windows\Temp\OpenPubSetup.log"
```

`/quiet` = no UI, `/passive` = progress only, `/log <file>` = log (the MSI log is written beside it
with a `_000_OpenPubMsi` suffix). Without a switch it shows the full wizard with the same options.

### Detection method

Any one of these:

1. **Windows Installer product code** (MSI deployments; SCCM fills this in when the MSI is imported).
   The ProductCode is **different for every build** - take it from `dist\ProductInfo.txt`. The
   UpgradeCode `{DC329018-7013-414A-B698-7C6613FB1707}` never changes.
2. **Registry** (works for both the MSI and the setup program; recommended when versions matter):
   - Hive `HKEY_LOCAL_MACHINE`, key `SOFTWARE\OpenPub`, value `Version`, type String/Version,
     rule: *greater than or equal to* `0.1.0`. Leave "32-bit application on 64-bit clients" **unticked**.
3. **File**: `%ProgramFiles%\OpenPub\openpub.exe` exists (again, not as a 32-bit application).
   Note: at the time of writing `openpub.exe` carries **no version resource**, so a "file version"
   rule cannot be used; use *file exists* or the registry `Version` value. If a later build of the app
   embeds version information, a file-version rule (`>= 0.1.0.0`) becomes possible.

Script detection equivalent:

```powershell
$v = (Get-ItemProperty 'HKLM:\SOFTWARE\OpenPub' -ErrorAction SilentlyContinue).Version
if ($v -and [version]$v -ge [version]'0.1.0') { 'Installed' }
```

## Recovery copies (what OpenPub writes on its own)

While a publication has unsaved changes, OpenPub writes a recovery copy every 30 seconds so work
isn't lost if the program or the PC stops:

* next to the publication, as a hidden file `~$<file name>.recovery.opub` (plus a `.lock` file
  while the window is open) - chosen because pupil profiles may be wiped at log-off, while the
  folder holding the work (home drive, shared area) usually survives;
* for a new publication never saved, or one in a folder the user can't write to, in
  `%LOCALAPPDATA%\OpenPub\recovery`.

Saving, or closing the window normally, removes the copy. A copy left by a crash is offered back
the next time that publication - or OpenPub - is opened, and removed if the user says No. If
these hidden `~$` files are a problem on shared drives, tell us: the location could be made a
setting.

## WebView2 Runtime

OpenPub needs the **Microsoft Edge WebView2 Runtime** (Evergreen). It is part of Windows 11 and is
present on nearly all Windows 10 machines (it is installed with Microsoft 365 Apps and by Edge
updates). The installers do not install or check for it. For a Windows 10 fleet where it may be
missing, deploy Microsoft's *Evergreen Standalone Installer* as an SCCM dependency:

```
MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
```

**Keeping it updated.** The WebView2 Runtime is the web engine that draws OpenPub's window, so
its security updates matter in the same way Microsoft Edge's do. It updates itself through the
Microsoft Edge Update service; where that is blocked (no internet access, or Edge updates
managed centrally), distribute WebView2 Runtime updates with WSUS or Configuration Manager (they
are published to Microsoft Update; Configuration Manager lists them under Microsoft Edge
Management). Check that the installed version (`pv` below) keeps pace with the current Microsoft
Edge Stable version. OpenPub's own files for each user are in `%LOCALAPPDATA%\OpenPub`.

Detection: registry value `pv` (a version, not empty and not `0.0.0.0`) under
`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`.

## File associations: what an installer can and cannot do

The installer registers everything Windows allows an installer to register: the ProgIDs, the
machine-level default for `.pub` (`ASSOCIATEPUB=1`), the "Open with" entries and the Default apps
registration.

**It cannot force the user's chosen default app.** On Windows 10 and 11 each user's choice for a file
type is stored in a hash-protected `UserChoice` registry key that only Windows itself writes. So:

- On a PC where nothing else has claimed `.pub`, double-clicking a `.pub` file opens OpenPub.
- On a PC where another app holds the user choice for `.pub` (typically **Microsoft Publisher**), that
  app stays the default after OpenPub is installed, whatever `ASSOCIATEPUB` is. Windows may show a
  "you have a new app that can open this type of file" prompt, and the user can switch under
  **Settings > Apps > Default apps** or with **Open with > Choose another app > Always**.
- No installer (MSI, EXE or script) can change that silently. This is a Windows restriction.

Administrators can enforce the default with a **default-associations XML**. A ready-made sample is
`DefaultAssociations.xml` in this folder (`.pub` -> `OpenPub.Publication`, `.opub` -> `OpenPub.Document`).

- **Group Policy (domain-joined PCs; applied at every sign-in):** Computer Configuration >
  Administrative Templates > Windows Components > File Explorer >
  **"Set a default associations configuration file"**, pointing at the XML on a path every PC can read
  (a local path or a UNC share).
- **DISM (affects user profiles created afterwards, i.e. first sign-in of new users only):**

  ```
  dism /online /Import-DefaultAppAssociations:"C:\Path\DefaultAssociations.xml"
  ```

  Undo with `dism /online /Remove-DefaultAppAssociations`.

A default-associations file replaces the whole list. If you already deploy one, merge the two
`<Association>` lines into it (export the current one with
`dism /online /Export-DefaultAppAssociations:C:\Temp\Current.xml`). Install OpenPub before the policy
applies, because the ProgIDs must exist.

Other things to know:

- With `ASSOCIATEPUB=1` on a PC that has Microsoft Publisher, the machine-level `.pub` default
  (`HKLM\Software\Classes\.pub`) is overwritten with OpenPub's, and uninstalling OpenPub removes that
  value rather than restoring Publisher's (an Office repair puts it back). Publisher's own registration
  and each user's existing choice are not touched. Use `ASSOCIATEPUB=0` where Publisher stays in use.
- Explorer may show the old icon for `.pub` / `.opub` files until the user signs out and in again.

## Test status

Built and checked on Windows 11 with WiX 5.0.2: both files build, ICE validation passes (ICE61 warning
as explained above), the MSI tables were inspected, and an administrative extraction
(`msiexec /a OpenPub.msi /qn TARGETDIR=...`) produced the expected layout. **A real install, upgrade
and uninstall have not been run** - test on a spare PC or VM before rolling out through SCCM:
`msiexec /i` silent and interactive, the options, a double-click on a `.pub` file, `msiexec /x`, and
the same through `OpenPubSetup.exe`.
