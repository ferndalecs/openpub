//! Converting many Publisher files at once, for IT staff (a script, SCCM) or a teacher moving a
//! department's worksheets off Publisher:
//!
//! `openpub.exe --convert <folder or .pub file> --to pdf|docx|opub [--out <folder>] [--overwrite]`
//!
//! A folder is worked through with its subfolders; the converted files go next to the originals
//! (or under `--out`, keeping the same subfolders). Files already there are left alone unless
//! `--overwrite` is given. Every file gets a line in `openpub-convert.log` in the output folder.
//! Exit code: 0 all converted (or nothing to do), 1 some couldn't be converted, 2 the command
//! itself was wrong.
//!
//! Word documents and .opub files are made without a window. PDFs need OpenPub's own page
//! drawing, so main.rs opens each file in a hidden window and prints it to PDF there.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

use openpub_core::model::Document;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Format {
    Pdf,
    Docx,
    Opub,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
            "pdf" => Some(Format::Pdf),
            "docx" | "word" => Some(Format::Docx),
            "opub" | "openpub" => Some(Format::Opub),
            _ => None,
        }
    }
    pub fn ext(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Docx => "docx",
            Format::Opub => "opub",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Format::Pdf => "PDF",
            Format::Docx => "Word",
            Format::Opub => "OpenPub",
        }
    }
}

#[derive(Debug)]
pub struct Options {
    pub source: PathBuf,
    pub to: Format,
    pub out: Option<PathBuf>,
    pub overwrite: bool,
}

pub const USAGE: &str = "openpub.exe --convert <folder or .pub file> --to pdf|docx|opub [--out <folder>] [--overwrite]";

/// The conversion asked for on the command line: None when there's no `--convert`.
pub fn parse(args: &[OsString]) -> Option<Result<Options, String>> {
    if !args.iter().any(|a| a.to_str().is_some_and(|s| s.eq_ignore_ascii_case("--convert"))) {
        return None;
    }
    Some(parse_all(args))
}

fn parse_all(args: &[OsString]) -> Result<Options, String> {
    let mut source = None;
    let mut to = None;
    let mut out = None;
    let mut overwrite = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let key = a.to_str().map(|s| s.to_ascii_lowercase()).unwrap_or_default();
        let mut value = |what: &str| it.next().cloned().ok_or_else(|| format!("{what} needs a value after it"));
        match key.as_str() {
            "--convert" => source = Some(PathBuf::from(value("--convert")?)).filter(|p| !p.as_os_str().is_empty()),
            "--to" => {
                let v = value("--to")?;
                to = Some(Format::parse(&v.to_string_lossy()).ok_or_else(|| format!("--to {} isn't one of pdf, docx or opub", v.to_string_lossy()))?);
            }
            "--out" => out = Some(PathBuf::from(value("--out")?)),
            "--overwrite" => overwrite = true,
            _ => return Err(format!("{} wasn't expected", a.to_string_lossy())),
        }
    }
    let source = source.ok_or("--convert needs a folder or a .pub file")?;
    let to = to.ok_or("--to pdf, --to docx or --to opub is needed")?;
    Ok(Options { source, to, out, overwrite })
}

/// One file to convert.
#[derive(Clone, Debug)]
pub struct Item {
    pub src: PathBuf,
    pub dest: PathBuf,
}

/// What a conversion will do.
#[derive(Default, Debug)]
pub struct Plan {
    pub items: Vec<Item>,
    /// Converted files that are already there (left alone).
    pub existing: Vec<Item>,
    /// Folders that couldn't be read.
    pub unreadable: Vec<(PathBuf, String)>,
    /// Where the converted files go (and the log).
    pub base: PathBuf,
}

fn is_pub(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pub"))
}

/// "Report v1.2.pub" -> "Report v1.2.pdf" (only the last extension is replaced).
fn converted_name(src: &Path, ext: &str) -> Option<PathBuf> {
    let stem = src.file_stem()?.to_string_lossy().to_string();
    Some(PathBuf::from(format!("{stem}.{ext}")))
}

/// The files to convert and where each goes.
pub fn plan(o: &Options) -> Result<Plan, String> {
    let source = std::path::absolute(&o.source).unwrap_or_else(|_| o.source.clone());
    let meta = std::fs::metadata(&source).map_err(|e| format!("{} can't be read: {e}", source.display()))?;
    let mut p = Plan::default();
    let (root, files) = if meta.is_dir() {
        let mut files = Vec::new();
        walk(&source, 0, &mut files, &mut p.unreadable);
        (source.clone(), files)
    } else if is_pub(&source) {
        (source.parent().map(Path::to_path_buf).unwrap_or_default(), vec![source.clone()])
    } else {
        return Err(format!("{} isn't a folder or a Publisher (.pub) file", source.display()));
    };
    p.base = match &o.out {
        Some(out) => std::path::absolute(out).unwrap_or_else(|_| out.clone()),
        None => root.clone(),
    };
    for src in files {
        let rel = src.strip_prefix(&root).map(Path::to_path_buf).unwrap_or_else(|_| src.file_name().map(PathBuf::from).unwrap_or_default());
        let Some(name) = converted_name(&rel, o.to.ext()) else { continue };
        let dest = p.base.join(rel.parent().unwrap_or(Path::new(""))).join(name);
        let item = Item { src, dest };
        if item.dest.exists() && !o.overwrite {
            p.existing.push(item);
        } else {
            p.items.push(item);
        }
    }
    Ok(p)
}

