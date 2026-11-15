//! Registers OpenPub with Windows for `.pub` and `.opub` files, for the current user (no
//! administrator rights needed). The installers do the same for all users.
//!
//! Windows doesn't let a program make itself the default for a type another program already
//! holds; after registering, the person confirms the choice in Settings > Default apps.

pub const PUB_PROG_ID: &str = "OpenPub.Publication";
pub const OPUB_PROG_ID: &str = "OpenPub.Document";

#[cfg(windows)]
pub fn register() -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let e = |e: std::io::Error| e.to_string();
    let exe = std::env::current_exe().map_err(e)?;
    let exe_s = exe.display().to_string();
    let exe_name = exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "openpub.exe".into());
    let open_cmd = format!("\"{exe_s}\" \"%1\"");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu.create_subkey(r"Software\Classes").map_err(e)?.0;
    for (prog, desc) in [(PUB_PROG_ID, "Publisher Document"), (OPUB_PROG_ID, "OpenPub Document")] {
        let (key, _) = classes.create_subkey(prog).map_err(e)?;
        key.set_value("", &desc).map_err(e)?;
        key.create_subkey("DefaultIcon").map_err(e)?.0.set_value("", &format!("\"{exe_s}\",0")).map_err(e)?;
        key.create_subkey(r"shell\open\command").map_err(e)?.0.set_value("", &open_cmd).map_err(e)?;
    }
    for (ext, prog, own) in [(".pub", PUB_PROG_ID, false), (".opub", OPUB_PROG_ID, true)] {
        let (key, _) = classes.create_subkey(ext).map_err(e)?;
        // only take the default for .pub when nobody has it yet
        let existing: String = key.get_value("").unwrap_or_default();
        if own || existing.is_empty() {
            key.set_value("", &prog).map_err(e)?;
        }
        key.create_subkey("OpenWithProgids").map_err(e)?.0.set_value(prog, &"").map_err(e)?;
    }
    let (app, _) = classes.create_subkey(format!(r"Applications\{exe_name}")).map_err(e)?;
    app.set_value("FriendlyAppName", &"OpenPub").map_err(e)?;
    app.create_subkey(r"shell\open\command").map_err(e)?.0.set_value("", &open_cmd).map_err(e)?;
    let (types, _) = app.create_subkey("SupportedTypes").map_err(e)?;
    types.set_value(".pub", &"").map_err(e)?;
    types.set_value(".opub", &"").map_err(e)?;
    // Default apps page
    let (caps, _) = hkcu.create_subkey(r"Software\OpenPub\Capabilities").map_err(e)?;
    caps.set_value("ApplicationName", &"OpenPub").map_err(e)?;
    caps.set_value("ApplicationDescription", &"Viewer and editor for Microsoft Publisher files").map_err(e)?;
    let (fa, _) = caps.create_subkey("FileAssociations").map_err(e)?;
    fa.set_value(".pub", &PUB_PROG_ID).map_err(e)?;
    fa.set_value(".opub", &OPUB_PROG_ID).map_err(e)?;
    hkcu.create_subkey(r"Software\RegisteredApplications").map_err(e)?.0.set_value("OpenPub", &r"Software\OpenPub\Capabilities").map_err(e)?;
    notify_shell();
    Ok(())
}

#[cfg(windows)]
pub fn unregister() -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(classes) = hkcu.open_subkey_with_flags(r"Software\Classes", winreg::enums::KEY_ALL_ACCESS) {
        for prog in [PUB_PROG_ID, OPUB_PROG_ID] {
            let _ = classes.delete_subkey_all(prog);
        }
        for (ext, prog) in [(".pub", PUB_PROG_ID), (".opub", OPUB_PROG_ID)] {
            if let Ok(key) = classes.open_subkey_with_flags(ext, winreg::enums::KEY_ALL_ACCESS) {
                let current: String = key.get_value("").unwrap_or_default();
                if current == prog {
                    let _ = key.delete_value("");
                }
                if let Ok(owp) = key.open_subkey_with_flags("OpenWithProgids", winreg::enums::KEY_ALL_ACCESS) {
                    let _ = owp.delete_value(prog);
                }
            }
        }
        let _ = classes.delete_subkey_all(r"Applications\openpub.exe");
    }
    let _ = hkcu.delete_subkey_all(r"Software\OpenPub");
    if let Ok(ra) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", winreg::enums::KEY_ALL_ACCESS) {
        let _ = ra.delete_value("OpenPub");
    }
    notify_shell();
    Ok(())
}

#[cfg(windows)]
fn notify_shell() {
    use windows::Win32::UI::Shell::{SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

/// Opens the Windows "Default apps" settings page.
#[cfg(windows)]
pub fn open_default_apps() {
    let _ = std::process::Command::new("cmd").args(["/c", "start", "", "ms-settings:defaultapps"]).spawn();
}

#[cfg(not(windows))]
pub fn register() -> Result<(), String> {
    Err("Linking file types is only available on Windows.".into())
}
#[cfg(not(windows))]
pub fn unregister() -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn open_default_apps() {}
