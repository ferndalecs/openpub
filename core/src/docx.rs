//! Word (.docx) export: every publication page becomes one Word page whose shapes are
//! absolutely positioned floating objects (text boxes, pictures, autoshapes); tables are real
//! Word tables sitting in a borderless text box at the table's position.
//!
//! Numbered lists become Word lists (numbering.xml); linked frames become linked text boxes;
//! WordArt becomes a text box whose text Word stretches over the shape (a text warp), with the
//! shape's fill, outline and shadow as Word 2010 text effects. Office shape types map to
//! DrawingML presets (adjust values converted), shadows to hard outer shadows.

use crate::model::{Cell, Document, Fill, Line, Para, Run, Shadow, Shape, Table, TextBody};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const NS_WPS: &str = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
/// Word 2010 run properties (text fill, outline and shadow: used for WordArt).
const NS_W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const NS_MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/// Writes `doc` as a Word document.
pub fn export_docx(doc: &Document, path: &std::path::Path) -> Result<(), String> {
    // a page's background colour becomes a page-sized rectangle behind everything else
    let with_backgrounds;
    let doc = if doc.pages.iter().any(|p| p.background.is_some()) {
        let mut d = doc.clone();
        let (w, h) = (d.width, d.height);
        for p in &mut d.pages {
            if let Some(color) = p.background.take() {
                let rect = Shape { kind: "shape".into(), shape_type: 1, w, h, fill: Some(Fill { color, opacity: 1.0, ..Default::default() }), wrap: Some("none".into()), ..Default::default() };
                p.shapes.insert(0, rect);
            }
        }
        with_backgrounds = d;
        &with_backgrounds
    } else {
        doc
    };
    // The areas each frame's text keeps clear of, worked out afresh: a document edited in the
    // app may carry stale ones. (A copy without the pictures, which aren't needed for this.)
    let mut laid = Document { width: doc.width, height: doc.height, default_tab: doc.default_tab, pages: doc.pages.clone(), fonts: doc.fonts.clone(), images: Vec::new(), notes: Vec::new() };
    crate::pubfile::compute_wraps(&mut laid);
    // Publisher mirrors a flipped line after turning it, which turns it the other way;
    // DrawingML flips first, then turns
    fn turn_lines(list: &mut [Shape]) {
        for s in list {
            if s.kind == "line" && s.flip_h != s.flip_v {
                s.rotation = -s.rotation;
            }
            turn_lines(&mut s.children);
        }
    }
    for p in &mut laid.pages {
        turn_lines(&mut p.shapes);
    }
    let mut ex = Exporter {
        doc: &laid,
        next_id: 1,
        z: 1,
        used: vec![false; doc.images.len()],
        page_field: false,
        m: Metrics::new(&doc.fonts),
        lists: Vec::new(),
        chains: HashMap::new(),
        images: &doc.images,
        image_colors: HashMap::new(),
    };
    let body = ex.body();

    let mut document = String::with_capacity(body.len() + 1024);
    document.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    let _ = write!(
        document,
        "<w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\" xmlns:wp=\"{NS_WP}\" xmlns:a=\"{NS_A}\" xmlns:pic=\"{NS_PIC}\" xmlns:wps=\"{NS_WPS}\" xmlns:w14=\"{NS_W14}\" xmlns:mc=\"{NS_MC}\" mc:Ignorable=\"w14\"><w:body>"
    );
    document.push_str(&body);
    let _ = write!(
        document,
        "<w:sectPr><w:pgSz w:w=\"{}\" w:h=\"{}\"{}/><w:pgMar w:top=\"0\" w:right=\"0\" w:bottom=\"0\" w:left=\"0\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/>",
        tw(doc.width),
        tw(doc.height),
        if doc.width > doc.height { " w:orient=\"landscape\"" } else { "" }
    );
    if ex.page_field {
        let _ = write!(document, "<w:pgNumType w:start=\"{}\"/>", doc.pages.first().map(|p| p.number).unwrap_or(1));
    }
    document.push_str("</w:sectPr></w:body></w:document>");

    // pictures that are actually used, with their file extension
    let mut media: Vec<(usize, &'static str)> = Vec::new();
    for (i, img) in doc.images.iter().enumerate() {
        if ex.used[i] {
            media.push((i, image_ext(&img.mime, &img.bytes)));
        }
    }

    let mut types = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    );
    let mut exts: Vec<&str> = media.iter().map(|m| m.1).collect();
    exts.sort();
    exts.dedup();
    for e in exts {
        let ct = match e {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            "tiff" => "image/tiff",
            "emf" => "image/x-emf",
            "wmf" => "image/x-wmf",
            _ => "application/octet-stream",
        };
        let _ = write!(types, "<Default Extension=\"{e}\" ContentType=\"{ct}\"/>");
    }
    types.push_str("<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>");
    let numbering = ex.numbering_xml();
    if numbering.is_some() {
        types.push_str("<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>");
    }
    types.push_str("</Types>");

    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";

    let mut doc_rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings\" Target=\"settings.xml\"/>",
    );
    for (i, e) in &media {
        let _ = write!(
            doc_rels,
            "<Relationship Id=\"rIdImg{i}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/image{i}.{e}\"/>"
        );
    }
    if numbering.is_some() {
        doc_rels.push_str("<Relationship Id=\"rIdNum\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>");
    }
    doc_rels.push_str("</Relationships>");

    let styles = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles xmlns:w=\"{NS_W}\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/><w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/><w:lang w:val=\"en-GB\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val=\"0\"/><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style><w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"0\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"0\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style></w:styles>"
    );

    let default_tab = if doc.default_tab > 1.0 { doc.default_tab } else { 36.0 };
    let settings = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:settings xmlns:w=\"{NS_W}\"><w:zoom w:percent=\"100\"/><w:autoHyphenation/><w:defaultTabStop w:val=\"{}\"/><w:characterSpacingControl w:val=\"doNotCompress\"/><w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat></w:settings>",
        tw(default_tab).max(1)
    );

    let file = std::fs::File::create(path).map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
    let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let deflate = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let err = |e: zip::result::ZipError| format!("Couldn't write the document: {e}");
    let ioerr = |e: std::io::Error| format!("Couldn't write the document: {e}");
    for (name, data) in [
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
        ("word/styles.xml", styles.as_bytes()),
        ("word/settings.xml", settings.as_bytes()),
    ] {
        zw.start_file(name, deflate).map_err(err)?;
        zw.write_all(data).map_err(ioerr)?;
    }
    if let Some(n) = &numbering {
        zw.start_file("word/numbering.xml", deflate).map_err(err)?;
        zw.write_all(n.as_bytes()).map_err(ioerr)?;
    }
    for (i, e) in &media {
        // png/jpeg/gif are already compressed
        let opt = if matches!(*e, "png" | "jpg" | "gif") { stored } else { deflate };
        zw.start_file(format!("word/media/image{i}.{e}"), opt).map_err(err)?;
        let img = &doc.images[*i];
        if img.orientation > 1 && *e == "jpg" {
            // Publisher shows a photo's pixels as stored: drop the EXIF turn other programs apply
            zw.write_all(&upright_jpeg(&img.bytes)).map_err(ioerr)?;
        } else {
            zw.write_all(&img.bytes).map_err(ioerr)?;
        }
    }
    let mut inner = zw.finish().map_err(err)?;
    inner.flush().map_err(ioerr)?;
    Ok(())
}

// ---- helpers ---------------------------------------------------------------------------------

fn emu(v: f64) -> i64 {
    (v * 12700.0).round() as i64
}
fn tw(v: f64) -> i64 {
    (v * 20.0).round() as i64
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\t' | '\n' | '\r' => o.push(c),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => o.push(c),
        }
    }
    o
}

/// "#rrggbb" (or "#rgb", "rgb(r,g,b)") to "RRGGBB".
fn hex(color: &str) -> String {
    let c = color.trim();
    if let Some(h) = c.strip_prefix('#') {
        if h.len() >= 6 && h[..6].chars().all(|c| c.is_ascii_hexdigit()) {
            return h[..6].to_ascii_uppercase();
        }
        if h.len() == 3 && h.chars().all(|c| c.is_ascii_hexdigit()) {
            return h.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_uppercase();
        }
    }
    if let Some(inner) = c.strip_prefix("rgb(").or_else(|| c.strip_prefix("rgba(")) {
        let v: Vec<u8> = inner
            .trim_end_matches(')')
            .split(',')
            .take(3)
            .filter_map(|p| p.trim().parse::<f64>().ok())
            .map(|v| v.clamp(0.0, 255.0) as u8)
            .collect();
        if v.len() == 3 {
            return format!("{:02X}{:02X}{:02X}", v[0], v[1], v[2]);
        }
    }
    "000000".into()
}

fn image_ext(mime: &str, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        return "png";
    }
    if bytes.starts_with(b"\xff\xd8") {
        return "jpg";
    }
    if bytes.starts_with(b"GIF8") {
        return "gif";
    }
    if bytes.starts_with(b"BM") {
        return "bmp";
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/x-emf" | "image/emf" => "emf",
        "image/x-wmf" | "image/wmf" => "wmf",
        _ => "bin",
    }
}

/// A copy of a JPEG whose EXIF orientation tag says "as stored" (1), so no viewer turns it.
fn upright_jpeg(b: &[u8]) -> Vec<u8> {
    let mut out = b.to_vec();
    if b.len() < 4 || b[0] != 0xff || b[1] != 0xd8 {
        return out;
    }
    let mut o = 2;
    while o + 4 <= b.len() && b[o] == 0xff {
        let marker = b[o + 1];
        let len = u16::from_be_bytes([b[o + 2], b[o + 3]]) as usize;
        if marker == 0xda || len < 2 {
            break;
        }
        let start = o + 4;
        let end = (o + 2 + len).min(b.len());
        if marker == 0xe1 && end > start + 14 && &b[start..start + 6] == b"Exif\0\0" {
            let t = start + 6; // TIFF header
            let le = &b[t..t + 2] == b"II";
            let u16_at = |i: usize| b.get(i..i + 2).map(|x| if le { u16::from_le_bytes([x[0], x[1]]) } else { u16::from_be_bytes([x[0], x[1]]) });
            let u32_at = |i: usize| b.get(i..i + 4).map(|x| if le { u32::from_le_bytes([x[0], x[1], x[2], x[3]]) } else { u32::from_be_bytes([x[0], x[1], x[2], x[3]]) });
            let Some(ifd) = u32_at(t + 4).map(|v| t + v as usize) else { break };
            let n = u16_at(ifd).unwrap_or(0) as usize;
            for i in 0..n.min(200) {
                let e = ifd + 2 + i * 12;
                if e + 12 > end {
                    break;
                }
                if u16_at(e) == Some(0x0112) {
                    let one = if le { [1u8, 0] } else { [0u8, 1] };
                    out[e + 8..e + 10].copy_from_slice(&one);
                }
            }
            break;
        }
        o += 2 + len;
    }
    out
}

fn is_symbol_font(font: &str) -> bool {
    matches!(font.to_ascii_lowercase().as_str(), "symbol" | "wingdings" | "wingdings 2" | "wingdings 3" | "webdings")
}

/// Fallback single-spaced line height (multiple of the font size) and average character width
/// (em) per font, for when the real font can't be measured.
fn font_metrics(font: &str) -> (f64, f64) {
    match font.to_ascii_lowercase().as_str() {
        "calibri" => (1.22, 0.47),
        "century gothic" => (1.23, 0.5),
        "arial" | "helvetica" => (1.15, 0.5),
        "times new roman" => (1.15, 0.44),
        "comic sans ms" => (1.39, 0.54),
        "cooper black" => (1.15, 0.58),
        "verdana" => (1.22, 0.58),
        "tahoma" => (1.21, 0.5),
        "cambria" => (1.17, 0.49),
        "georgia" => (1.14, 0.51),
        _ => (1.2, 0.5),
    }
}

// ---- text measuring --------------------------------------------------------------------------
//
// Word can't flow the text of a text box around other shapes, and it shows text that Publisher
// hides because it doesn't fit its frame. Both are emulated by working out roughly where each
// paragraph falls, which needs font metrics: taken from the installed fonts on Windows, from a
// small table elsewhere.

