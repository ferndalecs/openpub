// Building the document model from the parsed streams.
// (Included into pubfile.rs so it can use the parser's private types.)

use crate::model::*;

const PT: f64 = 12700.0; // EMU per point

fn emu(v: u32) -> f64 {
    v as i32 as f64 / PT
}

struct TableInfo {
    col_w: Vec<f64>,
    row_h: Vec<f64>,
    cells_seq: Option<u32>,
}

#[derive(Clone, Default)]
struct CellInfo {
    r0: u32,
    r1: u32,
    c0: u32,
    c1: u32,
    margins: [f64; 4],
    valign: u32,
}

#[derive(Default, Debug)]
struct PageInfo {
    seq: u32,
    shapes: Vec<u32>,
    master: Option<u32>,
    is_master: bool,
    visible: bool,
    /// The page-sized shape that carries the page background's fill.
    background: Option<u32>,
}

#[derive(Default)]
struct ContentsInfo {
    width: Option<f64>,
    height: Option<f64>,
    pages: Vec<PageInfo>,
    palette: Vec<[u8; 3]>,
    default_tab: Option<f64>,
    tables: HashMap<u32, TableInfo>,
    cells: HashMap<u32, Vec<CellInfo>>,
    /// inline object number -> shape chunk seq
    inline_ids: HashMap<u32, u32>,
    /// shape seq -> how text flows around it (Publisher's wrap type: 0 none, 1 square,
    /// 2 tight, 3 through, 4 top and bottom); square when not stored
    wrap_types: HashMap<u32, u32>,
    /// text frame seq -> the shapes Publisher found in its way
    wraps: HashMap<u32, Vec<u32>>,
    /// text frame seq -> vertical alignment of its text (0 top, 1 middle, 2 bottom)
    valigns: HashMap<u32, u32>,
    /// text frame seq -> its position in a chain of linked frames sharing one story
    chains: HashMap<u32, u32>,
    /// the publication's picture borders: for each, its eight tiles as indices into its pictures
    /// (Windows metafiles)
    border_arts: Vec<(Vec<usize>, Vec<Vec<u8>>)>,
    /// shape seq -> which picture border it has
    border_art_of: HashMap<u32, u32>,
}

fn ints(bs: &[Block]) -> Vec<u32> {
    bs.iter().filter_map(|b| if let BVal::Int(v) = b.val { Some(v) } else { None }).collect()
}

fn parse_contents(d: &[u8]) -> ContentsInfo {
    let chunks = contents_chunks(d);
    let mut info = ContentsInfo::default();
    let mut page_order: Vec<u32> = Vec::new();
    let mut pages: HashMap<u32, PageInfo> = HashMap::new();
    for (seq, (t, off, _parent)) in &chunks {
        match t {
            0x44 => {
                let bs = chunk_blocks(d, *off);
                if let Some(sz) = list(&bs, 0x12) {
                    info.width = int(sz, 1).map(emu);
                    info.height = int(sz, 2).map(emu);
                }
                if let Some(pl) = list(&bs, 2) {
                    page_order = ints(pl);
                }
                info.default_tab = int(&bs, 0x15).map(emu).filter(|v| *v > 1.0);
            }
            0x5c => {
                let bs = chunk_blocks(d, *off);
                for e in list(&bs, 2).unwrap_or(&[]) {
                    let c = match &e.val {
                        BVal::List(sub) => int(sub, 1).unwrap_or(0),
                        _ => 0,
                    };
                    info.palette.push([(c & 0xff) as u8, ((c >> 8) & 0xff) as u8, ((c >> 16) & 0xff) as u8]);
                }
            }
            0x43 => {
                let bs = chunk_blocks(d, *off);
                let shapes = list(&bs, 2).map(ints).unwrap_or_default();
                let kind = int(&bs, 0x10).unwrap_or(5);
                let visible = match find(&bs, 6).map(|b| &b.val) {
                    Some(BVal::Bytes(x)) => x.first().copied().unwrap_or(0) != 0,
                    _ => true,
                };
                pages.insert(*seq, PageInfo { seq: *seq, shapes, master: int(&bs, 0xd), is_master: kind == 3, visible, background: int(&bs, 0xa) });
            }
            0x46 => {
                // picture borders (BorderArt): each has a list of pictures and, for its eight
                // tiles, where the tile's picture block sits (counted from the entry's length field)
                let bs = chunk_blocks(d, *off);
                for e in list(&bs, 2).unwrap_or(&[]).iter().take(1000) {
                    let BVal::List(sub) = &e.val else { continue };
                    let blocks: Vec<&Block> = list(sub, 0x0a).unwrap_or(&[]).iter().filter_map(|b| if let BVal::List(l) = &b.val { find(l, 1) } else { None }).collect();
                    let pictures: Vec<Vec<u8>> = blocks.iter().map(|b| d.get(b.span.0..b.span.1).unwrap_or(&[]).to_vec()).collect();
                    // (the tiles' offsets, in order of position, name the pictures in order)
                    let offsets = list(sub, 8).map(ints).unwrap_or_default();
                    let mut distinct = offsets.clone();
                    distinct.sort_unstable();
                    distinct.dedup();
                    let tiles: Vec<usize> = offsets.iter().map(|o| distinct.iter().position(|d| d == o).unwrap_or(0)).collect();
                    info.border_arts.push((tiles, pictures));
                }
            }
            0x10 => {
                let bs = chunk_blocks(d, *off);
                let cols = int(&bs, 0x67).unwrap_or(0) as usize;
                let rows = int(&bs, 0x66).unwrap_or(0) as usize;
                let mut sizes: Vec<f64> = Vec::new();
                for e in list(&bs, 0x6d).unwrap_or(&[]) {
                    if let BVal::List(sub) = &e.val {
                        sizes.push(int(sub, 2).map(emu).unwrap_or(0.0));
                    }
                }
                if sizes.len() >= cols + rows && cols > 0 && rows > 0 {
                    info.tables.insert(*seq, TableInfo { col_w: sizes[..cols].to_vec(), row_h: sizes[cols..cols + rows].to_vec(), cells_seq: int(&bs, 0x6b) });
                }
            }
            0x63 => {
                let bs = chunk_blocks(d, *off);
                let mut cells = Vec::new();
                for e in list(&bs, 2).unwrap_or(&[]) {
                    if let BVal::List(sub) = &e.val {
                        let g = |id: u8| int(sub, id).unwrap_or(0);
                        cells.push(CellInfo { r0: g(1), r1: g(2), c0: g(3), c1: g(4), margins: [emu(g(0x0a)), emu(g(0x0c)), emu(g(0x0b)), emu(g(0x0d))], valign: g(7) });
                    }
                }
                info.cells.insert(*seq, cells);
            }
            _ => {}
        }
        if !matches!(t, 0x43 | 0x44 | 0x5c | 0x63) {
            let bs = chunk_blocks(d, *off);
            if has(&bs, 0xaa) || has(&bs, 0x68) || has(&bs, 0x27) {
                if let Some(n) = int(&bs, 0x0f) {
                    info.inline_ids.insert(n, *seq);
                }
                if let Some(l) = list(&bs, 0x47) {
                    info.wraps.insert(*seq, ints(l));
                }
                if let Some(v) = int(&bs, 0x35) {
                    info.valigns.insert(*seq, v);
                }
                if let Some(v) = int(&bs, 0x28) {
                    info.chains.insert(*seq, v);
                }
                if let Some(b) = bs.iter().find(|b| b.id == 0x09 && b.ty == 0x18) {
                    if let BVal::Int(v) = b.val {
                        info.border_art_of.insert(*seq, v);
                    }
                }

            }
            // shapes (0x01), tables (0x10), WordArt (0x20) and groups (0x30): a 16-bit field whose
            // low byte is the wrap type (0x05 holds it for top-and-bottom)
            if matches!(t, 0x01 | 0x10 | 0x20 | 0x30) || has(&bs, 0xaa) {
                for id in [0x04u8, 0x05] {
                    if let Some(b) = bs.iter().find(|b| b.id == id && b.ty == 0x10) {
                        if let BVal::Int(v) = b.val {
                            info.wrap_types.insert(*seq, v & 0xff);
                        }
                    }
                }
            }
        }
    }
    let masters: HashSet<u32> = pages.values().filter_map(|p| p.master).collect();
    for p in pages.values_mut() {
        if masters.contains(&p.seq) {
            p.is_master = true;
        }
    }
    if page_order.is_empty() {
        page_order = pages.keys().copied().collect();
        page_order.sort();
    }
    for seq in page_order {
        if let Some(p) = pages.remove(&seq) {
            info.pages.push(p);
        }
    }
    info
}

