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

/// A smaller copy of a picture, at most `max` pixels on its longer side, for a PDF: a photo
/// shown a few centimetres wide doesn't need its camera's 4000 pixels, and a photo saved as PNG
/// is much smaller as JPEG. The copy is turned the way its EXIF orientation says (as a browser
/// shows it; the copy has no EXIF), and stored as JPEG for photos, PNG for drawings and pictures
/// with see-through parts. None when the picture will do as it is, can't be decoded, or the copy
/// wouldn't be clearly smaller.
pub fn fit(bytes: &[u8], max: u32) -> Option<(&'static str, Vec<u8>)> {
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
    if format == image::ImageFormat::Jpeg {
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
    }
}

/// Decodes a picture into RGBA pixels with its width and height.
pub fn rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = (img.width(), img.height());
    Some((img.into_raw(), w, h))
}