struct FontM {
    /// Single-spaced line height as Publisher spaces lines, in em.
    line: f64,
    /// Single-spaced line height as Word spaces lines, in em.
    word: f64,
    /// Fallback character width, in em.
    avg: f64,
    widths: std::collections::HashMap<char, f64>,
    #[cfg(windows)]
    handle: *mut core::ffi::c_void,
}

struct Metrics {
    fonts: std::collections::HashMap<(String, bool, bool), FontM>,
    /// Publisher's line spacing of the document's fonts (Document::fonts).
    publisher: HashMap<String, f64>,
    #[cfg(windows)]
    dc: *mut core::ffi::c_void,
}

#[cfg(windows)]
const GDI_EM: i32 = 2048;

impl Metrics {
    fn new(fonts: &std::collections::BTreeMap<String, crate::model::FontMetrics>) -> Metrics {
        Metrics {
            fonts: Default::default(),
            publisher: fonts.iter().map(|(k, m)| (k.to_ascii_lowercase(), m.ascent + m.descent + m.gap)).filter(|(_, v)| *v > 0.3 && *v < 4.0).collect(),
            #[cfg(windows)]
            dc: unsafe { windows_sys::Win32::Graphics::Gdi::CreateCompatibleDC(std::ptr::null_mut()) },
        }
    }

    /// Whether the font is installed (as far as can be told: always false off Windows).
    fn installed(&mut self, name: &str) -> bool {
        #[cfg(windows)]
        {
            !self.font(name, false, false).handle.is_null()
        }
        #[cfg(not(windows))]
        {
            let _ = name;
            false
        }
    }

    /// Width of `text` in em.
    fn text_width(&mut self, font: &str, bold: bool, italic: bool, text: &str) -> f64 {
        let r = Run { font: font.into(), bold, italic, size: 1.0, ..Default::default() };
        text.chars().map(|c| self.char_width(&r, c)).sum()
    }

    fn font(&mut self, name: &str, bold: bool, italic: bool) -> &mut FontM {
        let key = (name.to_ascii_lowercase(), bold, italic);
        if !self.fonts.contains_key(&key) {
            let (line, avg) = font_metrics(name);
            #[allow(unused_mut)]
            let mut f = FontM {
                line,
                word: line,
                avg: avg * if bold { 1.06 } else { 1.0 },
                widths: Default::default(),
                #[cfg(windows)]
                handle: std::ptr::null_mut(),
            };
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::Graphics::Gdi::*;
                if !self.dc.is_null() && !name.is_empty() {
                    let wname: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                    let h = CreateFontW(-GDI_EM, 0, 0, 0, if bold { 700 } else { 400 }, italic as u32, 0, 0, 1, 0, 0, 0, 0, wname.as_ptr());
                    if !h.is_null() {
                        SelectObject(self.dc, h);
                        // (GDI silently substitutes fonts that aren't installed)
                        let mut face = [0u16; 64];
                        let n = GetTextFaceW(self.dc, face.len() as i32, face.as_mut_ptr());
                        let got = String::from_utf16_lossy(&face[..(n.max(1) as usize - 1).min(63)]);
                        let mut tm: TEXTMETRICW = std::mem::zeroed();
                        if got.eq_ignore_ascii_case(name) && GetTextMetricsW(self.dc, &mut tm) != 0 && tm.tmHeight > 0 {
                            f.line = (tm.tmHeight + tm.tmExternalLeading) as f64 / GDI_EM as f64;
                            f.word = f.line;
                            f.handle = h;
                        } else {
                            DeleteObject(h);
                        }
                    }
                }
            }
            if let Some(v) = self.publisher.get(&key.0) {
                f.line = *v;
            }
            self.fonts.insert(key.clone(), f);
        }
        self.fonts.get_mut(&key).unwrap()
    }

    /// Height of a single-spaced line of this run (as Publisher spaces lines), in points.
    fn text_height(&mut self, r: &Run) -> f64 {
        self.font(&r.font, r.bold, r.italic).line * r.size
    }

    /// The factor that turns Word's line spacing of a paragraph into Publisher's: Word spaces
    /// lines by the fonts' Windows metrics, Publisher by their typographic ones (much tighter
    /// for fonts such as Comic Sans MS). Lines holding pictures or tables are left alone.
    fn line_factor(&mut self, p: &Para) -> f64 {
        if p.spacing_exact || p.runs.iter().any(|r| r.object.is_some()) {
            return 1.0;
        }
        let texty: Vec<&Run> = p.runs.iter().filter(|r| !r.text.is_empty() || r.field.is_some()).collect();
        let runs: Vec<&Run> = if texty.is_empty() { p.runs.last().into_iter().collect() } else { texty };
        let (mut pub_h, mut word_h) = (0.0_f64, 0.0_f64);
        for r in runs {
            if r.size <= 0.0 {
                continue;
            }
            let f = self.font(&r.font, r.bold, r.italic);
            pub_h = pub_h.max(f.line * r.size);
            word_h = word_h.max(f.word * r.size);
        }
        if pub_h <= 0.0 || word_h <= 0.0 {
            return 1.0;
        }
        let k = (pub_h / word_h).clamp(0.6, 1.6);
        if (k - 1.0).abs() < 0.01 { 1.0 } else { k }
    }

    /// Height of a line of this run in its paragraph, in points.
    fn line_height(&mut self, p: &Para, r: &Run) -> f64 {
        if p.spacing_exact { p.spacing } else { p.spacing.max(0.1) * self.text_height(r) }
    }

    /// Width of a character of this run, in points.
    fn char_width(&mut self, r: &Run, c: char) -> f64 {
        #[cfg(windows)]
        let dc = self.dc;
        let f = self.font(&r.font, r.bold, r.italic);
        if let Some(w) = f.widths.get(&c) {
            return w * r.size;
        }
        #[allow(unused_mut)]
        let mut w = f.avg;
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Graphics::Gdi::*;
            if !f.handle.is_null() {
                SelectObject(dc, f.handle);
                let mut buf = [0u16; 2];
                let s = c.encode_utf16(&mut buf);
                let mut size = windows_sys::Win32::Foundation::SIZE { cx: 0, cy: 0 };
                if GetTextExtentPoint32W(dc, s.as_ptr(), s.len() as i32, &mut size) != 0 {
                    w = size.cx as f64 / GDI_EM as f64;
                }
            }
        }
        f.widths.insert(c, w);
        w * r.size
    }

    /// Height of a paragraph laid out in a column `width` wide (without space before/after).
    fn para_height(&mut self, p: &Para, width: f64, default_tab: f64) -> f64 {
        let Some(first) = p.runs.first() else { return 0.0 };
        let right = (width - p.right).max(p.left + 10.0);
        let mut x = p.left + if p.bullet.is_some() && p.first < 0.0 { 0.0 } else { p.first };
        let mut line_start = x;
        let mut word = 0.0; // width of the unbroken text at the end of the line
        let mut line_h: f64 = 0.0;
        let mut total = 0.0;
        for r in &p.runs {
            if let Some(o) = &r.object {
                if x + word + o.w > right + 0.5 && x + word > line_start + 0.01 {
                    total += line_h;
                    line_h = 0.0;
                    x = p.left;
                    line_start = x;
                    word = 0.0;
                }
                x += word + o.w;
                word = 0.0;
                line_h = line_h.max(o.h);
                continue;
            }
            let lh = self.line_height(p, r);
            if r.field.is_some() {
                word += self.char_width(r, '0') * 2.0;
                line_h = line_h.max(lh);
                continue;
            }
            for c in r.text.chars() {
                match c {
                    '\n' | '\u{b}' => {
                        total += line_h.max(lh);
                        line_h = 0.0;
                        x = p.left;
                        line_start = x;
                        word = 0.0;
                    }
                    '\t' => {
                        x += word;
                        word = 0.0;
                        let stop = p.tabs.iter().map(|t| t.pos).filter(|t| *t > x + 0.5).fold(f64::INFINITY, f64::min);
                        x = if stop.is_finite() { stop } else { ((x + 0.5) / default_tab).floor() * default_tab + default_tab };
                        line_h = line_h.max(lh);
                    }
                    ' ' => {
                        // spaces may hang over the end of the line
                        x += word + self.char_width(r, c);
                        word = 0.0;
                        line_h = line_h.max(lh);
                    }
                    c => {
                        let cw = self.char_width(r, c);
                        if x + word + cw > right + 0.01 {
                            if x > line_start + 0.01 {
                                // the word moves to the next line
                                total += line_h.max(lh);
                                line_h = 0.0;
                                x = p.left;
                                line_start = x;
                            } else if word > 0.0 {
                                // a word longer than the line is cut
                                total += line_h.max(lh);
                                line_h = 0.0;
                                word = 0.0;
                            }
                        }
                        word += cw;
                        line_h = line_h.max(lh);
                        if c == '-' {
                            x += word;
                            word = 0.0;
                        }
                    }
                }
            }
        }
        if line_h == 0.0 {
            line_h = self.line_height(p, first);
        }
        total + line_h
    }
}

impl Drop for Metrics {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Graphics::Gdi::*;
            for f in self.fonts.values() {
                if !f.handle.is_null() {
                    DeleteObject(f.handle);
                }
            }
            if !self.dc.is_null() {
                DeleteDC(self.dc);
            }
        }
    }
}

// ---- exporter --------------------------------------------------------------------------------

struct Exporter<'a> {
    doc: &'a Document,
    next_id: u32,
    z: u32,
    used: Vec<bool>,
    page_field: bool,
    m: Metrics,
    /// Numbered lists, one Word list (numId = index + 1) per run of paragraphs that count up.
    lists: Vec<ListDef>,
    /// Stories that flow through linked frames: story id -> (Word text box id, the chain
    /// positions of its frames in order).
    chains: HashMap<u32, (u32, Vec<u32>)>,
    /// The document's pictures.
    images: &'a [crate::model::Image],
    /// Average colour of pictures used as WordArt fills (Word can't fill letters with one).
    image_colors: HashMap<usize, Option<String>>,
}

/// One numbered list: its number format and how its numbers look.
struct ListDef {
    fmt: u32,
    sep: Option<String>,
    start: u32,
    left: f64,
    first: f64,
    font: String,
    size: f64,
    color: String,
    bold: bool,
}

/// Where a run of numbered paragraphs stands while a flow of paragraphs is written.
#[derive(Default)]
struct ListState {
    /// (format, left indent, Word list) of the list the next numbered paragraph may continue.
    cur: Option<(u32, f64, u32)>,
}

/// The Word number format and level text of a numbered-list format code (see model::Bullet).
fn num_format(fmt: u32, sep: Option<&str>) -> (&'static str, String) {
    let kind = match fmt {
        2 | 3 => "lowerLetter",
        4 | 5 => "upperLetter",
        6 => "lowerRoman",
        7 => "upperRoman",
        13 => "ordinal",
        14 => "cardinalText",
        15 => "ordinalText",
        _ => "decimal",
    };
    let text = match sep {
        Some("()") => "(%1)".to_string(),
        Some(s) => format!("%1{s}"),
        None => match fmt {
            1 | 3 | 5 => "%1)".into(),
            8 => "(%1)".into(),
            9 => "%1".into(),
            _ => "%1.".into(),
        },
    };
    (kind, text)
}

/// Geometry of a floating object.
struct Frame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rotation: f64,
    flip_h: bool,
    flip_v: bool,
}

impl Frame {
    fn of(s: &Shape) -> Frame {
        Frame { x: s.x, y: s.y, w: s.w.max(0.0), h: s.h.max(0.0), rotation: s.rotation, flip_h: s.flip_h, flip_v: s.flip_v }
    }
    fn xfrm(&self) -> String {
        let mut o = String::from("<a:xfrm");
        let rot = self.rotation.rem_euclid(360.0);
        if rot != 0.0 {
            let _ = write!(o, " rot=\"{}\"", (rot * 60000.0).round() as i64);
        }
        if self.flip_h {
            o.push_str(" flipH=\"1\"");
        }
        if self.flip_v {
            o.push_str(" flipV=\"1\"");
        }
        let _ = write!(o, "><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>", emu(self.w), emu(self.h));
        o
    }
}

