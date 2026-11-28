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

/// A smaller copy of a picture, at most `max` pixels on its longer side, for a PDF or a Word
/// document: a photo shown a few centimetres wide doesn't need its camera's 4000 pixels, and a
/// photo saved as PNG is much smaller as JPEG. Stored as JPEG for photos, PNG for drawings and
/// pictures with see-through parts; the copy has no EXIF: with `turn` its pixels are turned the
/// way the EXIF orientation says (as a browser shows it), without, they stay as stored (as
/// Publisher shows them). None when the picture will do as it is, can't be decoded, or the copy
/// wouldn't be smaller.
pub fn fit(bytes: &[u8], max: u32) -> Option<(&'static str, Vec<u8>)> {
    fit_turned(bytes, max, true)
}

/// [`fit`], choosing whether the EXIF orientation is applied to the pixels.
pub fn fit_turned(bytes: &[u8], max: u32, turn: bool) -> Option<(&'static str, Vec<u8>)> {
    if max < 16 {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let mut img = image::load_from_memory(bytes).ok()?;
    let shrink = img.width().max(img.height()) > max;
    // (a JPEG already the right size: as it is)
    if !shrink && format == image::ImageFormat::Jpeg {
        return None;
    }
    if turn && format == image::ImageFormat::Jpeg {
        img = match jpeg_orientation(bytes) {
            2 => img.fliph(),
            3 => img.rotate180(),
            4 => img.flipv(),
            5 => img.rotate90().fliph(),
            6 => img.rotate90(),
            7 => img.rotate270().fliph(),
            8 => img.rotate270(),
            _ => img,
        };
    }
    let small = if shrink { img.resize(max, max, image::imageops::FilterType::CatmullRom) } else { img };
    let see_through = small.color().has_alpha() && small.to_rgba8().pixels().any(|p| p[3] < 255);
    // a photo: from a JPEG, or with many colours (a drawing or a screenshot has few, and stays
    // sharp as PNG)
    let photo = !see_through && (format == image::ImageFormat::Jpeg || {
        let rgb = small.to_rgb8();
        let mut seen = std::collections::HashSet::new();
        let step = ((rgb.width() as usize * rgb.height() as usize) / 20000).max(1);
        for p in rgb.pixels().step_by(step) {
            seen.insert([p[0], p[1], p[2]]);
            if seen.len() > 4000 {
                break;
            }
        }
        seen.len() > 4000
    });
    // the right size already and not a photo: as it is
    if !shrink && !photo {
        return None;
    }
    let mut out = Vec::new();
    let mime = if photo {
        let rgb = small.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&rgb).ok()?;
        "image/jpeg"
    } else {
        small.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
        "image/png"
    };
    // (a PDF keeps a JPEG as it is, but stores a PNG's pixels compressed afresh - usually
    // larger than the PNG file: any saving on the file is a bigger one in the PDF)
    (out.len() < bytes.len()).then_some((mime, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(img: &image::DynamicImage, f: image::ImageFormat) -> Vec<u8> {
        let mut b = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut b), f).unwrap();
        b
    }

    #[test]
    fn pictures_for_a_pdf() {
        // a "photo": noisy colours, 800 x 400, as PNG
        let mut seed = 7u32;
        let photo = image::RgbImage::from_fn(800, 400, |x, y| {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            image::Rgb([(x % 256) as u8, (y % 256) as u8, (seed >> 24) as u8])
        });
        let png = encode(&image::DynamicImage::ImageRgb8(photo), image::ImageFormat::Png);
        // shrunk to 200 pixels across, as JPEG
        let (mime, small) = fit(&png, 200).unwrap();
        assert_eq!(mime, "image/jpeg");
        let back = image::load_from_memory(&small).unwrap();
        assert_eq!((back.width(), back.height()), (200, 100));
        // the right size already: a photo PNG still becomes JPEG
        assert_eq!(fit(&png, 2000).unwrap().0, "image/jpeg");
        // a drawing (two colours) the right size: left as it is; shrunk: stays PNG
        let drawing = image::RgbImage::from_fn(800, 400, |x, _| if x < 400 { image::Rgb([255, 255, 255]) } else { image::Rgb([0, 0, 200]) });
        let dpng = encode(&image::DynamicImage::ImageRgb8(drawing), image::ImageFormat::Png);
        assert!(fit(&dpng, 2000).is_none());
        if let Some((m, _)) = fit(&dpng, 100) {
            assert_eq!(m, "image/png");
        }
        // see-through parts stay PNG
        let clear = image::RgbaImage::from_fn(800, 400, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, 9, if x < 50 { 0 } else { 255 }]));
        let cpng = encode(&image::DynamicImage::ImageRgba8(clear), image::ImageFormat::Png);
        if let Some((m, _)) = fit(&cpng, 100) {
            assert_eq!(m, "image/png");
        }
        // not a picture
        assert!(fit(b"not a picture at all", 100).is_none());
    }

    #[test]
    fn pixels_each_picture_needs() {
        use crate::model::{Document, Image, Page, Shape};
        let pic = |i: usize, w: f64, h: f64, crop: Option<[f64; 4]>| Shape { kind: "picture".into(), image: Some(i), w, h, crop, ..Default::default() };
        let doc = Document {
            width: 595.0,
            height: 842.0,
            images: vec![Image::default(), Image::default(), Image::default()],
            pages: vec![Page {
                shapes: vec![
                    // 1 inch wide, half of it cropped away: the whole picture is 2 inches
                    pic(0, 72.0, 36.0, Some([0.25, 0.0, 0.25, 0.0])),
                    // shown twice: the larger counts
                    pic(1, 36.0, 36.0, None),
                    pic(1, 144.0, 72.0, None),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        // (picture 2 isn't shown: 0)
        assert_eq!(picture_pixels(&doc, 220.0), vec![440, 440, 0]);
    }

    #[test]
    fn turned_photos_stay_turned() {
        // a 400 x 200 JPEG whose EXIF says "turn a quarter right" (6): a browser shows it 200 x 400
        let mut seed = 3u32;
        let photo = image::RgbImage::from_fn(400, 200, |x, y| {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            image::Rgb([(x % 256) as u8, (y % 256) as u8, (seed >> 24) as u8])
        });
        let jpg = encode(&image::DynamicImage::ImageRgb8(photo), image::ImageFormat::Jpeg);
        let mut exif: Vec<u8> = b"Exif\0\0II*\0\x08\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
        let mut with = vec![0xff, 0xd8, 0xff, 0xe1];
        with.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        with.extend_from_slice(&exif);
        with.extend_from_slice(&jpg[2..]);
        assert_eq!(jpeg_orientation(&with), 6);
        // the copy is turned already (and has no EXIF): taller than wide
        let (_, small) = fit(&with, 100).unwrap();
        let back = image::load_from_memory(&small).unwrap();
        assert_eq!((back.width(), back.height()), (50, 100));
        assert_eq!(jpeg_orientation(&small), 1);
        // for Word: the pixels as stored (Publisher doesn't turn photos), still without EXIF
        let (_, stored) = fit_turned(&with, 100, false).unwrap();
        let back = image::load_from_memory(&stored).unwrap();
        assert_eq!((back.width(), back.height()), (100, 50));
        assert_eq!(jpeg_orientation(&stored), 1);
    }
}

/// For each picture of a document, the most pixels it needs on its longer side at `dpi`, for the
/// largest size it is shown at (a cropped picture: the size of the whole picture); 0 for a
/// picture not shown as such (picture borders' tiles).
pub fn picture_pixels(doc: &crate::model::Document, dpi: f64) -> Vec<u32> {
    use crate::model::{Para, Shape};
    let mut need = vec![0u32; doc.images.len()];
    fn add(need: &mut [u32], i: Option<usize>, w: f64, h: f64, dpi: f64) {
        if let Some(i) = i {
            if i < need.len() && w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite() {
                let px = (w.max(h) / 72.0 * dpi).ceil().min(20000.0) as u32;
                need[i] = need[i].max(px);
            }
        }
    }
    fn in_text(need: &mut [u32], paras: &[Para], dpi: f64) {
        for p in paras {
            for r in &p.runs {
                if let Some(o) = &r.object {
                    walk(need, std::slice::from_ref(o.as_ref()), dpi);
                }
            }
        }
    }
    fn walk(need: &mut [u32], shapes: &[Shape], dpi: f64) {
        for s in shapes {
            if s.image.is_some() {
                let c = s.crop.unwrap_or([0.0; 4]);
                add(need, s.image, s.w / (1.0 - c[0] - c[2]).max(0.01), s.h / (1.0 - c[1] - c[3]).max(0.01), dpi);
            }
            if let Some(f) = &s.fill {
                add(need, f.image, s.w, s.h, dpi);
            }
            walk(need, &s.children, dpi);
            if let Some(t) = &s.text {
                in_text(need, &t.paras, dpi);
            }
            if let Some(t) = &s.table {
                for c in &t.cells {
                    if let Some(f) = &c.fill {
                        add(need, f.image, s.w, s.h, dpi);
                    }
                    in_text(need, &c.paras, dpi);
                }
            }
        }
    }
    for p in &doc.pages {
        walk(&mut need, &p.shapes, dpi);
        if let Some(f) = &p.background_fill {
            add(&mut need, f.image, doc.width, doc.height, dpi);
        }
    }
    need
}

/// Decodes a picture into RGBA pixels with its width and height.
pub fn rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = (img.width(), img.height());
    Some((img.into_raw(), w, h))
}
