//! The list of recently opened files, kept per user in %LOCALAPPDATA%\OpenPub\recent.json
//! (a JSON array of paths, newest first).

use std::path::{Path, PathBuf};

const MAX: usize = 15;

fn store() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("OpenPub").join("recent.json"))
}

pub fn list() -> Vec<PathBuf> {
    let Some(file) = store() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default().into_iter().map(PathBuf::from).collect()
}

fn write(paths: &[PathBuf]) {
    let Some(file) = store() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let names: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
    if let Ok(text) = serde_json::to_string_pretty(&names) {
        let _ = std::fs::write(file, text);
    }
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

/// Puts a file at the top of the list.
pub fn add(path: &Path) {
    // a full path, so the entry still works when the program starts somewhere else
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut paths = list();
    paths.retain(|p| !same(p, &path));
    paths.insert(0, path);
    paths.truncate(MAX);
    write(&paths);
}

pub fn remove(path: &Path) {
    let mut paths = list();
    paths.retain(|p| !same(p, path));
    write(&paths);
}

pub fn contains(path: &Path) -> bool {
    list().iter().any(|p| same(p, path))
}

/// The list for the page: name, folder and whether the file is still there.
pub fn json() -> String {
    let items: Vec<serde_json::Value> = list()
        .iter()
        .map(|p| {
            serde_json::json!({
                "path": p.to_string_lossy(),
                "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "folder": p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                "exists": p.is_file(),
            })
        })
        .collect();
    serde_json::Value::Array(items).to_string()
}
