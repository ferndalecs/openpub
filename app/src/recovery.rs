//! Recovery copies: while a publication has unsaved changes, a copy of it is written every so
//! often, so the work isn't lost if OpenPub or the computer stops before it is saved.
//!
//! The copy is a hidden OpenPub document next to the publication (`~$<name>.recovery.opub`):
//! on school computers the user's profile may be wiped at log-off, but the folder the work is
//! in usually survives. A new publication that has never been saved, or one in a folder that
//! can't be written to, keeps its copy in `%LOCALAPPDATA%\OpenPub\recovery`.
//!
//! Each copy has a lock file (`<copy>.lock`) that the window writing it holds open: a copy
//! whose lock nobody holds is left over from a window that closed without saving - one that
//! crashed - and is offered back the next time.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use openpub_core::model::Document;
use serde::{Deserialize, Serialize};

/// What a recovery copy is a copy of.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Meta {
    /// The publication's name as shown ("Worksheet_8.pub", "Publication1").
    pub name: String,
    /// The file it came from, if any.
    pub original: Option<PathBuf>,
    /// When the copy was written (seconds since 1970).
    pub time: u64,
}

/// The recovery copy this window is keeping.
pub struct Active {
    pub file: PathBuf,
    /// Held open while the window lives (see the module comment).
    _lock: File,
}

impl Active {
    pub fn lock_path(&self) -> PathBuf {
        lock_path(&self.file)
    }
}

fn lock_path(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

/// The folder for copies that can't go next to their publication.
pub fn fallback_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("OpenPub").join("recovery"))
}

/// Where the copy of the publication at `original` goes, next to it.
pub fn beside(original: &Path) -> Option<PathBuf> {
    let name = original.file_name()?.to_string_lossy().to_string();
    Some(original.with_file_name(format!("~${name}.recovery.opub")))
}

#[cfg(windows)]
fn hidden(o: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    o.attributes(0x2); // FILE_ATTRIBUTE_HIDDEN
}
#[cfg(not(windows))]
fn hidden(_o: &mut OpenOptions) {}

/// Holds the lock of a copy (creating it): None if another window holds it, or the folder
/// can't be written to.
fn take_lock(file: &Path) -> Option<File> {
    let mut o = OpenOptions::new();
    o.read(true).write(true).create(true);
    hidden(&mut o);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(0); // nobody else may open it while it's held
    }
    o.open(lock_path(file)).ok()
}

/// Starts a copy for this window: next to the publication when that folder can be written to,
/// else in the fallback folder.
pub fn start(original: Option<&Path>) -> Option<Active> {
    if let Some(file) = original.and_then(beside) {
        // (a copy already there belongs to another window, or is one the person chose to keep:
        // leave it alone)
        if !file.exists() {
            if let Some(lock) = take_lock(&file) {
                return Some(Active { file, _lock: lock });
            }
        }
    }
    let dir = fallback_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let file = dir.join(format!("{}-{stamp}.recovery.opub", std::process::id()));
    let lock = take_lock(&file)?;
    Some(Active { file, _lock: lock })
}

/// Takes over a left-over copy (after recovering it): this window keeps it from now on.
pub fn adopt(file: &Path) -> Option<Active> {
    take_lock(file).map(|lock| Active { file: file.to_path_buf(), _lock: lock })
}