fn hex_color(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Office colour reference: 0x08xxxxxx = scheme colour index, 0xFFFFFFFF = none, else 0x00BBGGRR.
fn resolve_color(c: u32, palette: &[[u8; 3]]) -> Option<[u8; 3]> {
    if c == 0xffff_ffff {
        return None;
    }
    let flags = c >> 24;
    if flags & 0x08 != 0 {
        let idx = (c & 0xff) as usize;
        const DEFAULT: [[u8; 3]; 8] = [[0, 0, 0], [0x5b, 0x9b, 0xd5], [0xed, 0x7d, 0x31], [0x9e, 0x9e, 0x9e], [0xff, 0xc0, 0], [0x44, 0x72, 0xc4], [0x70, 0xad, 0x47], [255, 255, 255]];
        return Some(palette.get(idx).copied().unwrap_or(DEFAULT[idx.min(7)]));
    }
    if flags & 0x10 != 0 {
        return Some([0, 0, 0]); // system colour
    }
    Some([(c & 0xff) as u8, ((c >> 8) & 0xff) as u8, ((c >> 16) & 0xff) as u8])
}

struct TextCtx<'a> {
    q: &'a QuillData,
    palette: &'a [[u8; 3]],
}

impl TextCtx<'_> {
    fn font(&self, idx: Option<u32>) -> String {
        self.q.fonts.get(idx.unwrap_or(0) as usize).cloned().unwrap_or_else(|| "Calibri".into())
    }

    fn color(&self, idx: Option<u32>) -> String {
        let c = idx.and_then(|i| self.q.colors.get(i as usize)).and_then(|c| resolve_color(*c, self.palette)).unwrap_or([0, 0, 0]);
        hex_color(c)
    }

    /// Paragraphs for the characters `a..b` of the text stream.
    fn paras(&self, a: usize, b: usize) -> Vec<Para> {
        let q = self.q;
        let b = b.min(q.chars.len());
        let base_run = q.style_runs.first().cloned().unwrap_or_default();
        let base_para = q.style_paras.first().cloned().unwrap_or_default();
        let mut out = Vec::new();
        let mut i = a;
        while i < b {
            let mut j = i;
            while j < b && q.chars[j] != 0x0d {
                j += 1;
            }
            let mark = j.min(b - 1);
            let raw = q.pprops[mark].map(|x| q.paras[x].clone()).unwrap_or_default();
            let pp = raw.over(&base_para);
            let mut para = make_para(&pp, self);
            let mut k = i;
            while k <= mark {
                let mut m = k;
                while m <= mark && q.cprops[m] == q.cprops[k] {
                    m += 1;
                }
                let rp = q.cprops[k].map(|x| q.runs[x].clone()).unwrap_or_default().over(&base_run);
                let mut text = String::new();
                let mut inline = None;
                if m == k + 1 && q.chars[k] == 0xfffc {
                    inline = q.eobj.get(&k).copied();
                }
                for &ch in &q.chars[k..m] {
                    match ch {
                        0x0d => {}
                        0x0b | 0x0a => text.push('\n'),
                        0x09 => text.push('\t'),
                        0x1e => text.push('\u{2011}'),
                        0x1f => text.push('\u{ad}'),
                        x if x < 0x20 => {}
                        x => text.push(char::from_u32(x as u32).unwrap_or('\u{fffd}')),
                    }
                }
                let run = Run {
                    text,
                    font: self.font(rp.font),
                    size: rp.size.unwrap_or(10.0) as f64,
                    bold: rp.bold.unwrap_or(false),
                    italic: rp.italic.unwrap_or(false),
                    underline: rp.underline.unwrap_or(false),
                    color: self.color(rp.color),
                    script: rp.script.unwrap_or(0),
                    strike: rp.strike.unwrap_or(false),
                    effect: rp.effect.unwrap_or(0),
                    caps: if rp.all_caps == Some(true) { 2 } else if rp.small_caps == Some(true) { 1 } else { 0 },
                    tracking: match rp.tracking {
                        Some(t) if t != 1000 && (100..=6000).contains(&t) => t as f64 / 1000.0,
                        _ => 0.0,
                    },
                    kerning: rp.kerning.map(|k| k as f64 / EMU_PER_PT).filter(|k| k.abs() < 200.0).unwrap_or(0.0),
                    // (measured: tools/makeprobe9.ps1)
                    scale: match rp.scale {
                        Some(t) if t != 1000 && (10..=6000).contains(&t) => t as f64 / 1000.0,
                        _ => 0.0,
                    },
                    field: if rp.field == Some(5) { Some("page".into()) } else { None },
                    object: None,
                    inline,
                };
                // the paragraph mark keeps its formatting as an empty run, so that empty
                // paragraphs get the right height
                let same_format = |a: &Run, b: &Run| {
                    a.inline.is_none() && b.inline.is_none() && a.font == b.font && a.size == b.size && a.bold == b.bold && a.italic == b.italic && a.underline == b.underline && a.color == b.color && a.script == b.script && a.strike == b.strike && a.effect == b.effect && a.caps == b.caps && a.tracking == b.tracking && a.kerning == b.kerning && a.scale == b.scale && a.field == b.field
                };
                match para.runs.last_mut() {
                    Some(last) if !run.text.is_empty() && same_format(last, &run) => last.text.push_str(&run.text),
                    Some(_) if run.text.is_empty() => {}
                    _ => para.runs.push(run),
                }
                k = m;
            }
            out.push(para);
            i = j + 1;
        }
        out
    }
}