/// A child of a (possibly rotated or flipped) group, in page coordinates.
fn in_group(g: &Shape, c: &Shape) -> Shape {
    let mut c = c.clone();
    if g.rotation == 0.0 && !g.flip_h && !g.flip_v {
        return c;
    }
    let (gx, gy) = (g.x + g.w / 2.0, g.y + g.h / 2.0);
    let (mut dx, mut dy) = (c.x + c.w / 2.0 - gx, c.y + c.h / 2.0 - gy);
    if g.flip_h {
        dx = -dx;
        c.flip_h = !c.flip_h;
        c.rotation = -c.rotation;
    }
    if g.flip_v {
        dy = -dy;
        c.flip_v = !c.flip_v;
        c.rotation = -c.rotation;
    }
    let a = g.rotation.to_radians();
    let (rx, ry) = (dx * a.cos() - dy * a.sin(), dx * a.sin() + dy * a.cos());
    c.rotation += g.rotation;
    c.x = gx + rx - c.w / 2.0;
    c.y = gy + ry - c.h / 2.0;
    c
}

impl<'a> Exporter<'a> {
    fn id(&mut self) -> u32 {
        let v = self.next_id;
        self.next_id += 1;
        v
    }

    fn body(&mut self) -> String {
        let doc = self.doc;
        // PAGE fields give the right number when the pages are numbered consecutively
        self.page_field = doc.pages.iter().enumerate().all(|(i, p)| p.number == doc.pages[0].number + i as u32);
        // linked frames: a story whose first frame (chain 0) is there and that goes on in others
        let mut stories: HashMap<u32, Vec<u32>> = HashMap::new();
        fn walk(list: &[Shape], out: &mut HashMap<u32, Vec<u32>>) {
            for s in list {
                walk(&s.children, out);
                if let (Some(t), None) = (&s.text, &s.wordart) {
                    if t.story != 0 {
                        out.entry(t.story).or_default().push(t.chain);
                    }
                }
            }
        }
        for p in &doc.pages {
            walk(&p.shapes, &mut stories);
        }
        let mut ids: Vec<u32> = stories.keys().copied().collect();
        ids.sort();
        for story in ids {
            let mut frames = stories.remove(&story).unwrap_or_default();
            frames.sort();
            let distinct = frames.windows(2).all(|w| w[0] != w[1]);
            if frames.len() >= 2 && frames[0] == 0 && distinct {
                let id = self.chains.len() as u32 + 1;
                self.chains.insert(story, (id, frames));
            }
        }
        let mut out = String::new();
        for (pi, page) in doc.pages.iter().enumerate() {
            let mut drawings = Vec::new();
            for s in &page.shapes {
                self.shape(s, page.number, &mut drawings);
            }
            if drawings.is_empty() {
                drawings.push(String::new());
            }
            // one (1pt high) anchor paragraph per shape, so shapes can be deleted separately
            for (i, d) in drawings.iter().enumerate() {
                out.push_str("<w:p><w:pPr>");
                if i == 0 && pi > 0 {
                    out.push_str("<w:pageBreakBefore/>");
                }
                out.push_str("<w:spacing w:before=\"0\" w:after=\"0\" w:line=\"20\" w:lineRule=\"exact\"/><w:rPr><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr></w:pPr>");
                if !d.is_empty() {
                    out.push_str("<w:r><w:rPr><w:noProof/><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr>");
                    out.push_str(d);
                    out.push_str("</w:r>");
                }
                out.push_str("</w:p>");
            }
        }
        out
    }

    /// Appends the `<w:drawing>` elements for a shape (groups are flattened).
    fn shape(&mut self, s: &Shape, page: u32, out: &mut Vec<String>) {
        match s.kind.as_str() {
            "group" => {
                for c in &s.children {
                    let c = in_group(s, c);
                    self.shape(&c, page, out);
                }
            }
            "table" => {
                let Some(t) = &s.table else { return };
                let mut content = self.table(t, page, "left", 0.0);
                content.push_str(TINY_PARA);
                let f = Frame::of(s);
                // the text box would clip the outer half of the table's borders: make it a
                // little bigger than the table and inset the table by as much
                let pad = t.cells.iter().flat_map(|c| c.borders.iter().flatten()).map(|l| l.width).fold(0.0, f64::max) / 2.0 + 1.0;
                // rows may come out a little taller in Word: leave room below the table
                let extra = f.h * 0.25 + 12.0;
                let a = f.rotation.to_radians();
                // (growing downwards moves the centre the shape is rotated about)
                let (cx, cy) = (f.x + f.w / 2.0 - a.sin() * extra / 2.0, f.y + f.h / 2.0 + a.cos() * extra / 2.0);
                let (w2, h2) = (f.w + 2.0 * pad, f.h + 2.0 * pad + extra);
                let f2 = Frame { x: cx - w2 / 2.0, y: cy - h2 / 2.0, w: w2, h: h2, ..f };
                let body = format!(
                    "<wps:bodyPr rot=\"0\" vert=\"horz\" wrap=\"square\" lIns=\"{0}\" tIns=\"{0}\" rIns=\"0\" bIns=\"0\" anchor=\"t\" anchorCtr=\"0\"><a:noAutofit/></wps:bodyPr>",
                    emu(pad)
                );
                let g = format!(
                    "<wps:wsp><wps:cNvSpPr txBox=\"1\"/><wps:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>{}</w:txbxContent></wps:txbx>{}</wps:wsp>",
                    f2.xfrm(),
                    content,
                    body
                );
                out.push(self.anchor(&f2, &format!("Table {}", s.seq), NS_WPS, &g));
            }
            "line" => {
                let f = Frame::of(s);
                let g = format!(
                    "<wps:wsp><wps:cNvCnPr/><wps:spPr>{}{}<a:noFill/>{}{}</wps:spPr><wps:bodyPr/></wps:wsp>",
                    f.xfrm(),
                    geometry(s),
                    ln_xml(s.line.as_ref(), false),
                    shadow_xml(s.shadow.as_ref())
                );
                out.push(self.anchor(&f, &format!("Line {}", s.seq), NS_WPS, &g));
            }
            _ if s.wordart.is_some() => self.wordart(s, out),
            _ => {
                if s.image.is_some() && s.text.is_none() {
                    let f = Frame::of(s);
                    let g = self.pic(s, &f);
                    out.push(self.anchor(&f, &format!("Picture {}", s.seq), NS_PIC, &g));
                } else {
                    self.autoshape(s, page, out);
                }
            }
        }
    }

    fn pic(&mut self, s: &Shape, f: &Frame) -> String {
        let i = s.image.unwrap_or(0);
        if let Some(u) = self.used.get_mut(i) {
            *u = true;
        }
        let id = self.id();
        let mut g = format!(
            "<pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"image{i}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"rIdImg{i}\"/>{}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>{}{}",
            src_rect(s.crop.as_ref()),
            f.xfrm(),
            geometry(s)
        );
        match &s.fill {
            Some(fill) if fill.image.is_none() => g.push_str(&self.fill_xml(Some(fill))),
            _ => {}
        }
        if s.line.is_some() || s.shadow.is_some() {
            g.push_str(&ln_xml(s.line.as_ref(), inset_shape(s)));
        }
        g.push_str(&shadow_xml(s.shadow.as_ref()));
        g.push_str("</pic:spPr></pic:pic>");
        g
    }

    fn fill_xml(&mut self, f: Option<&Fill>) -> String {
        let Some(f) = f else { return "<a:noFill/>".into() };
        if let Some(i) = f.image {
            if i < self.used.len() {
                self.used[i] = true;
                return format!("<a:blipFill><a:blip r:embed=\"rIdImg{i}\"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>");
            }
        }
        let col = |c: &str| {
            if f.opacity < 1.0 {
                format!("<a:srgbClr val=\"{}\"><a:alpha val=\"{}\"/></a:srgbClr>", hex(c), (f.opacity.clamp(0.0, 1.0) * 100000.0).round() as i64)
            } else {
                format!("<a:srgbClr val=\"{}\"/>", hex(c))
            }
        };
        if let Some(c2) = &f.color2 {
            // model: 0 degrees runs bottom to top, clockwise; DrawingML: 0 runs left to right
            let ang = (f.angle - 90.0).rem_euclid(360.0);
            return format!(
                "<a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\">{}</a:gs><a:gs pos=\"100000\">{}</a:gs></a:gsLst><a:lin ang=\"{}\" scaled=\"0\"/></a:gradFill>",
                col(&f.color),
                col(c2),
                (ang * 60000.0).round() as i64
            );
        }
        format!("<a:solidFill>{}</a:solidFill>", col(&f.color))
    }

    /// Text boxes and autoshapes (with or without text).
    fn autoshape(&mut self, s: &Shape, page: u32, out: &mut Vec<String>) {
        let f = Frame::of(s);
        let is_tb = s.shape_type == 202;
        // text keeps clear of the outline: all of it when it's drawn inside the edge, half of it
        // when it's centred on the edge
        let lw = s.line.as_ref().map(|l| if l.inset && inset_shape(s) { l.width } else { l.width / 2.0 }).unwrap_or(0.0);
        let mut fill = s.fill.clone();
        if let (Some(i), None) = (s.image, &fill) {
            fill = Some(Fill { image: Some(i), opacity: 1.0, ..Default::default() });
        } else if let (Some(i), Some(fl)) = (s.image, &mut fill) {
            fl.image = Some(i);
        }
        let mut g = String::from("<wps:wsp>");
        g.push_str(if s.text.is_some() { "<wps:cNvSpPr txBox=\"1\"/>" } else { "<wps:cNvSpPr/>" });
        let _ = write!(
            g,
            "<wps:spPr>{}{}{}{}{}</wps:spPr>",
            f.xfrm(),
            geometry(s),
            self.fill_xml(fill.as_ref()),
            ln_xml(s.line.as_ref(), inset_shape(s)),
            shadow_xml(s.shadow.as_ref())
        );
        if let Some(t) = &s.text {
            let linked = self.chains.get(&t.story).cloned();
            match linked {
                Some((id, frames)) if t.chain > 0 => {
                    // a later frame of a chain: Word flows the story on into it
                    let seq = frames.iter().position(|c| *c == t.chain).unwrap_or(1);
                    let (_, body_pr) = self.text_body(t, s, lw, page, true);
                    let _ = write!(g, "<wps:linkedTxbx id=\"{id}\" seq=\"{seq}\"/>{body_pr}");
                }
                Some((id, _)) => {
                    let (content, body_pr) = self.text_body(t, s, lw, page, true);
                    let _ = write!(g, "<wps:txbx id=\"{id}\"><w:txbxContent>{content}</w:txbxContent></wps:txbx>{body_pr}");
                }
                None => {
                    let (content, body_pr) = self.text_body(t, s, lw, page, false);
                    let _ = write!(g, "<wps:txbx><w:txbxContent>{content}</w:txbxContent></wps:txbx>{body_pr}");
                }
            }
        } else {
            g.push_str("<wps:bodyPr/>");
        }
        g.push_str("</wps:wsp>");
        let name = if is_tb { "Text Box" } else { "Shape" };
        out.push(self.anchor(&f, &format!("{name} {}", s.seq), NS_WPS, &g));
    }

