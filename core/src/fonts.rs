//! Vertical metrics of installed fonts, as Publisher uses them to space lines.
//!
//! Measured against Publisher (tools/linepitch.py): a line is (ascent + descent + line gap) x
//! font size x line spacing, taking the OS/2 "typo" values for fonts with an OS/2 table of
//! version 2 or later and the hhea values for older fonts.

use crate::model::FontMetrics;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Lower-case family name -> font file, for the fonts installed on this computer.
fn installed() -> &'static HashMap<String, std::path::PathBuf> {
    static FONTS: OnceLock<HashMap<String, std::path::PathBuf>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut out = HashMap::new();
        #[cfg(windows)]
        {
            use winreg::RegKey;
            use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
            let dir = std::env::var_os("WINDIR").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into()).join("Fonts");
            for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
                let Ok(key) = RegKey::predef(hive).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") else { continue };
                for (name, value) in key.enum_values().flatten() {
                    let file = value.to_string();
                    let file = file.trim_end_matches('\0');
                    let path = if std::path::Path::new(file).is_absolute() { std::path::PathBuf::from(file) } else { dir.join(file) };
                    // "Arial Bold (TrueType)", "Cambria & Cambria Math (TrueType)"
                    let base = name.split(" (").next().unwrap_or(&name);
                    for part in base.split(" & ") {
                        let part = part.trim().to_lowercase();
                        // the regular face wins over bold/italic files of the same family
                        let styled = ["bold", "italic", "oblique", "light", "semibold", "black"].iter().any(|w| part.ends_with(w));
                        if styled {
                            let family = ["bold italic", "bold", "italic", "oblique", "light", "semibold"].iter().fold(part.clone(), |p, w| p.strip_suffix(w).map(|s| s.trim().to_string()).unwrap_or(p));
                            out.entry(family).or_insert_with(|| path.clone());
                        } else {
                            out.insert(part, path.clone());
                        }
                    }
                }
            }
        }
        out
    })
}

/// The families of the fonts installed on this computer, as their names are written ("Arial",
/// "Comic Sans MS"), sorted - for the editor's font list.
pub fn families() -> &'static Vec<String> {
    static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();
    FAMILIES.get_or_init(|| {
        let mut out: Vec<String> = Vec::new();
        #[cfg(windows)]
        {
            use winreg::RegKey;
            use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
            let mut seen = std::collections::HashSet::new();
            for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
                let Ok(key) = RegKey::predef(hive).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") else { continue };
                for (name, _) in key.enum_values().flatten() {
                    let base = name.split(" (").next().unwrap_or(&name);
                    for part in base.split(" & ") {
                        let fam = family_name(part.trim());
                        // ("@" fonts are for vertical text)
                        if fam.is_empty() || fam.starts_with('@') || fam.len() > 80 {
                            continue;
                        }
                        if seen.insert(fam.to_lowercase()) {
                            out.push(fam);
                        }
                    }
                }
            }
        }
        out.sort_by_key(|a| a.to_lowercase());
        out
    })
}

/// "Arial Bold Italic" -> "Arial": the family of a font face's name.
fn family_name(face: &str) -> String {
    let mut fam = face.to_string();
    for w in ["bold italic", "bold", "italic", "oblique", "light", "semibold"] {
        let n = fam.len().saturating_sub(w.len());
        if fam.len() > w.len() && fam.is_char_boundary(n) && fam[n..].eq_ignore_ascii_case(w) {
            fam.truncate(n);
            fam = fam.trim().to_string();
        }
    }
    fam
}

fn read_metrics(data: &[u8]) -> Option<FontMetrics> {
    let u16_at = |o: usize| data.get(o..o + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let i16_at = |o: usize| u16_at(o).map(|v| v as i16 as f64);
    let u32_at = |o: usize| data.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    // a font collection: use its first font
    let off = if data.get(..4) == Some(b"ttcf") { u32_at(12)? as usize } else { 0 };
    let n = u16_at(off + 4)? as usize;
    let mut tables = HashMap::new();
    for i in 0..n.min(200) {
        let rec = off + 12 + i * 16;
        let tag = data.get(rec..rec + 4)?;
        tables.insert(tag.to_vec(), u32_at(rec + 8)? as usize);
    }
    let head = *tables.get(&b"head".to_vec())?;
    let upem = u16_at(head + 18)? as f64;
    if upem <= 0.0 {
        return None;
    }
    let hhea = *tables.get(&b"hhea".to_vec())?;
    let (h_asc, h_desc, h_gap) = (i16_at(hhea + 4)?, i16_at(hhea + 6)?, i16_at(hhea + 8)?);
    if let Some(&os2) = tables.get(&b"OS/2".to_vec()) {
        if u16_at(os2)? >= 2 {
            let (a, d, g) = (i16_at(os2 + 68)?, i16_at(os2 + 70)?, i16_at(os2 + 72)?);
            if a > 0.0 && a - d > 0.0 {
                return Some(FontMetrics { ascent: a / upem, descent: -d / upem, gap: g.max(0.0) / upem });
            }
        }
    }
    Some(FontMetrics { ascent: h_asc / upem, descent: -h_desc / upem, gap: h_gap.max(0.0) / upem })
}

/// Metrics of an installed font family, if it is installed.
pub fn metrics(family: &str) -> Option<FontMetrics> {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, Option<FontMetrics>>>> = OnceLock::new();
    let key = family.trim().to_lowercase();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(m) = cache.lock().unwrap().get(&key) {
        return m.clone();
    }
    let m = installed().get(&key).and_then(|p| std::fs::read(p).ok()).and_then(|d| read_metrics(&d));
    cache.lock().unwrap().insert(key, m.clone());
    m
}

/// Fills `doc.fonts` with the metrics of every font the document uses.
pub fn attach(doc: &mut crate::model::Document) {
    fn walk(s: &crate::model::Shape, out: &mut std::collections::BTreeSet<String>) {
        let mut paras = |ps: &[crate::model::Para], out: &mut std::collections::BTreeSet<String>| {
            for p in ps {
                for r in &p.runs {
                    out.insert(r.font.clone());
                    if let Some(o) = &r.object {
                        walk(o, out);
                    }
                }
                if let Some(f) = p.bullet.as_ref().and_then(|b| b.font.clone()) {
                    out.insert(f);
                }
            }
        };
        if let Some(t) = &s.text {
            paras(&t.paras, out);
        }
        if let Some(t) = &s.table {
            for c in &t.cells {
                paras(&c.paras, out);
            }
        }
        if let Some(w) = &s.wordart {
            out.insert(w.font.clone());
        }
        for c in &s.children {
            walk(c, out);
        }
    }
    let mut names = std::collections::BTreeSet::new();
    for p in &doc.pages {
        for s in &p.shapes {
            walk(s, &mut names);
        }
    }
    for n in names {
        if doc.fonts.contains_key(&n) {
            continue;
        }
        if let Some(m) = metrics(&n) {
            doc.fonts.insert(n, m);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_common_fonts() {
        let f = super::installed();
        let mut keys: Vec<_> = f.keys().filter(|k| k.starts_with("cal") || k.starts_with("arial")).collect();
        keys.sort();
        println!("{} fonts; {:?}", f.len(), &keys[..keys.len().min(10)]);
        println!("calibri -> {:?}", f.get("calibri"));
        println!("{:?}", super::metrics("Calibri"));
    }
}