fn make_para(p: &ParaProps, cx: &TextCtx) -> Para {
    let (spacing, spacing_exact) = match p.spacing {
        Some(v) if v & 1 != 0 => (((v - 1) as f64 / 8.0 / PT).clamp(1.0, 1000.0), true),
        Some(v) if v & 2 != 0 => (((v - 2) as f64 / 1_219_200.0).clamp(0.1, 20.0), false),
        _ => (1.0, false),
    };
    let numbered = matches!(p.list_style, Some(s) if s < 0x17);
    let bullet = if numbered {
        // Publisher's list styles -> the model's number formats (see Bullet::number)
        let number = match p.list_style.unwrap_or(0) {
            1 => 7,
            2 => 6,
            3 => 4,
            4 => 2,
            5 => 13,
            6 => 14,
            7 => 15,
            _ => 0,
        };
        let separator = match p.list_sep {
            Some(0) => Some(")".to_string()),
            Some(1) => Some("()".to_string()),
            Some(3) => Some(String::new()),
            Some(4) => Some(":".to_string()),
            _ => None,
        };
        Some(Bullet { text: String::new(), font: None, number: Some(number), start: p.list_start.filter(|s| *s != 1), separator })
    } else {
        p.bullet.filter(|c| *c >= 0x20).map(|code| Bullet { text: char::from_u32(code).unwrap_or('\u{2022}').to_string(), font: p.bullet_font.map(|f| cx.font(Some(f))), number: None, start: None, separator: None })
    };
    let tab = |(pos, kind): &(u32, u32)| Tab {
        pos: *pos as f64 / PT,
        align: match kind & 0xff {
            1 => "center",
            2 => "right",
            3 => "decimal",
            _ => "left",
        }
        .into(),
        leader: None,
    };
    Para {
        align: match p.align.unwrap_or(0) {
            1 => "right",
            2 => "center",
            3 | 6 => "justify",
            _ => "left",
        }
        .into(),
        left: p.left.map(|v| v as f64 / PT).unwrap_or(0.0),
        right: p.right.map(|v| v as f64 / PT).unwrap_or(0.0),
        first: p.first.map(|v| v as f64 / PT).unwrap_or(0.0),
        before: p.before.map(|v| v as f64 / PT).unwrap_or(0.0),
        after: p.after.map(|v| v as f64 / PT).unwrap_or(0.0),
        spacing,
        spacing_exact,
        bullet,
        tabs: p.tabs.iter().map(tab).collect(),
        runs: Vec::new(),
    }
}

struct Conv<'a> {
    info: &'a ContentsInfo,
    esc: &'a Escher,
    text: Option<TextCtx<'a>>,
    /// story id -> (index, first char, end char)
    stories: HashMap<u32, (usize, usize, usize)>,
    /// table chunk seq -> cell index -> styling shape
    cell_shapes: HashMap<u32, HashMap<u32, &'a EShape>>,
    by_seq: HashMap<u32, &'a EShape>,
    /// table chunk seq -> border segments in drawing order
    border_shapes: HashMap<u32, Vec<&'a EShape>>,
    page_w: f64,
    page_h: f64,
    images: Vec<Image>,
    image_of_blip: HashMap<u32, usize>,
    /// picture border number -> its tiles as pictures of the document (None: couldn't be drawn)
    border_tiles: HashMap<u32, Option<Vec<usize>>>,
}

#[derive(Clone, Copy)]
struct GroupMap {
    from: [f64; 4],
    to: [f64; 4],
}

impl GroupMap {
    fn map(&self, r: [i32; 4]) -> [f64; 4] {
        let sx = (self.to[2] - self.to[0]) / (self.from[2] - self.from[0]).abs().max(1.0);
        let sy = (self.to[3] - self.to[1]) / (self.from[3] - self.from[1]).abs().max(1.0);
        [
            self.to[0] + (r[0] as f64 - self.from[0]) * sx,
            self.to[1] + (r[1] as f64 - self.from[1]) * sy,
            self.to[0] + (r[2] as f64 - self.from[0]) * sx,
            self.to[1] + (r[3] as f64 - self.from[1]) * sy,
        ]
    }
}

fn sniff_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.starts_with(b"BM") {
        "image/bmp"
    } else if b.starts_with(b"II*\0") || b.starts_with(b"MM\0*") {
        "image/tiff"
    } else {
        "application/octet-stream"
    }
}

impl<'a> Conv<'a> {
    fn color(&self, c: u32) -> Option<String> {
        resolve_color(c, &self.info.palette).map(hex_color)
    }