    /// WordArt: a text box holding the WordArt's text, one size for every line, centred and
    /// stretched to fill the shape the way Word stretches WordArt (a text warp); the shape's
    /// fill and outline become the text's.
    fn wordart(&mut self, s: &Shape, out: &mut Vec<String>) {
        let Some(wa) = &s.wordart else { return };
        let f = Frame::of(s);
        let lines: Vec<&str> = {
            let all: Vec<&str> = wa.text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
            let n = all.len();
            all.into_iter().filter(|l| !l.is_empty() || n == 1).collect()
        };
        if lines.iter().all(|l| l.trim().is_empty()) {
            return;
        }
        let n = lines.len().max(1) as f64;
        // a font Word won't have is drawn in Arial (as Publisher does), so the size fits
        let font = if cfg!(windows) && !wa.font.is_empty() && !self.m.installed(&wa.font) { "Arial".to_string() } else { wa.font.clone() };
        let widest = lines.iter().map(|l| self.m.text_width(&font, wa.bold, wa.italic, l)).fold(0.0, f64::max).max(0.1);
        let warp = wordart_warp(s.shape_type);
        // the size at which the widest line fills the width; Word stretches the height
        let fit = f.w / widest;
        // without stretching: the size at which Word's lines fill the height
        let by_height = f.h / n / self.m.font(&font, wa.bold, wa.italic).word.max(0.5);
        let (size, prst) = match (wa.stretch, warp) {
            (true, Some(p)) => (fit, Some(p)),
            (true, None) => (fit, Some("textPlain")),
            (false, _) => (by_height.min(fit), None),
        };
        let size = size.clamp(1.0, 1638.0);
        let mut rpr = String::from("<w:rPr>");
        let fe = esc(&font);
        let _ = write!(rpr, "<w:rFonts w:ascii=\"{fe}\" w:hAnsi=\"{fe}\" w:eastAsia=\"{fe}\" w:cs=\"{fe}\"/>");
        if wa.bold {
            rpr.push_str("<w:b/><w:bCs/>");
        }
        if wa.italic {
            rpr.push_str("<w:i/><w:iCs/>");
        }
        // letters can't be filled with a picture: use the picture's average colour
        let mut fill = s.fill.clone();
        if let Some(fl) = fill.as_mut() {
            if let Some(c) = fl.image.and_then(|i| self.image_color(i)) {
                fl.color = c;
                fl.color2 = None;
            }
            fl.image = None;
        }
        let solid = match &fill {
            Some(fl) => hex(&fl.color),
            None if s.line.is_none() => "000000".into(),
            None => "FFFFFF".into(),
        };
        let hp = ((size * 2.0).round() as i64).clamp(2, 3276);
        let _ = write!(rpr, "<w:color w:val=\"{solid}\"/><w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/>");
        rpr.push_str(&w14_effects(fill.as_ref(), s.line.as_ref(), s.shadow.as_ref()));
        rpr.push_str("</w:rPr>");
        let mut content = String::new();
        for l in &lines {
            let _ = write!(content, "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:jc w:val=\"center\"/>{rpr}</w:pPr>");
            if !l.is_empty() {
                let _ = write!(content, "<w:r>{rpr}{}</w:r>", text_xml(l, &font));
            }
            content.push_str("</w:p>");
        }
        let mut body = String::from("<wps:bodyPr rot=\"0\" vert=\"horz\" wrap=\"none\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"ctr\" anchorCtr=\"0\"");
        match prst {
            Some(p) => {
                let _ = write!(body, " fromWordArt=\"1\"><a:prstTxWarp prst=\"{p}\"><a:avLst/></a:prstTxWarp><a:noAutofit/></wps:bodyPr>");
            }
            None => body.push_str("><a:noAutofit/></wps:bodyPr>"),
        }
        let g = format!(
            "<wps:wsp><wps:cNvSpPr txBox=\"1\"/><wps:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>{content}</w:txbxContent></wps:txbx>{body}</wps:wsp>",
            f.xfrm()
        );
        out.push(self.anchor(&f, &format!("WordArt {}", s.seq), NS_WPS, &g));
    }