/// The Publisher files in a folder and its subfolders, in name order. Hidden working files
/// ("~$...") and links to other places are left out.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>, unreadable: &mut Vec<(PathBuf, String)>) {
    if depth > 32 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            unreadable.push((dir.to_path_buf(), e.to_string()));
            return;
        }
    };
    let mut list: Vec<(PathBuf, std::fs::FileType)> = entries.filter_map(|e| e.ok()).filter_map(|e| e.file_type().ok().map(|t| (e.path(), t))).collect();
    list.sort_by_key(|(p, _)| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
    for (path, kind) in list {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if kind.is_symlink() || name.starts_with("~$") {
            continue;
        }
        if kind.is_dir() {
            walk(&path, depth + 1, out, unreadable);
        } else if kind.is_file() && is_pub(&path) {
            out.push(path);
        }
    }
}

/// The list of what was done: `openpub-convert.log` in the output folder (or, where that can't
/// be written, in OpenPub's own folder in the person's profile). Added to, never replaced.
pub struct Log {
    file: Option<std::fs::File>,
    pub converted: usize,
    pub failed: usize,
    pub skipped: usize,
}

pub const LOG_NAME: &str = "openpub-convert.log";

/// Where the log of a conversion into `base` is written.
pub fn log_path(base: &Path) -> Option<PathBuf> {
    if crate::recent::writable(base) {
        return Some(base.join(LOG_NAME));
    }
    crate::recent::app_dir().map(|d| d.join(LOG_NAME))
}

fn stamp() -> String {
    match crate::recovery::local(crate::recovery::now()) {
        Some((y, mo, d, h, mi, s)) => format!("{d:02}/{mo:02}/{y} {h:02}:{mi:02}:{s:02}"),
        None => String::new(),
    }
}

impl Log {
    pub fn open(base: &Path) -> Log {
        let file = log_path(base).and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
        Log { file, converted: 0, failed: 0, skipped: 0 }
    }
    pub fn line(&mut self, text: &str) {
        if cfg!(debug_assertions) {
            println!("{text}");
        }
        if let Some(f) = &mut self.file {
            let _ = writeln!(f, "{text}");
        }
    }
    pub fn start(&mut self, o: &Options, p: &Plan) {
        self.line("");
        self.line(&format!("{}  OpenPub {} converting {} to {} (into {})", stamp(), env!("CARGO_PKG_VERSION"), o.source.display(), o.to.name(), p.base.display()));
        for (dir, e) in &p.unreadable {
            self.line(&format!("  FOLDER NOT READ  {}: {e}", dir.display()));
        }
        for it in &p.existing {
            self.skipped += 1;
            self.line(&format!("  ALREADY THERE    {} (left as it was; --overwrite replaces it)", it.dest.display()));
        }
    }
    pub fn done(&mut self, it: &Item, result: &Result<(), String>) {
        match result {
            Ok(()) => {
                self.converted += 1;
                self.line(&format!("  CONVERTED        {} -> {}", it.src.display(), it.dest.display()));
            }
            Err(e) => {
                self.failed += 1;
                self.line(&format!("  NOT CONVERTED    {}: {e}", it.src.display()));
            }
        }
    }
    /// The last line, which the window reads back to say how it went.
    pub fn finish(&mut self) -> i32 {
        let s = summary(self.converted, self.failed, self.skipped);
        self.line(&format!("{}  {s}", stamp()));
        if let Some(f) = &mut self.file {
            let _ = f.flush();
        }
        if self.failed > 0 { 1 } else { 0 }
    }
}

pub fn summary(converted: usize, failed: usize, skipped: usize) -> String {
    let n = |k: usize, one: &str, many: &str| if k == 1 { format!("1 {one}") } else { format!("{k} {many}") };
    let mut s = format!("Done: {} converted", n(converted, "file", "files"));
    if failed > 0 {
        s += &format!(", {failed} couldn't be converted");
    }
    if skipped > 0 {
        s += &format!(", {skipped} already there");
    }
    s
}

/// The summary line at the end of a log ("Done: ..."), for the window to show.
pub fn last_summary(log: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    text.lines().rev().find_map(|l| l.find("Done: ").map(|i| l[i..].to_string()))
}