    fn image(&mut self, pib: u32) -> Option<usize> {
        if pib == 0 {
            return None;
        }
        if let Some(i) = self.image_of_blip.get(&pib) {
            return Some(*i);
        }
        let (bytes, _label) = self.esc.blips.get(pib as usize - 1)?.as_ref()?;
        if bytes.is_empty() {
            return None;
        }
        let mut bytes = bytes.clone();
        let mut mime = sniff_mime(&bytes);
        if mime == "image/tiff" || mime == "image/bmp" {
            // browsers don't show these: re-encode as PNG
            if let Ok(img) = image::load_from_memory(&bytes) {
                let mut png = Vec::new();
                if img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_ok() {
                    bytes = png;
                    mime = "image/png";
                }
            }
        }
        let orientation = if mime == "image/jpeg" { crate::images::jpeg_orientation(&bytes) } else { 1 };
        self.images.push(Image { mime: mime.into(), bytes, orientation });
        self.image_of_blip.insert(pib, self.images.len() - 1);
        Some(self.images.len() - 1)
    }

    /// The tiles of picture border `n`, drawn as PNG pictures (once per publication).
    fn border_art(&mut self, n: u32) -> Option<Vec<usize>> {
        if let Some(t) = self.border_tiles.get(&n) {
            return t.clone();
        }
        let info = self.info;
        let mut made = None;
        if let Some((tiles, pictures)) = info.border_arts.get(n as usize) {
            if tiles.len() == 8 && pictures.len() <= 64 {
                let mut at: Vec<Option<usize>> = Vec::new();
                for p in pictures {
                    let png = crate::metafile::to_png(p, true, 160, 160);
                    at.push(png.map(|bytes| {
                        self.images.push(Image { mime: "image/png".into(), bytes, orientation: 1 });
                        self.images.len() - 1
                    }));
                }
                made = tiles.iter().map(|t| at.get(*t).copied().flatten()).collect::<Option<Vec<usize>>>();
            }
        }
        self.border_tiles.insert(n, made.clone());
        made
    }

    /// The 8 × 8 dots of a pattern fill's bitmap as 16 hex digits: the light dots are the fill
    /// colour (set), the dark ones the second colour (measured against Publisher: probe-background p4).
    fn pattern_bits(&self, pib: u32) -> Option<String> {
        let (bytes, _) = self.esc.blips.get((pib as usize).checked_sub(1)?)?.as_ref()?;
        let img = image::load_from_memory(bytes).ok()?.into_luma8();
        if img.width() < 8 || img.height() < 8 {
            return None;
        }
        let mut bits: u64 = 0;
        for y in 0..8 {
            for x in 0..8 {
                bits <<= 1;
                if img.get_pixel(x, y)[0] >= 128 {
                    bits |= 1;
                }
            }
        }
        Some(format!("{bits:016x}"))
    }

    fn fill(&mut self, s: &EShape, default_on: bool) -> Option<Fill> {
        let bools = s.props.get(&0x1bf).copied();
        let filled = match bools {
            Some(v) if v & (1 << 20) != 0 => v & (1 << 4) != 0,
            _ => default_on,
        };
        if !filled {
            return None;
        }
        let fill_type = s.props.get(&0x180).copied().unwrap_or(0);
        let opacity = s.props.get(&0x182).map(|v| (*v as f64 / 65536.0).clamp(0.0, 1.0)).unwrap_or(1.0);
        let color = match s.props.get(&0x181) {
            Some(v) => self.color(*v)?,
            None => "#ffffff".into(),
        };
        let mut f = Fill { color, opacity, ..Default::default() };
        if (4..=7).contains(&fill_type) {
            f.color2 = Some(s.props.get(&0x183).and_then(|v| self.color(*v)).unwrap_or_else(|| "#ffffff".into()));
            f.angle = s.props.get(&0x18b).map(|v| *v as i32 as f64 / 65536.0).unwrap_or(0.0);
            // "focus" 100 runs the gradient the other way round
            if s.props.get(&0x18c).map(|v| (*v as i32).abs() > 75).unwrap_or(false) {
                let first = std::mem::replace(&mut f.color, f.color2.take().unwrap_or_default());
                f.color2 = Some(first);
            }
        } else if fill_type == 3 || fill_type == 2 {
            f.image = s.props.get(&0x186).copied().and_then(|p| self.image(p));
        } else if fill_type == 1 {
            // a pattern: a small two-colour bitmap
            if let Some(bits) = s.props.get(&0x186).copied().and_then(|p| self.pattern_bits(p)) {
                f.pattern = Some(bits);
                f.back = Some(s.props.get(&0x183).and_then(|v| self.color(*v)).unwrap_or_else(|| "#ffffff".into()));
            }
        }
        Some(f)
    }

    /// Line style from the property set starting at `base` (0x1c0 for the outline).
    fn line(&self, s: &EShape, base: u16, default_on: bool, default_width: f64) -> Option<Line> {
        let on = match s.props.get(&(base + 0x3f)).copied() {
            Some(v) if v & (1 << 19) != 0 => v & (1 << 3) != 0,
            _ => default_on,
        };
        if !on {
            return None;
        }
        let color = match s.props.get(&base) {
            Some(v) => self.color(*v)?,
            None => "#000000".into(),
        };
        let width = s.props.get(&(base + 0x0b)).map(|v| emu(*v)).unwrap_or(default_width);
        if width <= 0.0 {
            return None;
        }
        let get = |off: u16, d: u32| s.props.get(&(base + off)).copied().unwrap_or(d);
        let bools = get(0x3f, 0);
        Some(Line {
            color,
            width,
            dash: get(0x0e, 0),
            start_arrow: get(0x10, 0),
            end_arrow: get(0x11, 0),
            start_arrow_w: get(0x12, 1).min(2),
            start_arrow_l: get(0x13, 1).min(2),
            end_arrow_w: get(0x14, 1).min(2),
            end_arrow_l: get(0x15, 1).min(2),
            // fInsetPen, when its "use" bit is set
            inset: bools & (1 << 22) != 0 && bools & (1 << 6) != 0,
            compound: get(0x0d, 0).min(4),
            // lineEndCapStyle: 0 round, 1 square, 2 flat (the default)
            round: get(0x17, 2) == 0,
        })
    }