    /// The average colour ("#rrggbb") of a picture, weighted by its opacity.
    fn image_color(&mut self, i: usize) -> Option<String> {
        if let Some(c) = self.image_colors.get(&i) {
            return c.clone();
        }
        let c = self.images.get(i).and_then(|img| crate::images::rgba(&img.bytes)).and_then(|(px, _, _)| {
            let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 0.0);
            // (every few pixels is plenty)
            let step = ((px.len() / 4) / 20000).max(1);
            for p in px.chunks_exact(4).step_by(step) {
                let w = p[3] as f64 / 255.0;
                r += p[0] as f64 * w;
                g += p[1] as f64 * w;
                b += p[2] as f64 * w;
                a += w;
            }
            (a > 0.0).then(|| format!("#{:02x}{:02x}{:02x}", (r / a).round() as u8, (g / a).round() as u8, (b / a).round() as u8))
        });
        self.image_colors.insert(i, c.clone());
        c
    }

    /// The contents and `<wps:bodyPr>` of a text frame. `extra`: how far the outline keeps the
    /// text in from the margins (Word does that itself: half the line width, all of it for an
    /// outline drawn inside the edge - as Publisher does). `linked`: the frame is part of a
    /// chain of linked frames (its text may flow on to the next).
    fn text_body(&mut self, t: &TextBody, s: &Shape, extra: f64, page: u32, linked: bool) -> (String, String) {
        let mut ins = t.margins;
        let content = if t.rotate == 0.0 && t.columns <= 1 {
            let area = [ins[0] + extra, ins[1] + extra, ins[2] + extra, ins[3] + extra];
            let (paras, hidden) = self.layout_text(t, s.w, s.h, area, linked);
            self.flow(&paras, page, &hidden)
        } else {
            self.flow(&t.paras, page, &[])
        };
        let anchor = match t.valign.as_str() {
            "middle" => "ctr",
            "bottom" => "b",
            _ => "t",
        };
        // lines at the bottom may be a little lower than in Publisher: don't clip them early
        // (but text flowing on to a linked frame must leave this one where Publisher's does)
        if anchor == "t" && !linked {
            ins[3] = 0.0;
        }
        let vert = if t.rotate == 90.0 {
            "vert"
        } else if t.rotate == 270.0 {
            "vert270"
        } else {
            "horz"
        };
        let mut b = format!(
            "<wps:bodyPr rot=\"0\" vert=\"{vert}\" wrap=\"square\" lIns=\"{}\" tIns=\"{}\" rIns=\"{}\" bIns=\"{}\"",
            emu(ins[0]),
            emu(ins[1]),
            emu(ins[2]),
            emu(ins[3])
        );
        if t.columns > 1 {
            let _ = write!(b, " numCol=\"{}\" spcCol=\"{}\"", t.columns.min(16), emu(t.column_gap));
        }
        let _ = write!(b, " anchor=\"{anchor}\" anchorCtr=\"0\"><a:noAutofit/></wps:bodyPr>");
        (content, b)
    }

    /// Works out roughly where the paragraphs of a text frame fall, to emulate two things Word
    /// doesn't do: paragraphs are pushed below (or squeezed beside) the shapes the text wraps
    /// around, and paragraphs that start below the bottom of the frame are marked hidden (unless
    /// `linked`: then they flow on into the next frame, and are left as they are).
    fn layout_text(&mut self, t: &TextBody, w: f64, h: f64, ins: [f64; 4], linked: bool) -> (Vec<Para>, Vec<bool>) {
        let default_tab = if self.doc.default_tab > 1.0 { self.doc.default_tab } else { 36.0 };
        let (cl, cr) = (ins[0], (w - ins[2]).max(ins[0] + 1.0));
        struct R {
            x0: f64,
            x1: f64,
            y0: f64,
            y1: f64,
        }
        let rects: Vec<R> = t
            .wrap
            .iter()
            .map(|r| R { x0: r[0].max(cl), x1: r[2].min(cr), y0: r[1], y1: r[3] })
            .filter(|r| r.x1 - r.x0 > 0.5 && r.y1 > ins[1] + 2.0 && r.y0 < h)
            .collect();
        let mut paras = t.paras.clone();
        let mut hidden = vec![false; paras.len()];
        let middle = (cl + cr) / 2.0;
        let mut y = ins[1];
        let mut overflow = false;
        for (i, p) in paras.iter_mut().enumerate() {
            if overflow {
                hidden[i] = true;
                continue;
            }
            let obj = p.runs.iter().find_map(|r| r.object.as_deref());
            // Publisher tests a line against shapes by its text height, without the extra line
            // spacing underneath
            let th = match (obj, p.runs.first()) {
                (Some(o), _) => o.h,
                (None, Some(r)) => self.m.text_height(r),
                _ => 12.0,
            };
            // a picture alone on its line goes wherever the line has any room, overlapping the
            // shapes the text keeps clear of
            let lone = obj.map(|o| o.kind == "picture").unwrap_or(false)
                && p.runs.iter().filter(|r| r.object.is_some()).count() == 1
                && p.runs.iter().all(|r| r.object.is_some() || r.text.trim().is_empty());
            let need = match obj {
                _ if lone => 1.0,
                Some(o) => o.w,
                None => 40.0_f64.min(cr - cl),
            };
            let natural = y + p.before;
            let mut start = natural;
            let (mut el, mut er) = (0.0, 0.0);
            if !rects.is_empty() {
                for _ in 0..=rects.len() {
                    let (mut l, mut r) = (cl, cr);
                    let mut next = f64::INFINITY;
                    // (a line that just touches a shape still fits)
                    for b in rects.iter().filter(|b| b.y0 + 1.5 + th.min(40.0) * 0.1 < start + th && b.y1 > start + 0.5) {
                        if (b.x0 + b.x1) / 2.0 < middle {
                            l = l.max(b.x1);
                        } else {
                            r = r.min(b.x0);
                        }
                        next = next.min(b.y1);
                    }
                    if !next.is_finite() {
                        break;
                    }
                    if r - l >= need {
                        el = l - cl;
                        er = if lone { 0.0 } else { cr - r };
                        break;
                    }
                    start = next;
                }
            }
            if i > 0 && start + th.min(40.0) * 0.75 > h {
                if linked {
                    // the rest flows on into the next frame of the chain
                    break;
                }
                // Publisher doesn't show text that doesn't fit its frame
                overflow = true;
                hidden[i] = true;
                continue;
            }
            p.before += start - natural;
            // a shape pushes the text only where it reaches past the paragraph's own indents
            // (and a hanging first line, a bullet, stays clear of it too)
            let (left0, right0) = (p.left, p.right);
            let hang = (-p.first).max(0.0);
            p.left = if el > 0.0 { left0.max(el + hang) } else { left0 };
            p.right = right0.max(er);
            let first_left = p.left;
            let mut ph = self.m.para_height(p, cr - cl, default_tab);
            if obj.is_none() && !rects.is_empty() {
                // shapes beside the later lines of the paragraph
                let (mut l, mut r) = (cl + el, cr - er);
                let lh = p.runs.first().map(|r| self.m.line_height(p, r)).unwrap_or(th);
                let bottom = start + ph - (lh - th).max(0.0) - th.min(40.0) * 0.1;
                for b in rects.iter().filter(|b| b.y0 + 1.5 < bottom && b.y1 > start + th) {
                    if (b.x0 + b.x1) / 2.0 < middle {
                        l = l.max(b.x1);
                    } else {
                        r = r.min(b.x0);
                    }
                }
                if r - l >= need && (l > cl + el || r < cr - er) {
                    p.left = first_left.max(l - cl);
                    p.right = right0.max(cr - r);
                    ph = self.m.para_height(p, cr - cl, default_tab);
                }
            }
            y = start + ph + p.after;
        }
        (paras, hidden)
    }

    fn anchor(&mut self, f: &Frame, name: &str, uri: &str, graphic: &str) -> String {
        let id = self.id();
        let z = self.z;
        self.z += 1;
        let (x, y) = (f.x, f.y);
        format!(
            "<w:drawing><wp:anchor distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" simplePos=\"0\" relativeHeight=\"{}\" behindDoc=\"0\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/><wp:positionH relativeFrom=\"page\"><wp:posOffset>{}</wp:posOffset></wp:positionH><wp:positionV relativeFrom=\"page\"><wp:posOffset>{}</wp:posOffset></wp:positionV><wp:extent cx=\"{}\" cy=\"{}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:wrapNone/><wp:docPr id=\"{}\" name=\"{}\"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri=\"{}\">{}</a:graphicData></a:graphic></wp:anchor></w:drawing>",
            z * 1024,
            emu(x),
            emu(y),
            emu(f.w),
            emu(f.h),
            id,
            esc(name),
            uri,
            graphic
        )
    }

    // ---- text --------------------------------------------------------------------------------

    /// Block-level content (paragraphs and inline tables); always ends with a paragraph.
    /// `hidden[i]` marks paragraphs that are kept as hidden text.
    fn flow(&mut self, paras: &[Para], page: u32, hidden: &[bool]) -> String {
        let mut out = String::new();
        let mut ends_with_table = false;
        let mut lists = ListState::default();
        for (i, p) in paras.iter().enumerate() {
            let hide = hidden.get(i).copied().unwrap_or(false);
            let num = self.list_of(p, &mut lists);
            // space after the last paragraph doesn't count towards the height of the text
            if i + 1 == paras.len() && p.after != 0.0 {
                let last = Para { after: 0.0, ..p.clone() };
                self.para(&last, page, hide, num, &mut out, &mut ends_with_table);
            } else {
                self.para(p, page, hide, num, &mut out, &mut ends_with_table);
            }
        }
        if paras.is_empty() || ends_with_table {
            out.push_str(TINY_PARA);
        }
        out
    }

    /// The Word list (numId) a paragraph's number belongs to. Consecutive numbered paragraphs
    /// with the same format and left indent count up; empty paragraphs between them don't end
    /// the list, other paragraphs do.
    fn list_of(&mut self, p: &Para, st: &mut ListState) -> Option<u32> {
        let Some(b) = &p.bullet else {
            if p.runs.iter().any(|r| !r.text.is_empty() || r.object.is_some()) {
                st.cur = None;
            }
            return None;
        };
        let Some(fmt) = b.number else {
            if p.runs.iter().any(|r| !r.text.is_empty() || r.object.is_some()) {
                st.cur = None;
            }
            return None;
        };
        let first = p.runs.first()?;
        if let Some((f, left, id)) = st.cur {
            if f == fmt && (left - p.left).abs() < 0.01 && b.start.is_none() {
                return Some(id);
            }
        }
        self.lists.push(ListDef {
            fmt,
            sep: b.separator.clone(),
            start: b.start.unwrap_or(1),
            left: p.left,
            first: p.first,
            font: first.font.clone(),
            size: first.size,
            color: first.color.clone(),
            bold: first.bold,
        });
        let id = self.lists.len() as u32;
        st.cur = Some((fmt, p.left, id));
        Some(id)
    }

    /// The numbering part: one single-level list definition per list.
    fn numbering_xml(&self) -> Option<String> {
        if self.lists.is_empty() {
            return None;
        }
        let mut o = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:numbering xmlns:w=\"{NS_W}\">");
        for (i, l) in self.lists.iter().enumerate() {
            let (kind, text) = num_format(l.fmt, l.sep.as_deref());
            let _ = write!(
                o,
                "<w:abstractNum w:abstractNumId=\"{i}\"><w:multiLevelType w:val=\"singleLevel\"/><w:lvl w:ilvl=\"0\"><w:start w:val=\"{}\"/><w:numFmt w:val=\"{kind}\"/><w:suff w:val=\"{}\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\"",
                l.start,
                if l.first < 0.0 { "tab" } else { "nothing" },
                esc(&text),
                tw(l.left)
            );
            if l.first < 0.0 {
                let _ = write!(o, " w:hanging=\"{}\"", tw(-l.first));
            } else if l.first > 0.0 {
                let _ = write!(o, " w:firstLine=\"{}\"", tw(l.first));
            }
            o.push_str("/></w:pPr><w:rPr>");
            if !l.font.is_empty() {
                let f = esc(&l.font);
                let _ = write!(o, "<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:eastAsia=\"{f}\" w:cs=\"{f}\"/>");
            }
            o.push_str(if l.bold { "<w:b/><w:bCs/>" } else { "<w:b w:val=\"0\"/><w:bCs w:val=\"0\"/>" });
            o.push_str("<w:i w:val=\"0\"/><w:iCs w:val=\"0\"/>");
            if !l.color.is_empty() {
                let _ = write!(o, "<w:color w:val=\"{}\"/>", hex(&l.color));
            }
            if l.size > 0.0 {
                let hp = ((l.size * 2.0).round() as i64).clamp(2, 3276);
                let _ = write!(o, "<w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/>");
            }
            o.push_str("<w:u w:val=\"none\"/><w:vertAlign w:val=\"baseline\"/></w:rPr></w:lvl></w:abstractNum>");
        }
        for i in 0..self.lists.len() {
            let _ = write!(o, "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{i}\"/></w:num>", i + 1);
        }
        o.push_str("</w:numbering>");
        Some(o)
    }

    fn para(&mut self, p: &Para, page: u32, hide: bool, num: Option<u32>, out: &mut String, ends_with_table: &mut bool) {
        let mark = p.runs.last();
        let mut runs = String::new();
        let mut piece = 0;
        let mut emitted_table = false;
        let k = self.m.line_factor(p);
        let adjusted;
        let p = if k != 1.0 {
            adjusted = Para { spacing: p.spacing * k, ..p.clone() };
            &adjusted
        } else {
            p
        };
        if let (Some(b), Some(first)) = (&p.bullet, p.runs.first()) {
            if !b.text.is_empty() && b.number.is_none() {
                let brun = Run {
                    text: b.text.clone(),
                    font: b.font.clone().unwrap_or_else(|| first.font.clone()),
                    size: first.size,
                    color: first.color.clone(),
                    ..Default::default()
                };
                let _ = write!(runs, "<w:r>{}{}", rpr(&brun, hide), text_xml(&brun.text, &brun.font));
                if p.first < 0.0 {
                    runs.push_str("<w:tab/>");
                }
                runs.push_str("</w:r>");
            }
        }
        for r in &p.runs {
            if let Some(o) = &r.object {
                if let (Some(t), "table") = (&o.table, o.kind.as_str()) {
                    if !runs.is_empty() {
                        out.push_str(&para_xml(p, mark, &runs, piece, hide, num));
                        runs.clear();
                    } else if piece == 0 && p.before >= 0.5 {
                        // a table can't have space above it
                        out.push_str(&spacer(p.before));
                    }
                    piece += 1;
                    let indent = if emitted_table { 0.0 } else { p.left + p.first };
                    out.push_str(&self.table(t, page, &p.align, indent));
                    emitted_table = true;
                    *ends_with_table = true;
                } else if o.image.is_some() {
                    let f = Frame { x: 0.0, y: 0.0, ..Frame::of(o) };
                    let g = self.pic(o, &f);
                    let id = self.id();
                    let _ = write!(
                        runs,
                        "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{}\" cy=\"{}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:docPr id=\"{}\" name=\"Picture {}\"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri=\"{}\">{}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>",
                        emu(f.w),
                        emu(f.h),
                        id,
                        o.seq,
                        NS_PIC,
                        g
                    );
                }
                continue;
            }
            if r.field.as_deref() == Some("page") {
                if self.page_field {
                    let _ = write!(runs, "<w:fldSimple w:instr=\" PAGE \"><w:r>{}<w:t>{}</w:t></w:r></w:fldSimple>", rpr(r, hide), page);
                } else {
                    let _ = write!(runs, "<w:r>{}<w:t>{}</w:t></w:r>", rpr(r, hide), page);
                }
                continue;
            }
            if r.text.is_empty() {
                continue;
            }
            let _ = write!(runs, "<w:r>{}{}</w:r>", rpr(r, hide), text_xml(&r.text, &r.font));
        }
        if !runs.is_empty() || !emitted_table {
            out.push_str(&para_xml(p, mark, &runs, piece, hide, num));
            *ends_with_table = false;
        } else if p.after >= 0.5 {
            // the paragraph was nothing but the table: keep its space after
            out.push_str(&spacer(p.after));
            *ends_with_table = false;
        }
    }

    // ---- tables ------------------------------------------------------------------------------

    fn table(&mut self, t: &Table, page: u32, align: &str, indent: f64) -> String {
        let (nr, nc) = (t.rows.len(), t.cols.len());
        if nr == 0 || nc == 0 {
            return String::new();
        }
        // which cell covers each grid position
        let mut grid: Vec<Option<usize>> = vec![None; nr * nc];
        let mut order: Vec<usize> = (0..t.cells.len()).collect();
        order.sort_by_key(|&i| (t.cells[i].r0, t.cells[i].c0));
        let mut span: Vec<(usize, usize, usize, usize)> = vec![(0, 0, 0, 0); t.cells.len()];
        // borders on the grid lines: a line is drawn when either neighbour asks for it
        let mut hedge: Vec<Option<&Line>> = vec![None; (nr + 1) * nc];
        let mut vedge: Vec<Option<&Line>> = vec![None; nr * (nc + 1)];
        fn put<'l>(slot: &mut Option<&'l Line>, l: &'l Line) {
            if slot.map(|o| o.width < l.width).unwrap_or(true) {
                *slot = Some(l);
            }
        }
        for &i in &order {
            let c = &t.cells[i];
            let (r0, c0) = (c.r0 as usize, c.c0 as usize);
            if r0 >= nr || c0 >= nc || grid[r0 * nc + c0].is_some() {
                continue;
            }
            let (r1, c1) = ((c.r1 as usize).clamp(r0, nr - 1), (c.c1 as usize).clamp(c0, nc - 1));
            // don't run into cells that were placed already
            let mut c1 = c1;
            for k in c0..=c1 {
                if grid[r0 * nc + k].is_some() {
                    c1 = k - 1;
                    break;
                }
            }
            span[i] = (r0, r1, c0, c1);
            for r in r0..=r1 {
                for k in c0..=c1 {
                    if grid[r * nc + k].is_none() {
                        grid[r * nc + k] = Some(i);
                    }
                }
            }
            for r in r0..=r1 {
                if let Some(l) = &c.borders[0] {
                    put(&mut vedge[r * (nc + 1) + c0], l);
                }
                if let Some(l) = &c.borders[2] {
                    put(&mut vedge[r * (nc + 1) + c1 + 1], l);
                }
            }
            for k in c0..=c1 {
                if let Some(l) = &c.borders[1] {
                    put(&mut hedge[r0 * nc + k], l);
                }
                if let Some(l) = &c.borders[3] {
                    put(&mut hedge[(r1 + 1) * nc + k], l);
                }
            }
        }

        let total: f64 = t.cols.iter().sum();
        let mut o = String::from("<w:tbl><w:tblPr>");
        let _ = write!(o, "<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", tw(total));
        match align {
            "center" => o.push_str("<w:jc w:val=\"center\"/>"),
            "right" => o.push_str("<w:jc w:val=\"right\"/>"),
            _ => {}
        }
        let _ = write!(o, "<w:tblInd w:w=\"{}\" w:type=\"dxa\"/>", if matches!(align, "center" | "right") { 0 } else { tw(indent) });
        o.push_str("<w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"0\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"0\" w:type=\"dxa\"/></w:tblCellMar><w:tblLook w:val=\"0000\"/></w:tblPr><w:tblGrid>");
        for w in &t.cols {
            let _ = write!(o, "<w:gridCol w:w=\"{}\"/>", tw(*w));
        }
        o.push_str("</w:tblGrid>");
        for r in 0..nr {
            // Word's row height doesn't include the cells' top and bottom margins
            let mut vm: f64 = 0.0;
            for k in 0..nc {
                if let Some(i) = grid[r * nc + k] {
                    vm = vm.max(t.cells[i].margins[1] + t.cells[i].margins[3]);
                }
            }
            // (nor the border)
            let bw = (0..nc).filter_map(|k| hedge[(r + 1) * nc + k]).map(|l| l.width).fold(0.0, f64::max);
            let _ = write!(o, "<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val=\"{}\" w:hRule=\"atLeast\"/></w:trPr>", tw(t.rows[r] - vm - bw).max(1));
            let mut k = 0;
            while k < nc {
                let owner = grid[r * nc + k];
                let (r0, r1, c0, c1) = match owner {
                    Some(i) => span[i],
                    None => (r, r, k, k),
                };
                // (a cell whose columns were partly taken by another one)
                let c1 = c1.max(k);
                let c0 = c0.max(k).min(c1);
                let width: f64 = t.cols[c0..=c1].iter().sum();
                let _ = write!(o, "<w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/>", tw(width));
                if c1 > c0 {
                    let _ = write!(o, "<w:gridSpan w:val=\"{}\"/>", c1 - c0 + 1);
                }
                if r1 > r0 {
                    o.push_str(if r == r0 { "<w:vMerge w:val=\"restart\"/>" } else { "<w:vMerge/>" });
                }
                let mut b = String::new();
                if r == r0 {
                    border(&mut b, "top", hedge[r * nc + c0]);
                }
                border(&mut b, "left", vedge[r * (nc + 1) + c0]);
                if r == r1 {
                    border(&mut b, "bottom", hedge[(r + 1) * nc + c0]);
                }
                border(&mut b, "right", vedge[r * (nc + 1) + c1 + 1]);
                if !b.is_empty() {
                    let _ = write!(o, "<w:tcBorders>{b}</w:tcBorders>");
                }
                let cell: Option<&Cell> = owner.map(|i| &t.cells[i]);
                if let Some(c) = cell {
                    if let Some(f) = &c.fill {
                        if f.opacity > 0.0 {
                            let _ = write!(o, "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", hex(&f.color));
                        }
                    }
                    let m = c.margins;
                    let _ = write!(
                        o,
                        "<w:tcMar><w:top w:w=\"{}\" w:type=\"dxa\"/><w:left w:w=\"{}\" w:type=\"dxa\"/><w:bottom w:w=\"{}\" w:type=\"dxa\"/><w:right w:w=\"{}\" w:type=\"dxa\"/></w:tcMar>",
                        tw(m[1]),
                        tw(m[0]),
                        tw(m[3]),
                        tw(m[2])
                    );
                    match c.valign.as_str() {
                        "middle" => o.push_str("<w:vAlign w:val=\"center\"/>"),
                        "bottom" => o.push_str("<w:vAlign w:val=\"bottom\"/>"),
                        _ => {}
                    }
                }
                o.push_str("</w:tcPr>");
                match cell {
                    Some(c) if r == r0 => {
                        // Publisher doesn't count the extra line spacing under the last line
                        // towards the height of the cell
                        let single = match c.paras.last() {
                            Some(p) if !p.spacing_exact && p.spacing > 1.0 && p.runs.iter().all(|r| r.object.is_none()) => {
                                let default_tab = if self.doc.default_tab > 1.0 { self.doc.default_tab } else { 36.0 };
                                let lh = p.runs.first().map(|r| self.m.line_height(p, r)).unwrap_or(0.0);
                                let ph = self.m.para_height(p, width - c.margins[0] - c.margins[2], default_tab);
                                lh > 0.0 && ph <= lh * 1.05
                            }
                            _ => false,
                        };
                        if single {
                            let mut paras = c.paras.clone();
                            if let Some(p) = paras.last_mut() {
                                p.spacing = 1.0;
                            }
                            o.push_str(&self.flow(&paras, page, &[]));
                        } else {
                            o.push_str(&self.flow(&c.paras, page, &[]));
                        }
                    }
                    _ => o.push_str(TINY_PARA),
                }
                o.push_str("</w:tc>");
                k = c1 + 1;
            }
            o.push_str("</w:tr>");
        }
        o.push_str("</w:tbl>");
        o
    }
}

