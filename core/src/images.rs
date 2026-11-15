//! Pictures added to a document: checks the format and reports the size.

use crate::model::Image;

/// Turns the bytes of a picture file into an [`Image`] a browser can show (PNG, JPEG or GIF;
/// other formats are converted to PNG), with its size in pixels.
pub fn prepare(bytes: Vec<u8>) -> Result<(Image, u32, u32), String> {
    let format = image::guess_format(&bytes).map_err(|_| "This file isn't a picture format OpenPub can read.".to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("The picture couldn't be read: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let (mime, bytes) = match format {
        image::ImageFormat::Png => ("image/png", bytes),
        image::ImageFormat::Jpeg => ("image/jpeg", bytes),
        image::ImageFormat::Gif => ("image/gif", bytes),
        _ => {
            let mut png = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
            ("image/png", png)
        }
    };
    // a picture added in OpenPub is shown upright, the way the browser turns it
    let (w, h) = if jpeg_orientation(&bytes) >= 5 { (h, w) } else { (w, h) };
    Ok((Image { mime: mime.into(), bytes, orientation: 1 }, w, h))
}

/// The EXIF orientation tag of a JPEG (1 when there is none).
pub fn jpeg_orientation(b: &[u8]) -> u8 {
    if b.len() < 4 || b[0] != 0xff || b[1] != 0xd8 {
        return 1;
    }
    let mut o = 2;
    while o + 4 <= b.len() && b[o] == 0xff {
        let marker = b[o + 1];
        let len = u16::from_be_bytes([b[o + 2], b[o + 3]]) as usize;
        if marker == 0xda || len < 2 {
            break; // image data starts: no more metadata
        }
        let seg = &b[o + 4..(o + 2 + len).min(b.len())];
        if marker == 0xe1 && seg.len() > 14 && &seg[..6] == b"Exif\0\0" {
            let t = &seg[6..];
            let le = &t[..2] == b"II";
            let u16_at = |i: usize| t.get(i..i + 2).map(|x| if le { u16::from_le_bytes([x[0], x[1]]) } else { u16::from_be_bytes([x[0], x[1]]) });
            let u32_at = |i: usize| t.get(i..i + 4).map(|x| if le { u32::from_le_bytes([x[0], x[1], x[2], x[3]]) } else { u32::from_be_bytes([x[0], x[1], x[2], x[3]]) });
            let Some(ifd) = u32_at(4).map(|v| v as usize) else { return 1 };
            let n = u16_at(ifd).unwrap_or(0) as usize;
            for i in 0..n.min(200) {
                let e = ifd + 2 + i * 12;
                if u16_at(e) == Some(0x0112) {
                    let v = u16_at(e + 8).unwrap_or(1);
                    return if (1..=8).contains(&v) { v as u8 } else { 1 };
                }
            }
            return 1;
        }
        o += 2 + len;
    }
    1
}

/// Decodes a picture into RGBA pixels with its width and height.
pub fn rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = (img.width(), img.height());
    Some((img.into_raw(), w, h))
}