    /// Drop shadow (fShadow in the shadow booleans, with its "use" bit).
    fn shadow(&self, s: &EShape) -> Option<Shadow> {
        let bools = s.props.get(&0x23f).copied().unwrap_or(0);
        if bools & (1 << 17) == 0 || bools & (1 << 1) == 0 {
            return None;
        }
        let color = s.props.get(&0x201).and_then(|v| self.color(*v)).unwrap_or_else(|| "#808080".into());
        Some(Shadow {
            color,
            opacity: s.props.get(&0x204).map(|v| (*v as f64 / 65536.0).clamp(0.0, 1.0)).unwrap_or(1.0),
            dx: s.props.get(&0x205).map(|v| emu(*v)).unwrap_or(2.0),
            dy: s.props.get(&0x206).map(|v| emu(*v)).unwrap_or(2.0),
        })
    }

    /// WordArt: the text and font are "geometry text" properties of the shape.
    fn wordart(&self, s: &EShape) -> Option<WordArt> {
        let utf16 = |b: &Vec<u8>| -> String {
            let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|c| *c != 0).collect();
            String::from_utf16_lossy(&u)
        };
        let text = s.complex.get(&0xc0).map(utf16)?;
        let font = s.complex.get(&0xc5).map(utf16).filter(|f| !f.is_empty()).unwrap_or_else(|| "Arial".into());
        let bools = s.props.get(&0xff).copied().unwrap_or(0);
        let flag = |bit: u32| bools & (1 << (bit + 16)) != 0 && bools & (1 << bit) != 0;
        Some(WordArt {
            text: text.replace("\r\n", "\n").replace('\r', "\n"),
            font,
            bold: flag(5),
            italic: flag(4),
            size: s.props.get(&0xc3).map(|v| *v as f64 / 65536.0).unwrap_or(36.0),
            // gtextFStretch, on unless explicitly off
            stretch: bools & (1 << 26) == 0 || bools & (1 << 10) != 0,
            vertical: flag(13),
            extrude: self.extrude(s),
        })
    }

    /// 3-D depth (Office 3-D properties 0x280-0x2ff), drawn flat: how far and which way the sides
    /// of the letters show. Office's own projection isn't reproduced; the direction follows the
    /// object's turn when it has one, else its viewpoint (perspective) or skew (parallel)
    /// (compared with Publisher's renders of tools/makeprobe2.ps1's WordArt).
    fn extrude(&self, s: &EShape) -> Option<Extrude> {
        let b = s.props.get(&0x2bf).copied().unwrap_or(0);
        if b & 0x8 == 0 || b & 0x8_0000 == 0 {
            return None;
        }
        let depth = s.props.get(&0x285).map(|v| emu(*v)).unwrap_or(36.0).clamp(0.0, 400.0);
        let deg = |id: u16| s.props.get(&id).map(|v| (*v as i32 as f64 / 65536.0).to_radians());
        let style = s.props.get(&0x2ff).copied().unwrap_or(0);
        let (yrot, xrot) = (deg(0x2c0).unwrap_or(0.0), deg(0x2c1).unwrap_or(0.0));
        let (mut dx, mut dy);
        if yrot.abs() > 1e-6 || xrot.abs() > 1e-6 {
            // turned: the side turned towards the viewer shows
            dx = -yrot.sin();
            dy = xrot.sin();
        } else if style & 0x4 == 0 {
            // perspective: the sides show away from the viewpoint
            let vx = s.props.get(&0x2cb).map(|v| *v as i32).unwrap_or(1_250_000);
            let vy = s.props.get(&0x2cc).map(|v| *v as i32).unwrap_or(-1_250_000);
            dx = -(vx.signum() as f64) * 0.35;
            dy = (vy.signum() as f64) * 0.35;
        } else {
            // parallel: along the skew angle, by the skew amount
            let a = deg(0x2d0).unwrap_or(225f64.to_radians());
            let amount = s.props.get(&0x2d1).map(|v| *v as i32 as f64 / 100.0).unwrap_or(0.5).clamp(0.0, 1.0);
            dx = a.cos() * amount;
            dy = -a.sin() * amount;
        }
        if dx.abs() + dy.abs() < 1e-3 {
            dy = 0.3;
        }
        // (the full depth seen edge-on is too much: Office draws it foreshortened)
        let k = depth * 0.45;
        dx *= k;
        dy *= k;
        Some(Extrude { dx, dy, color: s.props.get(&0x287).and_then(|v| self.color(*v)) })
    }

    fn rect_pt(&self, r: [f64; 4]) -> [f64; 4] {
        // Publisher measures from the centre of the page
        let (cx, cy) = (self.page_w / 2.0, self.page_h / 2.0);
        [cx + r[0] / PT, cy + r[1] / PT, cx + r[2] / PT, cy + r[3] / PT]
    }

    /// Replaces inline-object markers in the text with the shapes they stand for.
    fn attach_objects(&mut self, paras: &mut [Para]) {
        for p in paras.iter_mut() {
            for r in p.runs.iter_mut() {
                let Some(n) = r.inline else { continue };
                let Some(sh) = self.info.inline_ids.get(&n).and_then(|seq| self.by_seq.get(seq)).copied() else { continue };
                let mut out = Vec::new();
                self.convert(sh, None, false, &mut out);
                if let Some(mut shape) = out.pop() {
                    let (dx, dy) = (shape.x, shape.y);
                    shift(&mut shape, -dx, -dy);
                    r.text.clear();
                    r.object = Some(Box::new(shape));
                }
            }
        }
    }

    fn text_body(&mut self, s: &EShape, story: u32) -> Option<TextBody> {
        let (_, a, b) = *self.stories.get(&story)?;
        let m = |id: u16, d: f64| s.props.get(&id).map(|v| emu(*v)).unwrap_or(d);
        let mut paras = self.text.as_ref()?.paras(a, b);
        self.attach_objects(&mut paras);
        if paras.is_empty() {
            paras.push(Para::default());
        }
        Some(TextBody {
            margins: [m(0x81, 7.2), m(0x82, 3.6), m(0x83, 7.2), m(0x84, 3.6)],
            // Office anchors: 0 top, 1 middle, 2 bottom, 3-5 the same centred, 6 top baseline,
            // 7 bottom baseline, 8 top centred baseline, 9 bottom centred baseline
            valign: match s.props.get(&0x87).copied().unwrap_or(0) {
                1 | 4 => "middle",
                2 | 5 | 7 | 9 => "bottom",
                _ => "top",
            }
            .into(),
            // columns and the gap between them (drawing properties 0x8c and 0x8d; measured with
            // tools/makeprobe7.ps1)
            columns: s.props.get(&0x8c).copied().filter(|n| (2..=63).contains(n)).unwrap_or(1) as _,
            column_gap: s.props.get(&0x8d).map(|v| emu(*v)).filter(|g| (0.0..=720.0).contains(g)).unwrap_or(COLUMN_GAP),
            rotate: match s.props.get(&0x88).copied().unwrap_or(0) {
                1 | 3 | 5 => 90.0,
                2 => 270.0,
                _ => 0.0,
            },
            paras,
            story,
            chain: 0,
            wrap: Vec::new(),
            wrap_seq: Vec::new(),
            wrap_with: None,
        })
    }

    fn table(&mut self, seq: u32, story: Option<u32>) -> Option<Table> {
        let info = self.info;
        let t = info.tables.get(&seq)?;
        let cells_info = t.cells_seq.and_then(|c| info.cells.get(&c)).cloned().unwrap_or_default();
        let mut cells = Vec::new();
        let story_range = story.and_then(|id| self.stories.get(&id).copied());
        let ends: Vec<usize> = match (story_range, self.text.as_ref()) {
            (Some((idx, _, _)), Some(cx)) => cx.q.tcd.get(&idx).cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        let styles = self.cell_shapes.get(&seq).cloned().unwrap_or_default();
        let borders = self.border_shapes.get(&seq).cloned().unwrap_or_default();
        for (i, ci) in cells_info.iter().enumerate() {
            let mut paras = Vec::new();
            if let (Some((_, a, b)), Some(cx)) = (story_range, self.text.as_ref()) {
                let start = if i == 0 { 0 } else { ends.get(i - 1).map(|e| e + 1).unwrap_or(usize::MAX) };
                let end = if i + 1 == cells_info.len() { b - a } else { ends.get(i).map(|e| e + 1).unwrap_or(0) };
                if start < end && a + end <= b {
                    paras = cx.paras(a + start, a + end);
                }
            }
            if paras.iter().any(|p| p.runs.iter().any(|r| r.inline.is_some())) {
                self.attach_objects(&mut paras);
            }
            let valign = match ci.valign {
                1 => "middle",
                2 => "bottom",
                _ => "top",
            };
            let mut cell = Cell { r0: ci.r0, r1: ci.r1.max(ci.r0), c0: ci.c0, c1: ci.c1.max(ci.c0), margins: ci.margins, valign: valign.into(), fill: None, borders: [None, None, None, None], paras };
            if let Some(cs) = styles.get(&(i as u32)).copied() {
                cell.fill = self.cell_fill(cs);
            }
            // each side takes the last border segment drawn over it
            let (r0, r1, c0, c1) = (cell.r0, cell.r1 + 1, cell.c0, cell.c1 + 1);
            for b in &borders {
                let Some((_, kind, [br0, bc0, br1, bc1])) = b.border_ref else { continue };
                let line = self.border_line(b);
                if kind == 1 && bc0 <= c0 && bc1 >= c1 {
                    if br0 == r0 {
                        cell.borders[1] = line.clone();
                    }
                    if br0 == r1 {
                        cell.borders[3] = line;
                    }
                } else if kind == 2 && br0 <= r0 && br1 >= r1 {
                    if bc0 == c0 {
                        cell.borders[0] = line.clone();
                    }
                    if bc0 == c1 {
                        cell.borders[2] = line;
                    }
                }
            }
            cells.push(cell);
        }
        Some(Table { cols: t.col_w.clone(), rows: t.row_h.clone(), cells })
    }

    fn cell_fill(&mut self, cs: &EShape) -> Option<Fill> {
        // a cell is only filled when it names a colour
        if cs.props.contains_key(&0x181) { self.fill(cs, true) } else { None }
    }

    /// Table borders are stored as thin filled bars: the fill colour is the line colour.
    fn border_line(&self, b: &EShape) -> Option<Line> {
        let filled = match b.props.get(&0x1bf).copied() {
            Some(v) if v & (1 << 20) != 0 => v & (1 << 4) != 0,
            _ => true,
        };
        let color = self.color(b.props.get(&0x181).copied().unwrap_or(0))?;
        let width = b.props.get(&0x1cb).map(|v| emu(*v)).unwrap_or(0.75);
        if !filled || width <= 0.0 {
            return None;
        }
        Some(Line { color, width, ..Default::default() })
    }

    fn convert(&mut self, s: &EShape, group: Option<GroupMap>, from_master: bool, out: &mut Vec<Shape>) {
        if s.props.get(&0x3bf).map(|v| v & 0x2_0002 == 0x2_0002).unwrap_or(false) {
            return; // hidden
        }
        let emu_rect = match (group, s.child_anchor, s.anchor) {
            (Some(g), Some(c), _) => g.map(c),
            (_, _, Some(a)) => [a[0] as f64, a[1] as f64, a[2] as f64, a[3] as f64],
            _ => return,
        };
        if !s.children.is_empty() || s.flags & 0x1 != 0 {
            let from = s.group_rect.map(|r| [r[0] as f64, r[1] as f64, r[2] as f64, r[3] as f64]).unwrap_or(emu_rect);
            let gm = GroupMap { from, to: emu_rect };
            let r = self.rect_pt(emu_rect);
            let mut g = Shape { seq: s.seq.unwrap_or(0), kind: "group".into(), x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1], from_master, ..Default::default() };
            g.rotation = s.props.get(&0x04).map(|v| *v as i32 as f64 / 65536.0).unwrap_or(0.0);
            g.flip_h = s.flags & 0x40 != 0;
            g.flip_v = s.flags & 0x80 != 0;
            for c in &s.children {
                self.convert(c, Some(gm), from_master, &mut g.children);
            }
            out.push(g);
            return;
        }
        if s.flags & 0x8 != 0 {
            return; // deleted
        }
        let [x0, y0, x1, y1] = self.rect_pt(emu_rect);
        let (mut x, mut y, mut w, mut h) = (x0.min(x1), y0.min(y1), (x1 - x0).abs(), (y1 - y0).abs());
        let rotation = s.props.get(&0x04).map(|v| *v as i32 as f64 / 65536.0).unwrap_or(0.0);
        let r = rotation.rem_euclid(360.0);
        if (45.0..135.0).contains(&r) || (225.0..315.0).contains(&r) {
            // the stored box is the rotated one: swap to get the shape's own size
            let (cx, cy) = (x + w / 2.0, y + h / 2.0);
            std::mem::swap(&mut w, &mut h);
            x = cx - w / 2.0;
            y = cy - h / 2.0;
        }
        let seq = s.seq.unwrap_or(0);
        let is_text_box = s.shape_type == 202;
        let is_table = self.info.tables.contains_key(&seq);
        let is_line = matches!(s.shape_type, 20 | 32..=40);
        let mut sh = Shape { seq, shape_type: s.shape_type, x, y, w, h, rotation, flip_h: s.flags & 0x40 != 0, flip_v: s.flags & 0x80 != 0, from_master, ..Default::default() };
        // Office defaults: shapes are filled white and outlined black unless they say otherwise;
        // pictures have neither by default
        let default_on = !s.props.contains_key(&0x104);
        sh.fill = if is_line || is_table { None } else { self.fill(s, default_on) };
        sh.line = if is_table { None } else { self.line(s, 0x1c0, default_on, 0.75) };
        sh.shadow = self.shadow(s);
        if let Some(&n) = self.info.border_art_of.get(&seq) {
            let size = s.props.get(&0x1cb).map(|v| emu(*v)).unwrap_or(0.0);
            if let (true, Some(tiles)) = ((1.0..=400.0).contains(&size), self.border_art(n)) {
                sh.border_art = Some(BorderArt { tiles, size });
                sh.line = None;
            }
        }
        if (136..=175).contains(&s.shape_type) {
            sh.wordart = self.wordart(s);
            if sh.wordart.is_some() {
                sh.kind = "shape".into();
            }
        }
        if let Some(pib) = s.props.get(&0x104).copied() {
            sh.image = self.image(pib);
            let crop = [0x102u16, 0x100, 0x103, 0x101].map(|id| s.props.get(&id).map(|v| *v as i32 as f64 / 65536.0).unwrap_or(0.0));
            if crop.iter().any(|c| *c != 0.0) {
                sh.crop = Some(crop);
            }
        }
        for id in 0x147u16..=0x150 {
            sh.adjust.push(s.props.get(&id).map(|v| *v as i32));
        }
        while sh.adjust.last() == Some(&None) {
            sh.adjust.pop();
        }
        let story = s.text_id.or_else(|| s.props.get(&0x80).copied());
        if is_table {
            sh.table = self.table(seq, story);
        } else if let Some(id) = story {
            sh.text = self.text_body(s, id);
            if let Some(t) = sh.text.as_mut() {
                // later frames of a linked chain show the rest of the first frame's story
                if let Some(&k) = self.info.chains.get(&seq) {
                    if k > 0 {
                        t.chain = k;
                        t.paras.clear();
                    }
                }
                // Publisher's own setting wins over the drawing's text anchor
                match self.info.valigns.get(&seq) {
                    Some(1) => t.valign = "middle".into(),
                    Some(2) => t.valign = "bottom".into(),
                    Some(0) => t.valign = "top".into(),
                    _ => {}
                }
                // Publisher stores the shapes a frame's text wraps around (only for frames that
                // have some) when it lays the pages out. A file it saved without laying them out
                // (made through automation) has no lists at all: then work them out from the shapes.
                t.wrap_with = if self.info.wraps.is_empty() { None } else { Some(self.info.wraps.get(&seq).cloned().unwrap_or_default()) };
            }
        }
        sh.wrap = Some(
            match self.info.wrap_types.get(&seq).copied().unwrap_or(1) {
                0 => "none",
                2 => "tight",
                3 => "through",
                4 => "topbottom",
                _ => "square",
            }
            .into(),
        );
        // Office defaults: 1/8 inch left and right, nothing above and below
        let dist = [(0x384u16, 9.0), (0x385, 0.0), (0x386, 9.0), (0x387, 0.0)].map(|(id, d)| s.props.get(&id).map(|v| emu(*v)).unwrap_or(d));
        sh.wrap_dist = Some(dist);
        sh.kind = if sh.table.is_some() {
            "table"
        } else if sh.image.is_some() {
            "picture"
        } else if is_line {
            "line"
        } else if is_text_box {
            "text"
        } else {
            "shape"
        }
        .into();
        if is_text_box && sh.text.is_none() && sh.fill.is_none() && sh.line.is_none() {
            return; // an empty, invisible frame
        }
        out.push(sh);
    }
}