/// An empty paragraph that takes (almost) no room: Word wants one after a table.
const TINY_PARA: &str = "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"20\" w:lineRule=\"exact\"/><w:rPr><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr></w:pPr></w:p>";

fn border(o: &mut String, side: &str, l: Option<&Line>) {
    if let Some(l) = l {
        let sz = ((l.width * 8.0).round() as i64).clamp(2, 96);
        let val = match l.dash {
            0 => "single",
            2 | 5 => "dotted",
            _ => "dashed",
        };
        let _ = write!(o, "<w:{side} w:val=\"{val}\" w:sz=\"{sz}\" w:space=\"0\" w:color=\"{}\"/>", hex(&l.color));
    }
}

/// An empty paragraph `height` points high.
fn spacer(height: f64) -> String {
    format!(
        "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"{}\" w:lineRule=\"exact\"/><w:rPr><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr></w:pPr></w:p>",
        tw(height).max(20)
    )
}

fn rpr(r: &Run, hide: bool) -> String {
    let mut o = String::from("<w:rPr>");
    if !r.font.is_empty() {
        let f = esc(&r.font);
        let _ = write!(o, "<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:eastAsia=\"{f}\" w:cs=\"{f}\"/>");
    }
    if r.bold {
        o.push_str("<w:b/><w:bCs/>");
    }
    if r.italic {
        o.push_str("<w:i/><w:iCs/>");
    }
    if hide {
        o.push_str("<w:vanish/>");
    }
    if !r.color.is_empty() {
        let _ = write!(o, "<w:color w:val=\"{}\"/>", hex(&r.color));
    }
    if r.size > 0.0 {
        let hp = ((r.size * 2.0).round() as i64).clamp(2, 3276);
        let _ = write!(o, "<w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/>");
    }
    if r.underline {
        o.push_str("<w:u w:val=\"single\"/>");
    }
    if r.strike {
        o.push_str("<w:strike/>");
    }
    match r.effect {
        1 => o.push_str("<w:outline/>"),
        2 => o.push_str("<w:emboss/>"),
        3 => o.push_str("<w:imprint/>"),
        _ => {}
    }
    match r.caps {
        1 => o.push_str("<w:smallCaps/>"),
        2 => o.push_str("<w:caps/>"),
        _ => {}
    }
    // character spacing: Word has a fixed amount per character (twentieths of a point); tracking
    // scales each character's width, about half the font size on average
    let extra = r.kerning + if r.tracking > 0.0 { (r.tracking - 1.0) * 0.5 * r.size } else { 0.0 };
    if extra.abs() >= 0.05 {
        let _ = write!(o, "<w:spacing w:val=\"{}\"/>", ((extra * 20.0).round() as i64).clamp(-31680, 31680));
    }
    match r.script {
        1 => o.push_str("<w:vertAlign w:val=\"superscript\"/>"),
        2 => o.push_str("<w:vertAlign w:val=\"subscript\"/>"),
        _ => {}
    }
    o.push_str("</w:rPr>");
    o
}

/// The children of a `<w:r>` for a piece of text: text, tabs, line breaks, symbols.
fn text_xml(text: &str, font: &str) -> String {
    let mut o = String::new();
    let symbol = is_symbol_font(font);
    let mut buf = String::new();
    let flush = |buf: &mut String, o: &mut String| {
        if !buf.is_empty() {
            let _ = write!(o, "<w:t xml:space=\"preserve\">{}</w:t>", esc(buf));
            buf.clear();
        }
    };
    for c in text.chars() {
        match c {
            '\t' => {
                flush(&mut buf, &mut o);
                o.push_str("<w:tab/>");
            }
            '\n' | '\u{b}' => {
                flush(&mut buf, &mut o);
                o.push_str("<w:br/>");
            }
            '\r' => {}
            c if symbol && (0x20..=0xff).contains(&(c as u32)) && c != ' ' => {
                flush(&mut buf, &mut o);
                let _ = write!(o, "<w:sym w:font=\"{}\" w:char=\"{:04X}\"/>", esc(font), 0xf000 + c as u32);
            }
            c => buf.push(c),
        }
    }
    flush(&mut buf, &mut o);
    o
}

/// One `<w:p>`. `piece` counts the parts a paragraph was split into around inline tables.
/// `num`: the Word list the paragraph's number comes from.
fn para_xml(p: &Para, mark: Option<&Run>, runs: &str, piece: usize, hide: bool, num: Option<u32>) -> String {
    let mut o = String::from("<w:p><w:pPr>");
    if let (Some(id), 0) = (num, piece) {
        let _ = write!(o, "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"{id}\"/></w:numPr>");
    }
    if !p.tabs.is_empty() {
        o.push_str("<w:tabs>");
        let mut tabs: Vec<_> = p.tabs.iter().collect();
        tabs.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap_or(std::cmp::Ordering::Equal));
        for t in tabs {
            let val = match t.align.as_str() {
                "center" => "center",
                "right" => "right",
                "decimal" => "decimal",
                _ => "left",
            };
            let _ = write!(o, "<w:tab w:val=\"{val}\"");
            match t.leader {
                Some('.') => o.push_str(" w:leader=\"dot\""),
                Some('-') => o.push_str(" w:leader=\"hyphen\""),
                Some('_') => o.push_str(" w:leader=\"underscore\""),
                Some('\u{b7}') => o.push_str(" w:leader=\"middleDot\""),
                _ => {}
            }
            let _ = write!(o, " w:pos=\"{}\"/>", tw(t.pos));
        }
        o.push_str("</w:tabs>");
    }
    let before = if piece == 0 { p.before } else { 0.0 };
    let _ = write!(o, "<w:spacing w:before=\"{}\" w:after=\"{}\"", tw(before).max(0), tw(p.after).max(0));
    if p.spacing_exact {
        let _ = write!(o, " w:line=\"{}\" w:lineRule=\"exact\"/>", tw(p.spacing).max(1));
    } else {
        let _ = write!(o, " w:line=\"{}\" w:lineRule=\"auto\"/>", ((p.spacing * 240.0).round() as i64).max(1));
    }
    let _ = write!(o, "<w:ind w:left=\"{}\" w:right=\"{}\"", tw(p.left), tw(p.right));
    if p.first > 0.0 {
        let _ = write!(o, " w:firstLine=\"{}\"", tw(p.first));
    } else if p.first < 0.0 {
        let _ = write!(o, " w:hanging=\"{}\"", tw(-p.first));
    }
    o.push_str("/>");
    let jc = match p.align.as_str() {
        "center" => "center",
        "right" => "right",
        "justify" => "both",
        _ => "left",
    };
    let _ = write!(o, "<w:jc w:val=\"{jc}\"/>");
    if let Some(m) = mark {
        o.push_str(&rpr(m, hide));
    }
    o.push_str("</w:pPr>");
    o.push_str(runs);
    o.push_str("</w:p>");
    o
}

// ---- drawing ---------------------------------------------------------------------------------

fn src_rect(crop: Option<&[f64; 4]>) -> String {
    match crop {
        Some(c) if c.iter().any(|v| v.abs() > 1e-6) => {
            let v = |x: f64| (x * 100000.0).round() as i64;
            format!("<a:srcRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/>", v(c[0]), v(c[1]), v(c[2]), v(c[3]))
        }
        _ => String::new(),
    }
}

/// Publisher keeps an inset outline inside the edge of closed shapes (rectangles, frames, rounded
/// rectangles, callouts...); lines and connectors have no inside. (Same rule as web/render.js.)
fn inset_shape(s: &Shape) -> bool {
    s.kind != "line" && !matches!(s.shape_type, 20 | 32..=40)
}

/// `<a:srgbClr>` with an opacity.
fn color_xml(c: &str, opacity: f64) -> String {
    if opacity < 1.0 {
        format!("<a:srgbClr val=\"{}\"><a:alpha val=\"{}\"/></a:srgbClr>", hex(c), (opacity.clamp(0.0, 1.0) * 100000.0).round() as i64)
    } else {
        format!("<a:srgbClr val=\"{}\"/>", hex(c))
    }
}

/// Distance and direction (DrawingML units) of a shadow offset.
fn shadow_offset(sh: &Shadow) -> Option<(i64, i64)> {
    let dist = sh.dx.hypot(sh.dy);
    if !(dist > 0.01) {
        return None;
    }
    let dir = sh.dy.atan2(sh.dx).to_degrees().rem_euclid(360.0);
    Some((emu(dist), ((dir * 60000.0).round() as i64).rem_euclid(21_600_000)))
}

/// A hard drop shadow (no blur), as an effect list for `<*:spPr>`.
fn shadow_xml(sh: Option<&Shadow>) -> String {
    let Some(sh) = sh else { return String::new() };
    let Some((dist, dir)) = shadow_offset(sh) else { return String::new() };
    format!("<a:effectLst><a:outerShdw dist=\"{dist}\" dir=\"{dir}\" algn=\"tl\" rotWithShape=\"1\">{}</a:outerShdw></a:effectLst>", color_xml(&sh.color, sh.opacity))
}

/// Word 2010 text effects for WordArt letters: the shape's shadow, outline and fill.
fn w14_effects(fill: Option<&Fill>, line: Option<&Line>, shadow: Option<&Shadow>) -> String {
    let clr = |c: &str, opacity: f64| {
        if opacity < 1.0 {
            format!("<w14:srgbClr w14:val=\"{}\"><w14:alpha w14:val=\"{}\"/></w14:srgbClr>", hex(c), (opacity.clamp(0.0, 1.0) * 100000.0).round() as i64)
        } else {
            format!("<w14:srgbClr w14:val=\"{}\"/>", hex(c))
        }
    };
    let mut o = String::new();
    if let Some((sh, (dist, dir))) = shadow.and_then(|sh| shadow_offset(sh).map(|d| (sh, d))) {
        let _ = write!(
            o,
            "<w14:shadow w14:blurRad=\"0\" w14:dist=\"{dist}\" w14:dir=\"{dir}\" w14:sx=\"100000\" w14:sy=\"100000\" w14:kx=\"0\" w14:ky=\"0\" w14:algn=\"tl\">{}</w14:shadow>",
            clr(&sh.color, sh.opacity)
        );
    }
    if let Some(l) = line {
        let dash = match l.dash {
            0 => "solid",
            2 | 5 => "sysDot",
            _ => "sysDash",
        };
        let _ = write!(
            o,
            "<w14:textOutline w14:w=\"{}\" w14:cap=\"flat\" w14:cmpd=\"sng\" w14:algn=\"ctr\"><w14:solidFill>{}</w14:solidFill><w14:prstDash w14:val=\"{dash}\"/><w14:round/></w14:textOutline>",
            emu(l.width).max(0),
            clr(&l.color, 1.0)
        );
    }
    match fill {
        Some(f) => match &f.color2 {
            Some(c2) if f.image.is_none() => {
                let ang = (f.angle - 90.0).rem_euclid(360.0);
                let _ = write!(
                    o,
                    "<w14:textFill><w14:gradFill><w14:gsLst><w14:gs w14:pos=\"0\">{}</w14:gs><w14:gs w14:pos=\"100000\">{}</w14:gs></w14:gsLst><w14:lin w14:ang=\"{}\" w14:scaled=\"0\"/></w14:gradFill></w14:textFill>",
                    clr(&f.color, f.opacity),
                    clr(c2, f.opacity),
                    (ang * 60000.0).round() as i64
                );
            }
            _ => {
                let _ = write!(o, "<w14:textFill><w14:solidFill>{}</w14:solidFill></w14:textFill>", clr(&f.color, f.opacity));
            }
        },
        None if line.is_some() => o.push_str("<w14:textFill><w14:noFill/></w14:textFill>"),
        None => {}
    }
    o
}

