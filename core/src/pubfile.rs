//! Reader for Microsoft Publisher .pub files (Publisher 2003 and later, best effort for others).
//!
//! A .pub file is an OLE compound file holding:
//! * `Contents` – document/page/shape chunks (page size, page list, colour scheme),
//! * `Escher/EscherStm` (+ `EscherDelayStm`) – Office drawing records: shapes, positions, colours, pictures,
//! * `Quill/QuillSub/CONTENTS` – the text stories with character and paragraph formatting.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;

const EMU_PER_INCH: f64 = 914400.0;
const EMU_PER_PT: f64 = 12700.0;

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    d.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
}
fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
fn i32_at(d: &[u8], o: usize) -> Option<i32> {
    u32_at(d, o).map(|v| v as i32)
}

// ---------------------------------------------------------------------------------------------
// The tagged block format shared by `Contents` and the Quill text stream.

#[derive(Clone, Debug)]
enum BVal {
    None,
    Int(u32),
    Bytes(Vec<u8>),
    Str(String),
    List(Vec<Block>),
}

#[derive(Clone, Debug)]
struct Block {
    id: u8,
    ty: u8,
    val: BVal,
    /// Where the block's data sits in the stream (after its length field for variable-length blocks).
    span: (usize, usize),
}

fn block_len(ty: u8) -> i32 {
    match ty {
        0x78 | 0x05 | 0x08 | 0x0a => 0,
        0x10 | 0x12 | 0x18 | 0x1a | 0x07 => 2,
        0x20 | 0x22 | 0x58 | 0x68 | 0x70 | 0xb8 => 4,
        0x28 => 8,
        0x38 => 16,
        0x48 => 24,
        0xc0 | 0x80 | 0x82 | 0x88 | 0x8a | 0x90 | 0x98 | 0xa0 => -1,
        _ => 0,
    }
}

fn parse_blocks(d: &[u8], mut o: usize, end: usize, depth: u32) -> Vec<Block> {
    let mut out = Vec::new();
    let end = end.min(d.len());
    while o + 2 <= end {
        let id = d[o];
        let ty = d[o + 1];
        let p = o + 2;
        let l = block_len(ty);
        if l < 0 {
            let Some(len) = u32_at(d, p) else { break };
            let len = len as usize;
            if len < 4 || p + len > end {
                break;
            }
            let val = if ty == 0xc0 {
                BVal::Str(utf16(&d[p + 4..p + len]))
            } else if depth < 12 {
                BVal::List(parse_blocks(d, p + 4, p + len, depth + 1))
            } else {
                BVal::None
            };
            out.push(Block { id, ty, val, span: (p + 4, p + len) });
            o = p + len;
        } else {
            let l = l as usize;
            if p + l > end {
                break;
            }
            let val = match l {
                0 => BVal::None,
                2 => BVal::Int(u16_at(d, p).unwrap() as u32),
                4 => BVal::Int(u32_at(d, p).unwrap()),
                _ => BVal::Bytes(d[p..p + l].to_vec()),
            };
            out.push(Block { id, ty, val, span: (p, p + l) });
            o = p + l;
        }
    }
    out
}

fn utf16(b: &[u8]) -> String {
    let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&u).trim_end_matches('\0').to_string()
}

fn find<'a>(bs: &'a [Block], id: u8) -> Option<&'a Block> {
    bs.iter().find(|b| b.id == id)
}
fn int(bs: &[Block], id: u8) -> Option<u32> {
    match find(bs, id).map(|b| &b.val) {
        Some(BVal::Int(v)) => Some(*v),
        _ => None,
    }
}
fn list<'a>(bs: &'a [Block], id: u8) -> Option<&'a [Block]> {
    match find(bs, id).map(|b| &b.val) {
        Some(BVal::List(l)) => Some(l.as_slice()),
        _ => None,
    }
}
fn has(bs: &[Block], id: u8) -> bool {
    find(bs, id).is_some()
}

/// Reads a chunk: a u32 length followed by blocks.
fn chunk_blocks(d: &[u8], off: usize) -> Vec<Block> {
    match u32_at(d, off) {
        Some(len) if len >= 4 => parse_blocks(d, off + 4, off + len as usize, 0),
        _ => Vec::new(),
    }
}
// ---------------------------------------------------------------------------------------------
// Escher (Office drawing) stream

#[derive(Clone, Debug, Default)]
struct EShape {
    spid: u32,
    shape_type: u16,
    flags: u32,
    props: HashMap<u16, u32>,
    complex: HashMap<u16, Vec<u8>>,
    anchor: Option<[i32; 4]>,
    child_anchor: Option<[i32; 4]>,
    group_rect: Option<[i32; 4]>,
    seq: Option<u32>,
    text_id: Option<u32>,
    children: Vec<EShape>,
    /// (record type, instance, offset of body, length) of every record in the shape container
    recs: Vec<(u16, u16, usize, usize)>,
    /// For the hidden shapes that style table cells: (table chunk seq, cell index).
    cell_ref: Option<(u32, u32)>,
    /// For the hidden shapes that draw table borders: (table chunk seq, kind 1 = horizontal /
    /// 2 = vertical, [first row line, first column line, last row line, last column line]).
    border_ref: Option<(u32, u32, [u32; 4])>,
    anchor_dbg: String,
}