/// Reads a Publisher file for converting; a damaged file can't take the run down.
pub fn read(src: &Path) -> Result<Document, String> {
    std::panic::catch_unwind(|| openpub_core::pubfile::load(src)).unwrap_or_else(|_| Err("the file is damaged or isn't a publication OpenPub can read".into()))
}

/// Makes the folder a converted file goes in.
pub fn make_folder(dest: &Path) -> Result<(), String> {
    match dest.parent() {
        Some(d) if !d.as_os_str().is_empty() => std::fs::create_dir_all(d).map_err(|e| format!("the folder {} couldn't be made: {e}", d.display())),
        _ => Ok(()),
    }
}

/// One file to Word or .opub (not PDF: that needs the window).
pub fn convert_file(it: &Item, to: Format) -> Result<(), String> {
    let doc = read(&it.src)?;
    make_folder(&it.dest)?;
    let result = std::panic::catch_unwind(|| match to {
        Format::Docx => openpub_core::docx::export_docx(&doc, &it.dest),
        Format::Opub => crate::opub::write(&doc, &it.dest),
        Format::Pdf => Err("PDF needs the window".into()),
    });
    result.unwrap_or_else(|_| Err("OpenPub couldn't convert this file".into()))
}

/// A whole Word or .opub conversion. Returns the exit code.
pub fn run_windowless(o: &Options, p: &Plan) -> i32 {
    let mut log = Log::open(&p.base);
    log.start(o, p);
    for it in &p.items {
        let r = convert_file(it, o.to);
        log.done(it, &r);
    }
    log.finish()
}

/// A command that couldn't be understood: noted in the log in OpenPub's own folder (there may
/// be no console to print to).
pub fn bad_command(e: &str) -> i32 {
    let line = format!("{}  {e}\n  Use: {USAGE}", stamp());
    if cfg!(debug_assertions) {
        eprintln!("{line}");
    }
    if let Some(dir) = crate::recent::app_dir() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(LOG_NAME)) {
            let _ = writeln!(f, "\n{line}");
        }
    }
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn command_line() {
        assert!(parse(&args(&["file.pub"])).is_none());
        let o = parse(&args(&["--convert", r"S:\Staff\Worksheets", "--to", "PDF", "--out", r"D:\out", "--overwrite"])).unwrap().unwrap();
        assert_eq!(o.source, PathBuf::from(r"S:\Staff\Worksheets"));
        assert_eq!(o.to, Format::Pdf);
        assert_eq!(o.out, Some(PathBuf::from(r"D:\out")));
        assert!(o.overwrite);
        assert!(parse(&args(&["--convert", "x"])).unwrap().is_err(), "a format is needed");
        assert!(parse(&args(&["--convert", "x", "--to", "png"])).unwrap().is_err());
        assert!(parse(&args(&["--convert", "x", "--to"])).unwrap().is_err());
        assert!(parse(&args(&["--convert", "x", "--to", "docx", "--delete"])).unwrap().is_err());
    }

    #[test]
    fn folders_are_worked_through() {
        let dir = std::env::temp_dir().join(format!("openpub-convert-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Year 7").join("Spring")).unwrap();
        for f in ["a.pub", "Year 7/b v1.2.pub", "Year 7/Spring/c.PUB", "Year 7/~$c.pub", "Year 7/notes.txt", "Year 7/b v1.2.pdf"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let o = Options { source: dir.clone(), to: Format::Pdf, out: None, overwrite: false };
        let p = plan(&o).unwrap();
        let dests: Vec<String> = p.items.iter().map(|i| i.dest.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(dests, ["a.pdf", "Year 7/Spring/c.pdf"]);
        assert_eq!(p.existing.len(), 1, "b v1.2.pdf is already there");
        // into another folder, keeping the subfolders; everything when overwriting
        let out = dir.join("out");
        let o = Options { source: dir.clone(), to: Format::Docx, out: Some(out.clone()), overwrite: true };
        let p = plan(&o).unwrap();
        let dests: Vec<String> = p.items.iter().map(|i| i.dest.strip_prefix(&out).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(dests, ["a.docx", "Year 7/b v1.2.docx", "Year 7/Spring/c.docx"]);
        // a single file
        let o = Options { source: dir.join("a.pub"), to: Format::Opub, out: None, overwrite: false };
        let p = plan(&o).unwrap();
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].dest, dir.join("a.opub"));
        // a damaged file is reported, not fatal
        let r = convert_file(&p.items[0], Format::Opub);
        assert!(r.is_err());
        assert!(!dir.join("a.opub").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_reads_back() {
        assert_eq!(summary(1, 0, 0), "Done: 1 file converted");
        assert_eq!(summary(12, 2, 3), "Done: 12 files converted, 2 couldn't be converted, 3 already there");
    }
}