/// Word's text warp for a WordArt shape type (Escher 136-175).
fn wordart_warp(t: u16) -> Option<&'static str> {
    Some(match t {
        136 => "textPlain",
        137 => "textStop",
        138 => "textTriangle",
        139 => "textTriangleInverted",
        140 => "textChevron",
        141 => "textChevronInverted",
        142 => "textRingInside",
        143 => "textRingOutside",
        144 => "textArchUp",
        145 => "textArchDown",
        146 => "textCircle",
        147 => "textButton",
        148 => "textArchUpPour",
        149 => "textArchDownPour",
        150 => "textCirclePour",
        151 => "textButtonPour",
        152 => "textCurveUp",
        153 => "textCurveDown",
        154 => "textCascadeUp",
        155 => "textCascadeDown",
        156 => "textWave1",
        157 => "textWave2",
        158 => "textDoubleWave1",
        159 => "textWave4",
        160 => "textInflate",
        161 => "textDeflate",
        162 => "textInflateBottom",
        163 => "textDeflateBottom",
        164 => "textInflateTop",
        165 => "textDeflateTop",
        166 => "textDeflateInflate",
        167 => "textDeflateInflateDeflate",
        168 => "textFadeRight",
        169 => "textFadeLeft",
        170 => "textFadeUp",
        171 => "textFadeDown",
        172 => "textSlantUp",
        173 => "textSlantDown",
        174 => "textCanUp",
        175 => "textCanDown",
        _ => return None,
    })
}

/// `<a:ln>`. `inset_ok`: the shape is one whose outline Publisher may draw inside its edge.
fn ln_xml(l: Option<&Line>, inset_ok: bool) -> String {
    let Some(l) = l else { return "<a:ln><a:noFill/></a:ln>".into() };
    let mut o = format!("<a:ln w=\"{}\"", emu(l.width).max(0));
    let cmpd = match l.compound {
        1 => "dbl",
        2 => "thickThin",
        3 => "thinThick",
        4 => "tri",
        _ => "",
    };
    if !cmpd.is_empty() {
        let _ = write!(o, " cmpd=\"{cmpd}\"");
    }
    if l.inset && inset_ok {
        o.push_str(" algn=\"in\"");
    }
    let _ = write!(o, "><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>", hex(&l.color));
    let dash = match l.dash {
        1 => "sysDash",
        2 => "sysDot",
        3 => "sysDashDot",
        4 => "sysDashDotDot",
        5 => "dot",
        6 => "dash",
        7 => "lgDash",
        8 => "dashDot",
        9 => "lgDashDot",
        10 => "lgDashDotDot",
        _ => "",
    };
    if !dash.is_empty() {
        let _ = write!(o, "<a:prstDash val=\"{dash}\"/>");
    }
    o.push_str("<a:miter lim=\"800000\"/>");
    let arrow = |n: u32| match n {
        2 => "stealth",
        3 => "diamond",
        4 => "oval",
        5 => "arrow",
        _ => "triangle",
    };
    let size = |n: u32| match n {
        0 => "sm",
        2 => "lg",
        _ => "med",
    };
    if l.start_arrow != 0 {
        let _ = write!(o, "<a:headEnd type=\"{}\" w=\"{}\" len=\"{}\"/>", arrow(l.start_arrow), size(l.start_arrow_w), size(l.start_arrow_l));
    }
    if l.end_arrow != 0 {
        let _ = write!(o, "<a:tailEnd type=\"{}\" w=\"{}\" len=\"{}\"/>", arrow(l.end_arrow), size(l.end_arrow_w), size(l.end_arrow_l));
    }
    o.push_str("</a:ln>");
    o
}

/// Outline of an autoshape: a preset where there is a good match, the freeform path when the
/// shape has one, a rectangle otherwise.
fn geometry(s: &Shape) -> String {
    if let Some(p) = &s.path {
        if let Some(g) = cust_geom(&p.d, &p.geo) {
            return g;
        }
    }
    // Escher (VML) adjust values are in a 21600 x 21600 box; DrawingML's are fractions x 100000,
    // many of them of the shorter side
    let adj = |i: usize, d: f64| s.adjust.get(i).copied().flatten().map(|v| v as f64).unwrap_or(d);
    let (w, h) = (s.w.max(0.01), s.h.max(0.01));
    let ss = w.min(h);
    const K: f64 = 100000.0 / 21600.0;
    let gd = |name: &str, v: f64| format!("<a:gd name=\"{name}\" fmla=\"val {}\"/>", v.round() as i64);
    let one = |v: f64| gd("adj", v);
    let two = |a: f64, b: f64| gd("adj1", a) + &gd("adj2", b);
    let three = |a: f64, b: f64, c: f64| gd("adj1", a) + &gd("adj2", b) + &gd("adj3", c);
    // shaft thickness and head length of the block arrows
    let shaft = |v: f64| ((1.0 - 2.0 * v / 21600.0) * 100000.0).clamp(0.0, 100000.0);
    // the point of a speech bubble, relative to the centre
    let tip = |dx: f64, dy: f64| ((adj(0, dx) / 21600.0 - 0.5) * 100000.0, (adj(1, dy) / 21600.0 - 0.5) * 100000.0);
    let (prst, av): (&str, String) = match s.shape_type {
        2 => ("roundRect", one((adj(0, 3600.0) * K).clamp(0.0, 50000.0))),
        3 => ("ellipse", String::new()),
        4 => ("diamond", String::new()),
        5 => ("triangle", one((adj(0, 10800.0) * K).clamp(0.0, 100000.0))),
        6 => ("rtTriangle", String::new()),
        7 => ("parallelogram", one(adj(0, 5400.0) * K * w / ss)),
        8 => {
            // Office's trapezoid is wide at the top (DrawingML's is narrow there)
            let x = (adj(0, 5400.0) / 21600.0 * w).clamp(0.0, w / 2.0);
            return poly(w, h, &[(0.0, 0.0), (w, 0.0), (w - x, h), (x, h)]);
        }
        9 => ("hexagon", gd("adj", adj(0, 5400.0) * K * w / ss) + &gd("vf", 115470.0)),
        10 => ("octagon", one(adj(0, 6326.0) * K)),
        11 => ("plus", one(adj(0, 5400.0) * K)),
        12 => ("star5", String::new()),
        13 | 14 => ("rightArrow", two(shaft(adj(1, 5400.0)), ((21600.0 - adj(0, 16200.0)) * K * w / ss).max(0.0))),
        15 => ("homePlate", one((21600.0 - adj(0, 16200.0)) * K * w / ss)),
        16 => ("cube", one(adj(0, 5400.0) * K)),
        // (a balloon: its point is where a speech bubble's is by default)
        17 => ("wedgeRoundRectCallout", three(-43750.0, 70000.0, 16667.0)),
        19 => {
            // a quarter of an ellipse centred on the bottom left corner, filled like a pie
            let (pw, ph) = (emu(w).max(1), emu(h).max(1));
            return format!(
                "<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l=\"0\" t=\"0\" r=\"r\" b=\"b\"/><a:pathLst><a:path w=\"{pw}\" h=\"{ph}\" stroke=\"0\"><a:moveTo><a:pt x=\"0\" y=\"{ph}\"/></a:moveTo><a:lnTo><a:pt x=\"0\" y=\"0\"/></a:lnTo><a:arcTo wR=\"{pw}\" hR=\"{ph}\" stAng=\"16200000\" swAng=\"5400000\"/><a:close/></a:path><a:path w=\"{pw}\" h=\"{ph}\" fill=\"none\"><a:moveTo><a:pt x=\"0\" y=\"0\"/></a:moveTo><a:arcTo wR=\"{pw}\" hR=\"{ph}\" stAng=\"16200000\" swAng=\"5400000\"/></a:path></a:pathLst></a:custGeom>"
            );
        }
        20 => ("line", String::new()),
        21 => ("plaque", one(adj(0, 3600.0) * K)),
        22 => ("can", one(adj(0, 5400.0) * K * h / ss)),
        23 => ("donut", one(adj(0, 5400.0) * K)),
        32 => ("straightConnector1", String::new()),
        33 => ("bentConnector2", String::new()),
        34 => ("bentConnector3", gd("adj1", adj(0, 10800.0) * K)),
        35 => ("bentConnector4", two(adj(0, 10800.0) * K, adj(1, 10800.0) * K)),
        36 => ("bentConnector5", three(adj(0, 10800.0) * K, adj(1, 10800.0) * K, adj(2, 10800.0) * K)),
        37 => ("curvedConnector2", String::new()),
        38 => ("curvedConnector3", gd("adj1", adj(0, 10800.0) * K)),
        39 => ("curvedConnector4", two(adj(0, 10800.0) * K, adj(1, 10800.0) * K)),
        40 => ("curvedConnector5", three(adj(0, 10800.0) * K, adj(1, 10800.0) * K, adj(2, 10800.0) * K)),
        t @ (41..=52 | 178..=181) => {
            // line callouts: Escher keeps the line's points as (x, y) from the far end,
            // DrawingML as (y, x) from the box
            let (name, defaults): (&str, &[f64]) = match t {
                41 => ("callout1", &[-8280.0, 24300.0, -1800.0, 4050.0]),
                42 => ("callout2", &[-10080.0, 24300.0, -3600.0, 4050.0, -1800.0, 4050.0]),
                43 => ("callout3", &[23400.0, 24400.0, 25200.0, 21600.0, 25200.0, 4050.0, 23400.0, 4050.0]),
                44 => ("accentCallout1", &[-8280.0, 24300.0, -1800.0, 4050.0]),
                45 => ("accentCallout2", &[-10080.0, 24300.0, -3600.0, 4050.0, -1800.0, 4050.0]),
                46 => ("accentCallout3", &[23400.0, 24400.0, 25200.0, 21600.0, 25200.0, 4050.0, 23400.0, 4050.0]),
                47 => ("borderCallout1", &[-8280.0, 24300.0, -1800.0, 4050.0]),
                48 => ("borderCallout2", &[-10080.0, 24300.0, -3600.0, 4050.0, -1800.0, 4050.0]),
                49 => ("borderCallout3", &[23400.0, 24400.0, 25200.0, 21600.0, 25200.0, 4050.0, 23400.0, 4050.0]),
                50 => ("accentBorderCallout1", &[-8280.0, 24300.0, -1800.0, 4050.0]),
                51 => ("accentBorderCallout2", &[-10080.0, 24300.0, -3600.0, 4050.0, -1800.0, 4050.0]),
                52 => ("accentBorderCallout3", &[23400.0, 24400.0, 25200.0, 21600.0, 25200.0, 4050.0, 23400.0, 4050.0]),
                178 => ("callout1", &[-1800.0, 24300.0, -1800.0, 4050.0]),
                179 => ("accentCallout1", &[-1800.0, 24300.0, -1800.0, 4050.0]),
                180 => ("borderCallout1", &[-1800.0, 24300.0, -1800.0, 4050.0]),
                _ => ("accentBorderCallout1", &[-1800.0, 24300.0, -1800.0, 4050.0]),
            };
            let n = defaults.len() / 2;
            let mut av = String::new();
            for k in 0..n {
                let p = n - 1 - k;
                let (x, y) = (adj(2 * p, defaults[2 * p]), adj(2 * p + 1, defaults[2 * p + 1]));
                av.push_str(&gd(&format!("adj{}", 2 * k + 1), y * K));
                av.push_str(&gd(&format!("adj{}", 2 * k + 2), x * K));
            }
            (name, av)
        }
        53 => ("ribbon", String::new()),
        54 => ("ribbon2", String::new()),
        55 => ("chevron", one((21600.0 - adj(0, 16200.0)) * K * w / ss)),
        56 => ("pentagon", String::new()),
        57 => ("noSmoking", one(adj(0, 2700.0) * K)),
        58 => ("star8", String::new()),
        59 => ("star16", String::new()),
        60 => ("star32", String::new()),
        61 => {
            let (a, b) = tip(1350.0, 25920.0);
            ("wedgeRectCallout", two(a, b))
        }
        62 => {
            let (a, b) = tip(1350.0, 25920.0);
            ("wedgeRoundRectCallout", three(a, b, 16667.0))
        }
        63 => {
            let (a, b) = tip(1350.0, 25920.0);
            ("wedgeEllipseCallout", two(a, b))
        }
        64 => ("wave", two(adj(0, 2809.0) * K, (adj(1, 10800.0) - 10800.0) * K)),
        65 => ("foldedCorner", one((21600.0 - adj(0, 18900.0)) * K)),
        66 => ("leftArrow", two(shaft(adj(1, 5400.0)), adj(0, 5400.0) * K * w / ss)),
        67 => ("downArrow", two(shaft(adj(1, 5400.0)), (21600.0 - adj(0, 16200.0)) * K * h / ss)),
        68 => ("upArrow", two(shaft(adj(1, 5400.0)), adj(0, 5400.0) * K * h / ss)),
        69 => ("leftRightArrow", two(shaft(adj(1, 5400.0)), adj(0, 4320.0) * K * w / ss)),
        70 => ("upDownArrow", two(shaft(adj(0, 5400.0)), adj(1, 4320.0) * K * h / ss)),
        71 => ("irregularSeal1", String::new()),
        72 => ("irregularSeal2", String::new()),
        73 => ("lightningBolt", String::new()),
        74 => ("heart", String::new()),
        76 => ("quadArrow", String::new()),
        77 => ("leftArrowCallout", String::new()),
        78 => ("rightArrowCallout", String::new()),
        79 => ("upArrowCallout", String::new()),
        80 => ("downArrowCallout", String::new()),
        81 => ("leftRightArrowCallout", String::new()),
        82 => ("upDownArrowCallout", String::new()),
        83 => ("quadArrowCallout", String::new()),
        84 => ("bevel", one(adj(0, 2700.0) * K)),
        85 => ("leftBracket", one(adj(0, 1800.0) * K * h / ss)),
        86 => ("rightBracket", one(adj(0, 1800.0) * K * h / ss)),
        87 => ("leftBrace", two(adj(0, 1800.0) * K * h / ss, adj(1, 10800.0) * K)),
        88 => ("rightBrace", two(adj(0, 1800.0) * K * h / ss, adj(1, 10800.0) * K)),
        89 => ("leftUpArrow", String::new()),
        90 => ("bentUpArrow", String::new()),
        91 => ("bentArrow", String::new()),
        92 => ("star24", String::new()),
        93 => ("stripedRightArrow", two(shaft(adj(1, 5400.0)), ((21600.0 - adj(0, 16200.0)) * K * w / ss).max(0.0))),
        94 => ("notchedRightArrow", two(shaft(adj(1, 5400.0)), ((21600.0 - adj(0, 16200.0)) * K * w / ss).max(0.0))),
        95 => ("blockArc", String::new()),
        96 => ("smileyFace", String::new()),
        97 => ("verticalScroll", one(adj(0, 2700.0) * K)),
        98 => ("horizontalScroll", one(adj(0, 2700.0) * K)),
        99 | 100 => ("circularArrow", String::new()),
        101 => ("uturnArrow", String::new()),
        102 => ("curvedRightArrow", String::new()),
        103 => ("curvedLeftArrow", String::new()),
        104 => ("curvedUpArrow", String::new()),
        105 => ("curvedDownArrow", String::new()),
        106 => {
            let (a, b) = tip(1350.0, 25920.0);
            ("cloudCallout", two(a, b))
        }
        107 => ("ellipseRibbon", String::new()),
        108 => ("ellipseRibbon2", String::new()),
        109 => ("flowChartProcess", String::new()),
        110 => ("flowChartDecision", String::new()),
        111 => ("flowChartInputOutput", String::new()),
        112 => ("flowChartPredefinedProcess", String::new()),
        113 => ("flowChartInternalStorage", String::new()),
        114 => ("flowChartDocument", String::new()),
        115 => ("flowChartMultidocument", String::new()),
        116 => ("flowChartTerminator", String::new()),
        117 => ("flowChartPreparation", String::new()),
        118 => ("flowChartManualInput", String::new()),
        119 => ("flowChartManualOperation", String::new()),
        120 => ("flowChartConnector", String::new()),
        121 => ("flowChartPunchedCard", String::new()),
        122 => ("flowChartPunchedTape", String::new()),
        123 => ("flowChartSummingJunction", String::new()),
        124 => ("flowChartOr", String::new()),
        125 => ("flowChartCollate", String::new()),
        126 => ("flowChartSort", String::new()),
        127 => ("flowChartExtract", String::new()),
        128 => ("flowChartMerge", String::new()),
        129 => ("flowChartOfflineStorage", String::new()),
        130 => ("flowChartOnlineStorage", String::new()),
        131 => ("flowChartMagneticTape", String::new()),
        132 => ("flowChartMagneticDisk", String::new()),
        133 => ("flowChartMagneticDrum", String::new()),
        134 => ("flowChartDisplay", String::new()),
        135 => ("flowChartDelay", String::new()),
        176 => ("flowChartAlternateProcess", String::new()),
        177 => ("flowChartOffpageConnector", String::new()),
        182 => ("leftRightUpArrow", String::new()),
        183 => ("sun", one(adj(0, 5400.0) * K)),
        184 => ("moon", one(adj(0, 10800.0) * K)),
        185 => ("bracketPair", one(adj(0, 3600.0) * K)),
        186 => ("bracePair", one(adj(0, 1800.0) * K)),
        187 => ("star4", String::new()),
        188 => ("doubleWave", two(adj(0, 1404.0) * K, (adj(1, 10800.0) - 10800.0) * K)),
        189 => ("actionButtonBlank", String::new()),
        190 => ("actionButtonHome", String::new()),
        191 => ("actionButtonHelp", String::new()),
        192 => ("actionButtonInformation", String::new()),
        193 => ("actionButtonForwardNext", String::new()),
        194 => ("actionButtonBackPrevious", String::new()),
        195 => ("actionButtonEnd", String::new()),
        196 => ("actionButtonBeginning", String::new()),
        197 => ("actionButtonReturn", String::new()),
        198 => ("actionButtonDocument", String::new()),
        199 => ("actionButtonSound", String::new()),
        200 => ("actionButtonMovie", String::new()),
        _ => ("rect", String::new()),
    };
    if av.is_empty() {
        format!("<a:prstGeom prst=\"{prst}\"><a:avLst/></a:prstGeom>")
    } else {
        format!("<a:prstGeom prst=\"{prst}\"><a:avLst>{av}</a:avLst></a:prstGeom>")
    }
}