#[derive(Default)]
struct Escher {
    drawings: Vec<Vec<EShape>>,
    blips: Vec<Option<(Vec<u8>, Option<String>)>>,
}

fn rec_header(d: &[u8], o: usize) -> Option<(u16, u16, u16, usize)> {
    let vi = u16_at(d, o)?;
    let ty = u16_at(d, o + 2)?;
    let len = u32_at(d, o + 4)? as usize;
    Some((vi & 0xf, vi >> 4, ty, len))
}

fn parse_escher(d: &[u8], delay: &[u8]) -> Escher {
    let mut e = Escher::default();
    let mut o = 0;
    while let Some((ver, _inst, ty, len)) = rec_header(d, o) {
        let body = o + 8;
        let end = (body + len).min(d.len());
        if ver == 0xf {
            match ty {
                0xF000 => parse_dgg(d, body, end, delay, &mut e),
                0xF002 => {
                    let mut shapes = Vec::new();
                    let mut q = body;
                    while let Some((_, _, cty, clen)) = rec_header(d, q) {
                        if q + 8 + clen > end {
                            break;
                        }
                        if cty == 0xF003 {
                            parse_spgr(d, q + 8, q + 8 + clen, &mut shapes, 0);
                        }
                        q += 8 + clen;
                    }
                    e.drawings.push(shapes);
                }
                _ => {}
            }
        }
        o = body + len;
        if ty == 0xF000 || ty == 0xF002 {
            o += 4; // Publisher stores a 4-byte tail after these containers
        }
        if o >= d.len() {
            break;
        }
    }
    e
}

fn parse_dgg(d: &[u8], start: usize, end: usize, delay: &[u8], e: &mut Escher) {
    let mut o = start;
    while let Some((_, _, ty, len)) = rec_header(d, o) {
        if o + 8 + len > end {
            break;
        }
        if ty == 0xF001 {
            let mut q = o + 8;
            let qend = o + 8 + len;
            while let Some((_, _, bty, blen)) = rec_header(d, q) {
                if q + 8 + blen > qend {
                    break;
                }
                if bty == 0xF007 {
                    e.blips.push(parse_bse(d, q + 8, q + 8 + blen, delay));
                } else {
                    e.blips.push(None);
                }
                q += 8 + blen;
            }
        }
        o += 8 + len;
    }
}

/// One BStore entry: the picture data is embedded after the 36-byte header, or in the delay stream.
fn parse_bse(d: &[u8], start: usize, end: usize, delay: &[u8]) -> Option<(Vec<u8>, Option<String>)> {
    let size = u32_at(d, start + 20)? as usize;
    let fo = u32_at(d, start + 28)? as usize;
    let name_len = *d.get(start + 33)? as usize;
    let blip_at = start + 36 + name_len * 2;
    if blip_at + 8 <= end {
        if let Some(b) = parse_blip(d, blip_at) {
            return Some(b);
        }
    }
    if size > 0 && fo + 8 <= delay.len() {
        return parse_blip(delay, fo);
    }
    None
}

fn parse_blip(d: &[u8], o: usize) -> Option<(Vec<u8>, Option<String>)> {
    let (_, inst, ty, len) = rec_header(d, o)?;
    let body = o + 8;
    let end = (body + len).min(d.len());
    // header size: one or two 16-byte UIDs, then for raster blips a 1-byte tag; metafiles have a 34-byte header
    let two_uids = |a: u16, b: u16| inst == a || inst == b;
    match ty {
        0xF01D | 0xF02A | 0xF01E | 0xF01F | 0xF029 => {
            let (a, b) = match ty {
                0xF01D | 0xF02A => (0x46A, 0x6E2),
                0xF01E => (0x6E0, 0x6E0),
                0xF01F => (0x7A8, 0x7A8),
                _ => (0x6E4, 0x6E4),
            };
            let hdr = if two_uids(a + 1, b + 1) { 33 } else { 17 };
            let data = d.get(body + hdr..end)?.to_vec();
            if ty == 0xF01F {
                return Some((dib_to_bmp(&data), None));
            }
            Some((data, None))
        }
        0xF01A | 0xF01B | 0xF01C => {
            let label = match ty {
                0xF01A => "EMF picture",
                0xF01B => "WMF picture",
                _ => "PICT picture",
            };
            let placeholder = Some((Vec::new(), Some(label.to_string())));
            if ty == 0xF01C {
                return placeholder; // Mac PICT drawings aren't drawn
            }
            // one or two 16-byte ids, then a 34-byte header: uncompressed size, bounds,
            // size in EMU, stored size, compression (0 = deflate, 0xFE = none)
            let second = matches!(inst, 0x3D5 | 0x217);
            let h = body + if second { 32 } else { 16 };
            let raw_size = u32_at(d, h)? as usize;
            let (ex, ey) = (i32_at(d, h + 20)?, i32_at(d, h + 24)?);
            let saved = u32_at(d, h + 28)? as usize;
            let compression = *d.get(h + 32)?;
            let stored = d.get(h + 34..(h + 34 + saved).min(end))?;
            let data = if compression == 0 { inflate(stored, raw_size) } else { Some(stored.to_vec()) };
            let Some(data) = data else { return placeholder };
            // draw at 150 dots per inch from the picture's own size
            let (mut w, mut hh) = ((ex.max(0) as f64 / 914_400.0 * 150.0) as u32, (ey.max(0) as f64 / 914_400.0 * 150.0) as u32);
            if w < 8 || hh < 8 {
                (w, hh) = (600, 600);
            }
            let k = (2400.0 / w.max(hh) as f64).min(1.0);
            let (w, hh) = (((w as f64) * k) as u32, ((hh as f64) * k) as u32);
            match crate::metafile::to_png(&data, ty == 0xF01B, w, hh) {
                Some(png) => Some((png, None)),
                None => placeholder,
            }
        }
        _ => None,
    }
}

