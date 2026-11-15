//! Turns Windows metafile pictures (EMF and WMF, as Publisher stores clip art and logos) into
//! PNG pictures by letting Windows itself draw them. Each picture is drawn twice, on white and
//! on black, so the parts the drawing doesn't cover come out transparent.

/// Draws an EMF (`is_wmf` false) or WMF into a PNG of about `w` × `h` pixels.
pub fn to_png(data: &[u8], is_wmf: bool, w: u32, h: u32) -> Option<Vec<u8>> {
    let (w, h) = (w.clamp(8, 3000), h.clamp(8, 3000));
    let on_white = draw(data, is_wmf, w, h, 0xff)?;
    let on_black = draw(data, is_wmf, w, h, 0x00)?;
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    let mut drawn = 0usize;
    for i in 0..(w * h) as usize {
        let (wb, bb) = (&on_white[i * 4..i * 4 + 3], &on_black[i * 4..i * 4 + 3]);
        // what changes with the background shows through: that's transparency
        let diff = (0..3).map(|k| wb[k].saturating_sub(bb[k])).max().unwrap_or(0);
        let a = 255 - diff;
        if a > 0 {
            drawn += 1;
            for k in 0..3 {
                // the black-background pixels are colour × alpha; undo that (BGR → RGB)
                rgba[i * 4 + k] = ((bb[2 - k] as u32 * 255) / a as u32).min(255) as u8;
            }
        }
        rgba[i * 4 + 3] = a;
    }
    if drawn == 0 {
        return None; // nothing Windows could draw (for example a drawing kept only as EMF+)
    }
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(&rgba, w, h, image::ExtendedColorType::Rgba8).ok()?;
    Some(png)
}

/// One drawing pass: BGRA pixels of the picture drawn on a plain background.
#[cfg(windows)]
fn draw(data: &[u8], is_wmf: bool, w: u32, h: u32, background: u8) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::DataExchange::{METAFILEPICT, SetWinMetaFileBits};
    unsafe {
        let emf = if is_wmf {
            // a "placeable" WMF starts with a 22-byte header Windows doesn't expect
            let body = if data.len() > 22 && data[..4] == [0xd7, 0xcd, 0xc6, 0x9a] { &data[22..] } else { data };
            let pict = METAFILEPICT { mm: 8 /* MM_ANISOTROPIC */, xExt: (w * 100 * 254 / 1500) as i32, yExt: (h * 100 * 254 / 1500) as i32, hMF: std::ptr::null_mut() };
            SetWinMetaFileBits(body.len() as u32, body.as_ptr(), std::ptr::null_mut(), &pict)
        } else {
            SetEnhMetaFileBits(data.len() as u32, data.as_ptr())
        };
        if emf.is_null() {
            return None;
        }
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w as i32;
        info.bmiHeader.biHeight = -(h as i32); // top-down rows
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = 0; // BI_RGB
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        let mut out = None;
        if !bmp.is_null() && !bits.is_null() {
            let old = SelectObject(dc, bmp);
            let len = (w * h * 4) as usize;
            std::ptr::write_bytes(bits as *mut u8, background, len);
            SetStretchBltMode(dc, HALFTONE);
            let rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            if PlayEnhMetaFile(dc, emf, &rect) != 0 {
                GdiFlush();
                out = Some(std::slice::from_raw_parts(bits as *const u8, len).to_vec());
            }
            SelectObject(dc, old);
            DeleteObject(bmp);
        }
        DeleteDC(dc);
        DeleteEnhMetaFile(emf);
        out
    }
}

#[cfg(not(windows))]
fn draw(_data: &[u8], _is_wmf: bool, _w: u32, _h: u32, _background: u8) -> Option<Vec<u8>> {
    None
}