/// Works out, for every text frame, the areas its text has to keep clear of: the shapes in front
/// of it on the same page whose wrapping isn't "none" (`TextBody::wrap`, relative to the frame).
/// The renderer does the same at draw time; this copy is for exporters.
/// Shapes created in OpenPub get sequence numbers from here up.
pub const NEW_SHAPE_SEQ: u32 = 1_000_000;
/// Gap between text columns when a frame does not say (0.2 cm).
const COLUMN_GAP: f64 = 72000.0 / EMU_PER_PT;

pub fn compute_wraps(doc: &mut Document) {
    fn bounds(s: &Shape) -> [f64; 4] {
        if s.rotation == 0.0 || s.kind == "group" {
            return [s.x, s.y, s.x + s.w, s.y + s.h];
        }
        let (c, si) = (s.rotation.to_radians().cos().abs(), s.rotation.to_radians().sin().abs());
        let (w, h) = (s.w * c + s.h * si, s.w * si + s.h * c);
        let (cx, cy) = (s.x + s.w / 2.0, s.y + s.h / 2.0);
        [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]
    }
    for page in &mut doc.pages {
        let obstacles: Vec<(usize, u32, [f64; 4], String, [f64; 4], bool, bool)> = page
            .shapes
            .iter()
            .enumerate()
            .map(|(i, s)| (i, s.seq, bounds(s), s.wrap.clone().unwrap_or_else(|| "square".into()), s.wrap_dist.unwrap_or([9.0, 0.0, 9.0, 0.0]), s.from_master, s.wordart.is_some()))
            .collect();
        for (i, frame) in page.shapes.iter_mut().enumerate() {
            let fr = [frame.x, frame.y, frame.x + frame.w, frame.y + frame.h];
            let from_master = frame.from_master;
            let Some(t) = frame.text.as_mut() else { continue };
            let m = t.margins;
            let allowed = t.wrap_with.clone();
            t.wrap.clear();
            t.wrap_seq.clear();
            for (j, seq, r, wrap, d, master, wordart) in &obstacles {
                // shapes Publisher didn't count as in the way stay out of it (new shapes count)
                if let Some(a) = &allowed {
                    if *seq < NEW_SHAPE_SEQ && !a.contains(seq) {
                        continue;
                    }
                }
                // WordArt wrapped tightly: around its letters, not its whole box
                let mut r = *r;
                if *wordart && (wrap == "tight" || wrap == "through") {
                    let h = r[3] - r[1];
                    r[1] += h * 0.2;
                    r[3] -= h * 0.2;
                }
                let r = &r;
                // only shapes in front of the frame, not master items over page text, not "none"
                if *j <= i || (*master && !from_master) || wrap == "none" {
                    continue;
                }
                if r[2] <= fr[0] || r[0] >= fr[2] || r[3] <= fr[1] || r[1] >= fr[3] {
                    continue;
                }
                // a shape covering the frame's whole text area - but for strips at the sides too
                // narrow for text - doesn't push its text away
                const SIDE: f64 = 12.0;
                if r[0] - d[0] <= fr[0] + m[0] + SIDE && r[1] - d[1] <= fr[1] + m[1] && r[2] + d[2] >= fr[2] - m[2] - SIDE && r[3] + d[3] >= fr[3] - m[3] {
                    continue;
                }
                // tight and through wrapping keep the distance at the sides only
                let close = wrap == "tight" || wrap == "through";
                let mut w = [r[0] - d[0], if close { r[1] } else { r[1] - d[1] }, r[2] + d[2], if close { r[3] } else { r[3] + d[3] }];
                if wrap == "topbottom" {
                    w[0] = fr[0] - 1.0;
                    w[2] = fr[2] + 1.0;
                }
                t.wrap.push([w[0] - fr[0], w[1] - fr[1], w[2] - fr[0], w[3] - fr[1]]);
                t.wrap_seq.push(*seq);
            }
        }
    }
}