/// A closed polygon (points in points within a `w` x `h` box) as a custom geometry.
fn poly(w: f64, h: f64, pts: &[(f64, f64)]) -> String {
    let mut o = format!(
        "<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l=\"0\" t=\"0\" r=\"r\" b=\"b\"/><a:pathLst><a:path w=\"{}\" h=\"{}\">",
        emu(w).max(1),
        emu(h).max(1)
    );
    for (i, (x, y)) in pts.iter().enumerate() {
        let tag = if i == 0 { "moveTo" } else { "lnTo" };
        let _ = write!(o, "<a:{tag}><a:pt x=\"{}\" y=\"{}\"/></a:{tag}>", emu(*x), emu(*y));
    }
    o.push_str("<a:close/></a:path></a:pathLst></a:custGeom>");
    o
}

/// Converts an SVG path (absolute M, L, H, V, C, Q, Z commands) to a DrawingML custom geometry.
fn cust_geom(d: &str, geo: &[f64; 4]) -> Option<String> {
    let (gw, gh) = (geo[2] - geo[0], geo[3] - geo[1]);
    if !(gw > 0.0 && gh > 0.0) {
        return None;
    }
    // path coordinates scaled to a 0..1,000,000 box
    let k = 1_000_000.0 / gw.max(gh);
    let px = |x: f64| ((x - geo[0]) * k).round() as i64;
    let py = |y: f64| ((y - geo[1]) * k).round() as i64;
    let pt = |x: f64, y: f64| format!("<a:pt x=\"{}\" y=\"{}\"/>", px(x), py(y));

    // tokenise
    let mut toks: Vec<(char, Vec<f64>)> = Vec::new();
    let mut num = String::new();
    let push_num = |num: &mut String, toks: &mut Vec<(char, Vec<f64>)>| -> Option<()> {
        if !num.is_empty() {
            let v: f64 = num.parse().ok()?;
            toks.last_mut()?.1.push(v);
            num.clear();
        }
        Some(())
    };
    for c in d.chars() {
        match c {
            'M' | 'L' | 'H' | 'V' | 'C' | 'Q' | 'Z' | 'z' => {
                push_num(&mut num, &mut toks)?;
                toks.push((c.to_ascii_uppercase(), Vec::new()));
            }
            '-' if !num.is_empty() && !num.ends_with('e') && !num.ends_with('E') => {
                push_num(&mut num, &mut toks)?;
                num.push(c);
            }
            '0'..='9' | '.' | '-' | '+' | 'e' | 'E' => num.push(c),
            ' ' | ',' | '\n' | '\t' | '\r' => push_num(&mut num, &mut toks)?,
            _ => return None,
        }
    }
    push_num(&mut num, &mut toks)?;

    let mut o = String::new();
    let (mut cx, mut cy) = (0.0, 0.0);
    let mut open = false;
    for (cmd, a) in &toks {
        match cmd {
            'M' | 'L' => {
                if a.len() < 2 || a.len() % 2 != 0 {
                    return None;
                }
                for (i, xy) in a.chunks(2).enumerate() {
                    if *cmd == 'M' && i == 0 {
                        let _ = write!(o, "<a:moveTo>{}</a:moveTo>", pt(xy[0], xy[1]));
                        open = true;
                    } else {
                        if !open {
                            return None;
                        }
                        let _ = write!(o, "<a:lnTo>{}</a:lnTo>", pt(xy[0], xy[1]));
                    }
                    cx = xy[0];
                    cy = xy[1];
                }
            }
            'H' | 'V' => {
                if !open {
                    return None;
                }
                for v in a {
                    if *cmd == 'H' {
                        cx = *v;
                    } else {
                        cy = *v;
                    }
                    let _ = write!(o, "<a:lnTo>{}</a:lnTo>", pt(cx, cy));
                }
            }
            'C' => {
                if !open || a.is_empty() || a.len() % 6 != 0 {
                    return None;
                }
                for v in a.chunks(6) {
                    let _ = write!(o, "<a:cubicBezTo>{}{}{}</a:cubicBezTo>", pt(v[0], v[1]), pt(v[2], v[3]), pt(v[4], v[5]));
                    cx = v[4];
                    cy = v[5];
                }
            }
            'Q' => {
                if !open || a.is_empty() || a.len() % 4 != 0 {
                    return None;
                }
                for v in a.chunks(4) {
                    let _ = write!(o, "<a:quadBezTo>{}{}</a:quadBezTo>", pt(v[0], v[1]), pt(v[2], v[3]));
                    cx = v[2];
                    cy = v[3];
                }
            }
            'Z' => {
                if open {
                    o.push_str("<a:close/>");
                }
            }
            _ => return None,
        }
    }
    if o.is_empty() {
        return None;
    }
    Some(format!(
        "<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l=\"0\" t=\"0\" r=\"r\" b=\"b\"/><a:pathLst><a:path w=\"{}\" h=\"{}\">{}</a:path></a:pathLst></a:custGeom>",
        (gw * k).round() as i64,
        (gh * k).round() as i64,
        o
    ))
}