/// Office compresses metafiles with deflate (usually with a zlib header).
fn inflate(data: &[u8], expected: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let limit = (expected.max(1) as u64).min(256 * 1024 * 1024) + 1024;
    let mut out = Vec::with_capacity(expected.min(64 * 1024 * 1024));
    if flate2::read::ZlibDecoder::new(data).take(limit).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    out.clear();
    flate2::read::DeflateDecoder::new(data).take(limit).read_to_end(&mut out).ok()?;
    (!out.is_empty()).then_some(out)
}

/// A DIB without its file header: add one so image decoders accept it.
fn dib_to_bmp(dib: &[u8]) -> Vec<u8> {
    let hdr_size = u32_at(dib, 0).unwrap_or(40);
    let bits = u16_at(dib, 14).unwrap_or(24) as u32;
    let colors = u32_at(dib, 32).unwrap_or(0);
    let palette = if bits <= 8 { (if colors == 0 { 1 << bits } else { colors }) * 4 } else { 0 };
    let offset = 14 + hdr_size + palette;
    let mut out = Vec::with_capacity(dib.len() + 14);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((dib.len() + 14) as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(dib);
    out
}

fn parse_spgr(d: &[u8], start: usize, end: usize, out: &mut Vec<EShape>, depth: u32) {
    let mut o = start;
    let mut group: Option<EShape> = None;
    let mut first = true;
    while let Some((_, _, ty, len)) = rec_header(d, o) {
        if o + 8 + len > end {
            break;
        }
        match ty {
            0xF004 => {
                let sh = parse_sp(d, o + 8, o + 8 + len);
                if first {
                    // the first shape of a group container describes the group itself
                    group = Some(sh);
                } else if let Some(g) = group.as_mut() {
                    g.children.push(sh);
                } else {
                    out.push(sh);
                }
            }
            0xF003 if depth < 16 => {
                let mut kids = Vec::new();
                parse_spgr(d, o + 8, o + 8 + len, &mut kids, depth + 1);
                if let Some(g) = group.as_mut() {
                    g.children.extend(kids);
                } else {
                    out.extend(kids);
                }
            }
            _ => {}
        }
        first = false;
        o += 8 + len;
    }
    if let Some(g) = group {
        if g.flags & 0x4 != 0 {
            // patriarch: its children are the top-level shapes of the drawing
            out.extend(g.children);
        } else {
            out.push(g);
        }
    }
}

fn client_blocks(d: &[u8], start: usize, end: usize) -> Vec<Block> {
    // Publisher writes the length again, then tagged blocks
    match u32_at(d, start) {
        Some(len) if len as usize >= 4 && start + len as usize <= end => parse_blocks(d, start + 4, start + len as usize, 0),
        _ => Vec::new(),
    }
}

fn parse_sp(d: &[u8], start: usize, end: usize) -> EShape {
    let mut sh = EShape::default();
    let mut o = start;
    while let Some((_, inst, ty, len)) = rec_header(d, o) {
        if o + 8 + len > end {
            break;
        }
        let b = o + 8;
        sh.recs.push((ty, inst, b, len));
        match ty {
            0xF00A => {
                sh.shape_type = inst;
                sh.spid = u32_at(d, b).unwrap_or(0);
                sh.flags = u32_at(d, b + 4).unwrap_or(0);
            }
            0xF009 => {
                sh.group_rect = Some([i32_at(d, b).unwrap_or(0), i32_at(d, b + 4).unwrap_or(0), i32_at(d, b + 8).unwrap_or(0), i32_at(d, b + 12).unwrap_or(0)]);
            }
            0xF00B | 0xF121 | 0xF122 => {
                let primary = ty == 0xF00B;
                let n = inst as usize;
                let mut cpos = b + n * 6;
                for i in 0..n {
                    let pid = u16_at(d, b + i * 6).unwrap_or(0);
                    let val = u32_at(d, b + i * 6 + 2).unwrap_or(0);
                    let id = pid & 0x3fff;
                    let complex = pid & 0x8000 != 0;
                    if complex {
                        let l = val as usize;
                        if cpos + l <= b + len {
                            sh.complex.insert(id, d[cpos..cpos + l].to_vec());
                        }
                        cpos += l;
                        continue;
                    }
                    let is_bool = id & 0x3f == 0x3f;
                    match sh.props.get(&id) {
                        Some(old) if is_bool => {
                            let merged = *old | val;
                            sh.props.insert(id, merged);
                        }
                        Some(_) if !primary => {}
                        _ => {
                            sh.props.insert(id, val);
                        }
                    }
                }
            }
            0xF010 => {
                let bs = client_blocks(d, b, b + len);
                sh.anchor_dbg = blocks_inline(&bs);
                if let (Some(x1), Some(y1), Some(x2), Some(y2)) = (int(&bs, 1), int(&bs, 2), int(&bs, 3), int(&bs, 4)) {
                    sh.anchor = Some([x1 as i32, y1 as i32, x2 as i32, y2 as i32]);
                } else if let Some(t) = bs.iter().find(|x| x.id == 2 && x.ty == 0x68).and_then(|x| if let BVal::Int(v) = x.val { Some(v) } else { None }) {
                    let g = |id: u8| int(&bs, id).unwrap_or(0);
                    match int(&bs, 1) {
                        Some(kind) => sh.border_ref = Some((t, kind, [g(4), g(5), g(6), g(7)])),
                        None => sh.cell_ref = Some((t, g(3))),
                    }
                } else if !bs.is_empty() || len == 4 {
                    // other tagged anchors carry no rectangle
                } else if len == 16 {
                    sh.anchor = Some([i32_at(d, b).unwrap(), i32_at(d, b + 4).unwrap(), i32_at(d, b + 8).unwrap(), i32_at(d, b + 12).unwrap()]);
                } else if len == 20 {
                    sh.anchor = Some([i32_at(d, b + 4).unwrap(), i32_at(d, b + 8).unwrap(), i32_at(d, b + 12).unwrap(), i32_at(d, b + 16).unwrap()]);
                }
            }
            0xF00F => {
                if len >= 16 {
                    sh.child_anchor = Some([i32_at(d, b).unwrap(), i32_at(d, b + 4).unwrap(), i32_at(d, b + 8).unwrap(), i32_at(d, b + 12).unwrap()]);
                }
            }
            0xF011 => {
                let bs = client_blocks(d, b, b + len);
                sh.seq = int(&bs, 1).or_else(|| if len == 8 { u32_at(d, b + 4) } else { None });
            }
            0xF00D => {
                let bs = client_blocks(d, b, b + len);
                sh.text_id = int(&bs, 1).or_else(|| if len == 8 { u32_at(d, b + 4) } else { None });
            }
            _ => {}
        }
        o += 8 + len;
    }
    sh
}
// ---------------------------------------------------------------------------------------------
// Quill text stream

#[derive(Clone, Debug)]
struct QRef {
    name: String,
    id: u16,
    offset: usize,
    len: usize,
}
fn quill_refs(d: &[u8]) -> Vec<QRef> {
    let mut refs = Vec::new();
    let mut off = 0x18usize;
    let mut seen = HashSet::new();
    while off != 0xffff_ffff && off + 8 <= d.len() && seen.insert(off) {
        let n = u16_at(d, off + 2).unwrap_or(0) as usize;
        let next = u32_at(d, off + 4).unwrap_or(0xffff_ffff) as usize;
        let mut p = off + 8;
        for _ in 0..n {
            let size = u16_at(d, p).unwrap_or(24) as usize;
            if p + 24 > d.len() {
                break;
            }
            let name = String::from_utf8_lossy(&d[p + 2..p + 6]).to_string();
            let id = u16_at(d, p + 6).unwrap_or(0);
            let offset = u32_at(d, p + 16).unwrap_or(0) as usize;
            let len = u32_at(d, p + 20).unwrap_or(0) as usize;
            refs.push(QRef { name, id, offset, len });
            p += size.max(24);
        }
        off = next;
    }
    refs
}

/// Offsets table used by FONT and STSH chunks: entries start at chunk+0x14, relative to it.
fn table_entries(d: &[u8], r: &QRef) -> Vec<usize> {
    let Some(count) = u32_at(d, r.offset + 4) else { return Vec::new() };
    let base = r.offset + 0x14;
    (0..count.min(10000) as usize).filter_map(|i| u32_at(d, base + i * 4).map(|v| base + v as usize)).filter(|o| *o < r.offset + r.len).collect()
}

/// Formatting pages (FDPC/FDPP): [n][?][(n+1) stream offsets][n prop offsets], props are u32 len + blocks.
fn fdp_runs(d: &[u8], r: &QRef) -> Vec<(usize, usize, Vec<Block>)> {
    let mut out = Vec::new();
    let mut page = r.offset;
    while page + 8 <= r.offset + r.len && page + 8 <= d.len() {
        let n = u16_at(d, page).unwrap_or(0) as usize;
        if n == 0 || n > 200 {
            page += 512;
            continue;
        }
        let fcs: Vec<usize> = (0..=n).filter_map(|i| u32_at(d, page + 4 + i * 4).map(|v| v as usize)).collect();
        let offs_at = page + 4 + (n + 1) * 4;
        for j in 0..n {
            let po = u16_at(d, offs_at + j * 2).unwrap_or(0) as usize;
            let bs = if po == 0 { Vec::new() } else { chunk_blocks(d, page + po) };
            if j + 1 < fcs.len() {
                out.push((fcs[j], fcs[j + 1], bs));
            }
        }
        page += 512;
    }
    out
}

#[derive(Default, Clone)]
struct RunProps {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    size: Option<f32>,
    color: Option<u32>,
    font: Option<u32>,
    script: Option<u8>,
    /// field type of the character (5 = page number)
    field: Option<u32>,
}

#[derive(Default, Clone)]
struct ParaProps {
    style: Option<u32>,
    align: Option<u32>,
    left: Option<i32>,
    right: Option<i32>,
    first: Option<i32>,
    before: Option<u32>,
    after: Option<u32>,
    spacing: Option<u32>,
    bullet: Option<u32>,
    bullet_font: Option<u32>,
    /// list style: 0 1. 1 I. 2 i. 3 A. 4 a. 5 1st 6 One 7 First; 0x17 = bullet
    list_style: Option<u32>,
    /// list number separator (high word of property 0x58): 0 ")", 2 "."
    list_sep: Option<u32>,
    list_start: Option<u32>,
    tabs: Vec<(u32, u32)>,
}

fn run_props(bs: &[Block]) -> RunProps {
    let mut r = RunProps::default();
    for b in bs {
        match (b.id, &b.val) {
            // 0x37 and 0x38 are bold and italic for complex scripts only
            (0x02, BVal::None) => r.bold = Some(true),
            (0x03, BVal::None) => r.italic = Some(true),
            (0x1e, BVal::Int(v)) => r.underline = Some(*v != 0),
            (0x1e, BVal::None) => r.underline = Some(true),
            (0x0c, BVal::Int(v)) => r.size = Some((*v as f64 / EMU_PER_PT) as f32),
            (0x44, BVal::List(l)) => r.color = int(l, 0),
            (0x0f, BVal::Int(v)) => r.script = Some(*v as u8),
            (0x00, BVal::Int(v)) => r.field = Some(*v),
            (0x24, BVal::List(l)) => {
                // one font per script; entry 0 is the Latin font
                if let Some(inner) = list(l, 0) {
                    r.font = int(inner, 0);
                }
            }
            _ => {}
        }
    }
    r
}

fn para_props(bs: &[Block]) -> ParaProps {
    let mut p = ParaProps::default();
    for b in bs {
        match (b.id, &b.val) {
            (0x03, BVal::Int(v)) => p.bullet_font = Some(*v),
            (0x32, BVal::List(l)) => {
                for t in list(l, 0x28).unwrap_or(&[]) {
                    if let BVal::List(sub) = &t.val {
                        p.tabs.push((int(sub, 0).unwrap_or(0), int(sub, 1).unwrap_or(0)));
                    }
                }
            }
            (0x04, BVal::Int(v)) => p.align = Some(*v),
            (0x0c, BVal::Int(v)) => p.first = Some(*v as i32),
            (0x0d, BVal::Int(v)) => p.left = Some(*v as i32),
            (0x0e, BVal::Int(v)) => p.right = Some(*v as i32),
            (0x12, BVal::Int(v)) => p.before = Some(*v),
            (0x13, BVal::Int(v)) => p.after = Some(*v),
            (0x34, BVal::Int(v)) => p.spacing = Some(*v),
            (0x57, BVal::List(l)) => {
                p.bullet = int(l, 1);
                p.list_style = int(l, 0);
            }
            (0x58, BVal::Int(v)) => p.list_sep = Some(*v >> 16),
            (0x15, BVal::Int(v)) => p.list_start = Some(*v),
            _ => {}
        }
    }
    p
}

impl ParaProps {
    fn over(&self, base: &ParaProps) -> ParaProps {
        ParaProps {
            style: self.style.or(base.style),
            align: self.align.or(base.align),
            left: self.left.or(base.left),
            right: self.right.or(base.right),
            first: self.first.or(base.first),
            before: self.before.or(base.before),
            after: self.after.or(base.after),
            spacing: self.spacing.or(base.spacing),
            bullet: self.bullet.or(base.bullet),
            bullet_font: self.bullet_font.or(base.bullet_font),
            list_style: self.list_style.or(base.list_style),
            list_sep: self.list_sep.or(base.list_sep),
            list_start: self.list_start.or(base.list_start),
            tabs: if self.tabs.is_empty() { base.tabs.clone() } else { self.tabs.clone() },
        }
    }
}

impl RunProps {
    fn over(&self, base: &RunProps) -> RunProps {
        RunProps {
            bold: self.bold.or(base.bold),
            italic: self.italic.or(base.italic),
            underline: self.underline.or(base.underline),
            size: self.size.or(base.size),
            color: self.color.or(base.color),
            font: self.font.or(base.font),
            script: self.script.or(base.script),
            field: self.field,
        }
    }
}

struct QuillData {
    chars: Vec<u16>,
    /// (story id, first char, end char)
    stories: Vec<(u32, usize, usize)>,
    fonts: Vec<String>,
    /// raw colour references (Office colour refs) indexed by text colour index
    colors: Vec<u32>,
    style_runs: Vec<RunProps>,
    style_paras: Vec<ParaProps>,
    cprops: Vec<Option<usize>>,
    runs: Vec<RunProps>,
    run_blocks: Vec<Vec<Block>>,
    pprops: Vec<Option<usize>>,
    paras: Vec<ParaProps>,
    para_blocks: Vec<Vec<Block>>,
    style_blocks: Vec<(Vec<Block>, Vec<Block>)>,
    /// story index -> index of the last character of each table cell
    tcd: HashMap<usize, Vec<usize>>,
    /// position in the text stream -> number of the inline object anchored there
    eobj: HashMap<usize, u32>,
}

fn parse_quill(d: &[u8]) -> Option<QuillData> {
    if d.len() < 0x20 {
        return None;
    }
    let refs = quill_refs(d);
    let text_ref = refs.iter().find(|r| r.name == "TEXT")?;
    let text_bytes = d.get(text_ref.offset..(text_ref.offset + text_ref.len).min(d.len()))?;
    let chars: Vec<u16> = text_bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();

    // story ids and lengths
    let mut ids: Vec<u32> = Vec::new();
    if let Some(r) = refs.iter().find(|r| r.name == "SYID") {
        let n = u32_at(d, r.offset + 4).unwrap_or(0).min(10000) as usize;
        ids = (0..n).filter_map(|i| u32_at(d, r.offset + 8 + i * 4)).collect();
    }
    let mut lengths: Vec<usize> = Vec::new();
    if let Some(r) = refs.iter().find(|r| r.name == "STRS" || (r.name == "TCD " && r.id == 2)) {
        let n = u32_at(d, r.offset).unwrap_or(0).min(10000) as usize;
        let skip = u32_at(d, r.offset + 4).unwrap_or(8) as usize;
        let at = r.offset + 4 + skip;
        lengths = (0..n).filter_map(|i| u32_at(d, at + i * 4).map(|v| v as usize)).collect();
    }
    if lengths.iter().sum::<usize>() > chars.len() || lengths.is_empty() {
        // unknown layout: one story per run of text ending with a blank paragraph pair
        lengths = vec![chars.len()];
    }
    if ids.len() != lengths.len() {
        ids = (0..lengths.len() as u32).collect();
    }

    // fonts
    let mut fonts: Vec<String> = Vec::new();
    if let Some(r) = refs.iter().find(|r| r.name == "FONT") {
        for o in table_entries(d, r) {
            let n = u16_at(d, o).unwrap_or(0) as usize;
            if let Some(b) = d.get(o + 2..o + 2 + n * 2) {
                fonts.push(utf16(b));
            }
        }
    }
    // text colours
    let mut colors: Vec<u32> = Vec::new();
    if let Some(r) = refs.iter().find(|r| r.name == "PL  ") {
        let n = u32_at(d, r.offset).unwrap_or(0).min(1000) as usize;
        let mut o = r.offset + 12;
        for _ in 0..n {
            let Some(len) = u32_at(d, o) else { break };
            let bs = parse_blocks(d, o + 4, o + len as usize, 0);
            colors.push(int(&bs, 1).unwrap_or(0));
            o += (len as usize).max(4);
        }
    }
    // style sheet: pairs of (character props, paragraph props)
    let mut style_runs: Vec<RunProps> = Vec::new();
    let mut style_paras: Vec<ParaProps> = Vec::new();
    let mut style_blocks = Vec::new();
    if let Some(r) = refs.iter().find(|r| r.name == "STSH" && r.id == 1) {
        let entries = table_entries(d, r);
        for pair in entries.chunks(2) {
            let parse = |o: usize| -> Vec<Block> {
                match u32_at(d, o + 2) {
                    Some(len) if len >= 4 => parse_blocks(d, o + 6, o + 2 + len as usize, 0),
                    _ => Vec::new(),
                }
            };
            let rb = parse(pair[0]);
            let pb = pair.get(1).map(|o| parse(*o)).unwrap_or_default();
            style_runs.push(run_props(&rb));
            style_paras.push(para_props(&pb));
            style_blocks.push((rb, pb));
        }
    }

    // per-char formatting over the whole text
    let base = text_ref.offset;
    let n = chars.len();
    let mut cprops: Vec<Option<usize>> = vec![None; n];
    let mut runs: Vec<RunProps> = Vec::new();
    let mut run_blocks = Vec::new();
    for r in refs.iter().filter(|r| r.name == "FDPC") {
        for (a, b, bs) in fdp_runs(d, r) {
            let idx = runs.len();
            runs.push(run_props(&bs));
            run_blocks.push(bs);
            let s = a.saturating_sub(base) / 2;
            let e = (b.saturating_sub(base) / 2).min(n);
            for c in cprops.iter_mut().take(e).skip(s) {
                *c = Some(idx);
            }
        }
    }
    let mut pprops: Vec<Option<usize>> = vec![None; n];
    let mut paras: Vec<ParaProps> = Vec::new();
    let mut para_blocks = Vec::new();
    for r in refs.iter().filter(|r| r.name == "FDPP") {
        for (a, b, bs) in fdp_runs(d, r) {
            let idx = paras.len();
            paras.push(para_props(&bs));
            para_blocks.push(bs);
            let s = a.saturating_sub(base) / 2;
            let e = (b.saturating_sub(base) / 2).min(n);
            for c in pprops.iter_mut().take(e).skip(s) {
                *c = Some(idx);
            }
        }
    }

    let mut stories = Vec::new();
    let mut pos = 0usize;
    for (k, len) in lengths.iter().enumerate() {
        let e = (pos + len).min(n);
        stories.push((ids[k], pos, e));
        pos = e;
    }
    let mut tcd = HashMap::new();
    for r in refs.iter().filter(|r| r.name == "TCD ") {
        let ends: Vec<usize> = (3..r.len / 4).filter_map(|i| u32_at(d, r.offset + i * 4).map(|v| v as usize)).collect();
        tcd.insert(r.id as usize, ends);
    }
    let mut eobj = HashMap::new();
    for r in refs.iter().filter(|r| r.name == "EOBJ") {
        let Some(&(_, start, _)) = stories.get(r.id as usize) else { continue };
        let count = u32_at(d, r.offset).unwrap_or(0).min(10000) as usize;
        for i in 0..count {
            let at = r.offset + 12 + i * 12;
            if at + 12 > r.offset + r.len {
                break;
            }
            if let (Some(pos), Some(n)) = (u32_at(d, at), u32_at(d, at + 8)) {
                eobj.insert(start + pos as usize, n);
            }
        }
    }
    Some(QuillData { eobj, tcd, chars, stories, fonts, colors, style_runs, style_paras, cprops, runs, run_blocks, pprops, paras, para_blocks, style_blocks })
}

fn esc_text(chars: &[u16]) -> String {
    let mut s = String::new();
    for &c in chars {
        match c {
            0x20..=0x7e => s.push(c as u8 as char),
            c if c < 0x20 => s.push_str(&format!("<{c:02x}>")),
            c => s.push(char::from_u32(c as u32).unwrap_or('?')),
        }
    }
    s
}

fn blocks_inline(bs: &[Block]) -> String {
    let mut parts = Vec::new();
    for b in bs {
        parts.push(match &b.val {
            BVal::None => format!("{:02x}", b.id),
            BVal::Int(v) => format!("{:02x}={:x}", b.id, v),
            BVal::Bytes(x) => format!("{:02x}={:02x?}", b.id, x),
            BVal::Str(s) => format!("{:02x}={s:?}", b.id),
            BVal::List(l) if b.id == 0x24 && l.len() > 8 => format!("24[font {:?}]", int(l, 0)),
            BVal::List(l) => format!("{:02x}[{}]", b.id, blocks_inline(l)),
        });
    }
    parts.join(" ")
}

pub fn dump_text(path: &std::path::Path) -> Result<String, String> {
    use std::fmt::Write;
    let s = read_streams(path)?;
    let q = parse_quill(&s.quill).ok_or("no text")?;
    let mut out = String::new();
    let _ = writeln!(out, "fonts {:?}", q.fonts);
    let _ = writeln!(out, "colors {:x?}", q.colors);
    for (i, (rb, pb)) in q.style_blocks.iter().enumerate() {
        let _ = writeln!(out, "style {i}: C {} | P {}", blocks_inline(rb), blocks_inline(pb));
    }
    for r in quill_refs(&s.quill).iter().filter(|r| r.name == "TCD " || r.name == "STRS" || r.name == "SYID") {
        let v: Vec<u32> = (0..(r.len / 4).min(40)).filter_map(|i| u32_at(&s.quill, r.offset + i * 4)).collect();
        let _ = writeln!(out, "{} {} : {:?}", r.name, r.id, v);
    }
    for (k, (id, a, b)) in q.stories.iter().enumerate() {
        let _ = writeln!(out, "STORY {id} index {k} chars {a}..{b}");
        let mut i = *a;
        while i < *b {
            let mut j = i;
            while j < *b && q.chars[j] != 0x0d {
                j += 1;
            }
            let mark = j.min(*b - 1);
            let pb = q.pprops[mark].map(|x| blocks_inline(&q.para_blocks[x])).unwrap_or_default();
            let _ = writeln!(out, "  P {{{pb}}}");
            // runs
            let mut k = i;
            while k <= mark {
                let mut m = k;
                while m <= mark && q.cprops[m] == q.cprops[k] {
                    m += 1;
                }
                let rb = q.cprops[k].map(|x| blocks_inline(&q.run_blocks[x])).unwrap_or_default();
                let _ = writeln!(out, "    R {{{rb}}} \"{}\"", esc_text(&q.chars[k..m]));
                k = m;
            }
            i = j + 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Raw structure dump (developer aid)

struct Streams {
    contents: Vec<u8>,
    escher: Vec<u8>,
    delay: Vec<u8>,
    quill: Vec<u8>,
}

fn read_streams(path: &std::path::Path) -> Result<Streams, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    let mut comp = cfb::CompoundFile::open(file).map_err(|_| "This file isn't a Publisher document (it isn't an OLE compound file).".to_string())?;
    let mut read = |name: &str| -> Vec<u8> {
        let mut buf = Vec::new();
        if let Ok(mut s) = comp.open_stream(name) {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    };
    let s = Streams { contents: read("/Contents"), escher: read("/Escher/EscherStm"), delay: read("/Escher/EscherDelayStm"), quill: read("/Quill/QuillSub/CONTENTS") };
    if s.contents.is_empty() && s.quill.is_empty() && s.escher.is_empty() {
        return Err("This compound file has none of the parts a Publisher document has.".into());
    }
    Ok(s)
}

/// seq -> (chunk type, offset, parent seq)
fn contents_chunks(d: &[u8]) -> BTreeMap<u32, (u32, usize, Option<u32>)> {
    let mut chunks = BTreeMap::new();
    let Some(trailer) = u32_at(d, 0x1a).map(|v| v as usize) else { return chunks };
    if trailer + 4 >= d.len() {
        return chunks;
    }
    let mut o = trailer + 4;
    let mut dir: Option<(usize, usize)> = None;
    for i in 0..3 {
        let Some(&ty) = d.get(o + 1) else { return chunks };
        let l = block_len(ty);
        let p = o + 2;
        if l < 0 {
            let Some(len) = u32_at(d, p).map(|v| v as usize) else { return chunks };
            if i == 2 && ty == 0x90 {
                dir = Some((p + 4, p + len));
            }
            o = p + len;
        } else {
            o = p + l as usize;
        }
    }
    let Some((start, end)) = dir else { return chunks };
    for (seq, b) in parse_blocks(d, start, end, 0).iter().enumerate() {
        if b.ty == 0x88 {
            if let BVal::List(sub) = &b.val {
                if let (Some(t), Some(off)) = (int(sub, 2), int(sub, 4)) {
                    chunks.insert(seq as u32, (t, off as usize, int(sub, 5)));
                }
            }
        }
    }
    chunks
}

fn fmt_blocks(bs: &[Block], indent: usize, out: &mut String) {
    use std::fmt::Write;
    for b in bs {
        let pad = " ".repeat(indent);
        match &b.val {
            BVal::None => { let _ = writeln!(out, "{pad}{:02x}/{:02x}", b.id, b.ty); }
            BVal::Int(v) => { let _ = writeln!(out, "{pad}{:02x}/{:02x} = {v} (0x{v:x})", b.id, b.ty); }
            BVal::Bytes(x) => { let _ = writeln!(out, "{pad}{:02x}/{:02x} = {:02x?}", b.id, b.ty, x); }
            BVal::Str(s) => { let _ = writeln!(out, "{pad}{:02x}/{:02x} = {s:?}", b.id, b.ty); }
            BVal::List(l) => {
                let _ = writeln!(out, "{pad}{:02x}/{:02x} [", b.id, b.ty);
                if l.len() > 400 {
                    let _ = writeln!(out, "{pad}  ... {} blocks", l.len());
                } else {
                    fmt_blocks(l, indent + 2, out);
                }
                let _ = writeln!(out, "{pad}]");
            }
        }
    }
}

fn fmt_eshape(s: &EShape, indent: usize, out: &mut String) {
    use std::fmt::Write;
    let pad = " ".repeat(indent);
    let _ = writeln!(out, "{pad}sp id={} type={} flags=0x{:x} seq={:?} text={:?} anchor={:?} child={:?} grp={:?} cell={:?}", s.spid, s.shape_type, s.flags, s.seq, s.text_id, s.anchor, s.child_anchor, s.group_rect, s.cell_ref);
    let mut keys: Vec<_> = s.props.iter().collect();
    keys.sort();
    let props: Vec<String> = keys.iter().map(|(k, v)| format!("{k:x}={v:x}")).collect();
    let _ = writeln!(out, "{pad}   props {}", props.join(" "));
    if s.cell_ref.is_some() || s.anchor.is_none() {
        let _ = writeln!(out, "{pad}   anchorblocks {}", s.anchor_dbg);
    }
    let rc: Vec<String> = s.recs.iter().map(|(t, i, o, l)| format!("{t:x}/{i:x}@{o:x}+{l}")).collect();
    let _ = writeln!(out, "{pad}   recs {}", rc.join(" "));
    let cx: Vec<String> = s.complex.iter().map(|(k, v)| format!("{k:x}:{}b", v.len())).collect();
    if !cx.is_empty() {
        let _ = writeln!(out, "{pad}   complex {}", cx.join(" "));
    }
    for c in &s.children {
        fmt_eshape(c, indent + 2, out);
    }
}

pub fn dump_raw(path: &std::path::Path) -> Result<String, String> {
    use std::fmt::Write;
    let s = read_streams(path)?;
    let mut out = String::new();
    let _ = writeln!(out, "== Contents ({} bytes)", s.contents.len());
    for (seq, (t, off, parent)) in contents_chunks(&s.contents) {
        let _ = writeln!(out, "chunk seq={seq} (0x{seq:x}) type=0x{t:x} off=0x{off:x} parent={parent:?}");
        fmt_blocks(&chunk_blocks(&s.contents, off), 2, &mut out);
    }
    let _ = writeln!(out, "== Escher ({} bytes, delay {} bytes)", s.escher.len(), s.delay.len());
    let e = parse_escher(&s.escher, &s.delay);
    let _ = writeln!(out, "blips: {}", e.blips.len());
    for (i, d) in e.drawings.iter().enumerate() {
        let _ = writeln!(out, "drawing {i}");
        for sh in d {
            fmt_eshape(sh, 2, &mut out);
        }
    }
    let _ = writeln!(out, "== Quill ({} bytes)", s.quill.len());
    for r in quill_refs(&s.quill) {
        let _ = writeln!(out, "ref {:?} id={} off=0x{:x} len={}", r.name, r.id, r.offset, r.len);
    }
    Ok(out)
}

pub fn dump_hex(path: &std::path::Path, stream: &str, off: usize, len: usize) -> Result<String, String> {
    use std::fmt::Write;
    let s = read_streams(path)?;
    let d = match stream {
        "quill" => &s.quill,
        "contents" => &s.contents,
        "escher" => &s.escher,
        _ => &s.delay,
    };
    let mut out = String::new();
    let end = (off + len).min(d.len());
    let mut o = off;
    while o < end {
        let row = &d[o..(o + 16).min(end)];
        let hex: Vec<String> = row.iter().map(|b| format!("{b:02x}")).collect();
        let asc: String = row.iter().map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }).collect();
        let _ = writeln!(out, "{o:06x}  {:<48} {asc}", hex.join(" "));
        o += 16;
    }
    Ok(out)
}

include!("builder.rs");