/// Writes a copy to a temporary file next to `file` (the caller then calls `finish`).
pub fn write_temp(doc: &Document, meta: &Meta, file: &Path) -> Result<PathBuf, String> {
    let tmp = {
        let mut s = file.as_os_str().to_owned();
        s.push(".tmp");
        PathBuf::from(s)
    };
    let result = (|| -> Result<(), String> {
        let mut o = OpenOptions::new();
        o.write(true).create(true).truncate(true);
        hidden(&mut o);
        let f = o.open(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(f);
        let deflate = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("document.json", deflate).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string(doc).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        zip.start_file("recovery.json", deflate).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string(meta).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        for (i, img) in doc.images.iter().enumerate() {
            zip.start_file(format!("images/{i}.{}", openpub_core::export::image_ext(&img.mime)), stored).map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Puts a finished temporary copy in place.
pub fn finish(tmp: &Path, file: &Path) -> Result<(), String> {
    std::fs::rename(tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(tmp);
        e.to_string()
    })
}

/// Removes this window's copy (the publication was saved, or closed without wanting it).
pub fn discard(active: Active) {
    let file = active.file.clone();
    let lock = active.lock_path();
    drop(active);
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_file(&lock);
    index_remove(&file);
}

/// Removes a left-over copy the person doesn't want.
pub fn delete(file: &Path) {
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_file(lock_path(file));
    index_remove(file);
}

/// Whether `file` is a copy left by a window that has gone (no window holds its lock).
pub fn is_orphan(file: &Path) -> bool {
    file.is_file() && take_lock(file).is_some()
}

/// The publication and what it is a copy of.
pub fn read(file: &Path) -> Result<(Document, Meta), String> {
    let doc = crate::opub::read(file)?;
    let f = File::open(file).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let mut json = String::new();
    if let Ok(m) = zip.by_name("recovery.json") {
        m.take(1 << 20).read_to_string(&mut json).map_err(|e| e.to_string())?;
    }
    let meta: Meta = serde_json::from_str(&json).unwrap_or_default();
    Ok((doc, meta))
}

// ---- the list of copies written (so left-over ones are found at the next start) ----------------

fn index_file() -> Option<PathBuf> {
    fallback_dir().map(|d| d.join("index.json"))
}
fn index_read() -> Vec<PathBuf> {
    index_file().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn index_write(list: &[PathBuf]) {
    let Some(f) = index_file() else { return };
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = f.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(list).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &f);
    }
}
pub fn index_add(file: &Path) {
    let mut list = index_read();
    if !list.iter().any(|p| p == file) {
        list.push(file.to_path_buf());
        index_write(&list);
    }
}
fn index_remove(file: &Path) {
    let mut list = index_read();
    let n = list.len();
    list.retain(|p| p != file);
    if list.len() != n {
        index_write(&list);
    }
}

/// Left-over copies, newest first, with what they are copies of (copies that no longer exist
/// are dropped from the list).
pub fn orphans() -> Vec<(PathBuf, Meta)> {
    let list = index_read();
    let kept: Vec<PathBuf> = list.iter().filter(|p| p.is_file()).cloned().collect();
    if kept.len() != list.len() {
        index_write(&kept);
    }
    let mut out: Vec<(PathBuf, Meta)> = kept.into_iter().filter(|p| is_orphan(p)).filter_map(|p| read(&p).ok().map(|(_, m)| (p, m))).collect();
    out.sort_by(|a, b| b.1.time.cmp(&a.1.time));
    out
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// "14:32 today", "14:32 on 26/11/2026" (local time).
pub fn when(time: u64) -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
        let ft = (time + 11_644_473_600) * 10_000_000;
        let f = FILETIME { dwLowDateTime: ft as u32, dwHighDateTime: (ft >> 32) as u32 };
        let mut utc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        let mut loc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        let tft = (now() + 11_644_473_600) * 10_000_000;
        let tf = FILETIME { dwLowDateTime: tft as u32, dwHighDateTime: (tft >> 32) as u32 };
        let mut tutc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        let mut tloc: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe {
            if FileTimeToSystemTime(&f, &mut utc) != 0 && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut loc) != 0 && FileTimeToSystemTime(&tf, &mut tutc) != 0 && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &tutc, &mut tloc) != 0 {
                let same_day = loc.wYear == tloc.wYear && loc.wMonth == tloc.wMonth && loc.wDay == tloc.wDay;
                return if same_day { format!("{:02}:{:02} today", loc.wHour, loc.wMinute) } else { format!("{:02}:{:02} on {:02}/{:02}/{}", loc.wHour, loc.wMinute, loc.wDay, loc.wMonth, loc.wYear) };
            }
        }
    }
    let _ = time;
    "an earlier time".into()
}