fn shift(s: &mut Shape, dx: f64, dy: f64) {
    s.x += dx;
    s.y += dy;
    for c in s.children.iter_mut() {
        shift(c, dx, dy);
    }
}

pub fn load(path: &std::path::Path) -> Result<Document, String> {
    let s = read_streams(path)?;
    let info = parse_contents(&s.contents);
    let esc = parse_escher(&s.escher, &s.delay);
    let quill = parse_quill(&s.quill);
    let page_w = info.width.unwrap_or(612.0).clamp(36.0, 14400.0);
    let page_h = info.height.unwrap_or(792.0).clamp(36.0, 14400.0);
    let mut doc = Document { width: page_w, height: page_h, default_tab: info.default_tab.unwrap_or(36.0), ..Default::default() };

    let mut by_seq: HashMap<u32, &EShape> = HashMap::new();
    let mut cell_shapes: HashMap<u32, HashMap<u32, &EShape>> = HashMap::new();
    let mut border_shapes: HashMap<u32, Vec<&EShape>> = HashMap::new();
    // the drawing order is the stacking order (later = in front)
    let mut stack: HashMap<u32, (usize, usize)> = HashMap::new();
    for (di, dr) in esc.drawings.iter().enumerate() {
        for (si, sh) in dr.iter().enumerate() {
            if let Some(seq) = sh.seq {
                by_seq.insert(seq, sh);
                stack.insert(seq, (di, si));
            }
            if let Some((t, i)) = sh.cell_ref {
                cell_shapes.entry(t).or_default().insert(i, sh);
            }
            if let Some((t, _, _)) = sh.border_ref {
                border_shapes.entry(t).or_default().push(sh);
            }
        }
    }
    let mut stories = HashMap::new();
    if let Some(q) = &quill {
        for (k, (id, a, b)) in q.stories.iter().enumerate() {
            stories.insert(*id, (k, *a, *b));
        }
    }
    let mut cv = Conv { info: &info, esc: &esc, text: quill.as_ref().map(|q| TextCtx { q, palette: &info.palette }), stories, cell_shapes, by_seq: by_seq.clone(), border_shapes, page_w, page_h, images: Vec::new(), image_of_blip: HashMap::new(), border_tiles: HashMap::new() };
    let masters: HashMap<u32, &PageInfo> = info.pages.iter().filter(|p| p.is_master).map(|p| (p.seq, p)).collect();
    for p in info.pages.iter().filter(|p| !p.is_master && p.visible) {
        let number = doc.pages.len() as u32 + 1;
        let mut page = Page { name: format!("Page {number}"), number, shapes: Vec::new(), ..Default::default() };
        // the page's own background, or else its master page's
        let master = p.master.and_then(|m| masters.get(&m));
        let back = p.background.or(master.and_then(|m| m.background)).and_then(|seq| by_seq.get(&seq));
        if let Some(f) = back.and_then(|sh| cv.fill(sh, true)) {
            if f.color2.is_some() || f.image.is_some() || f.pattern.is_some() {
                page.background_fill = Some(f);
            } else if !f.color.eq_ignore_ascii_case("#ffffff") {
                page.background = Some(f.color);
            }
        }
        let in_stack_order = |list: &[u32]| {
            let mut v: Vec<u32> = list.to_vec();
            v.sort_by_key(|s| stack.get(s).copied().unwrap_or((usize::MAX, 0)));
            v
        };
        if let Some(m) = master {
            for seq in in_stack_order(&m.shapes) {
                if let Some(sh) = by_seq.get(&seq) {
                    cv.convert(sh, None, true, &mut page.shapes);
                }
            }
        }
        for seq in in_stack_order(&p.shapes) {
            if let Some(sh) = by_seq.get(&seq) {
                cv.convert(sh, None, false, &mut page.shapes);
            }
        }
        doc.pages.push(page);
    }
    if doc.pages.is_empty() {
        doc.notes.push("No pages could be read from this file.".into());
        doc.pages.push(Page { name: "Page 1".into(), number: 1, shapes: Vec::new(), ..Default::default() });
    }
    doc.images = cv.images;
    compute_wraps(&mut doc);
    crate::fonts::attach(&mut doc);
    Ok(doc)
}
