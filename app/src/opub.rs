//! OpenPub's own document format (`.opub`): a zip file with `document.json` (the document
//! model) and the pictures as `images/<n>.<ext>`.

use std::io::{Read, Write};
use std::path::Path;

use openpub_core::export::image_ext;
use openpub_core::model::Document;

pub fn write(doc: &Document, path: &Path) -> Result<(), String> {
    // write next to the target first so a failure can't destroy an existing file
    let tmp = path.with_extension("opub.tmp");
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let deflate = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("document.json", deflate).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string(doc).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        // which OpenPub wrote it (files without this are from 0.3.14 or older: see `read`)
        zip.start_file(VERSION_FILE, deflate).map_err(|e| e.to_string())?;
        zip.write_all(format!("OpenPub {}\n", env!("CARGO_PKG_VERSION")).as_bytes()).map_err(|e| e.to_string())?;
        for (i, img) in doc.images.iter().enumerate() {
            // pictures are already compressed
            zip.start_file(format!("images/{i}.{}", image_ext(&img.mime)), stored).map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }
        // on the disk before it takes the place of the old file (a power cut mustn't leave an empty one)
        zip.finish().map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    let result = result.and_then(|()| std::fs::rename(&tmp, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

const VERSION_FILE: &str = "openpub-version.txt";

/// Limits on what a .opub file may unpack to (a small file can be made to expand enormously).
const MAX_JSON: u64 = 512 * 1024 * 1024;
const MAX_IMAGE: u64 = 256 * 1024 * 1024;
const MAX_IMAGES: usize = 20_000;
/// The picture types OpenPub stores; anything else in a file is treated as plain data.
const IMAGE_TYPES: [&str; 7] = ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff", "image/x-emf", "image/x-wmf"];

/// A .opub file is data someone else may have made: colours must be plain "#rrggbb" values (the
/// page uses them in styles, where anything else could be made to fetch from the network).
fn clean_colours(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                let clean = |s: &mut String| {
                    let ok = s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit());
                    if !ok {
                        *s = "#000000".into();
                    }
                };
                if matches!(key.as_str(), "color" | "color2" | "background" | "back") {
                    if let serde_json::Value::String(s) = val {
                        clean(s);
                    }
                }
                // a gradient's colours: [["#rrggbb", position], ...]
                if key == "stops" {
                    if let serde_json::Value::Array(stops) = val {
                        for stop in stops.iter_mut() {
                            if let Some(serde_json::Value::String(s)) = stop.get_mut(0) {
                                clean(s);
                            }
                        }
                    }
                }
                clean_colours(val);
            }
        }
        serde_json::Value::Array(list) => list.iter_mut().for_each(clean_colours),
        _ => {}
    }
}

pub fn read(path: &Path) -> Result<Document, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "This isn't an OpenPub document.".to_string())?;
    let mut json = String::new();
    zip.by_name("document.json").map_err(|_| "This isn't an OpenPub document.".to_string())?.take(MAX_JSON + 1).read_to_string(&mut json).map_err(|e| e.to_string())?;
    if json.len() as u64 > MAX_JSON {
        return Err("The document is too large to open.".into());
    }
    let mut value: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("The document is damaged: {e}"))?;
    drop(json);
    clean_colours(&mut value);
    let mut doc: Document = serde_json::from_value(value).map_err(|e| format!("The document is damaged: {e}"))?;
    if zip.by_name(VERSION_FILE).is_err() {
        // OpenPub 0.3.14 and older drew WordArt shapes 168 and 169 slanting (and its WordArt
        // style list saved its "Slant up/down" as them); they are Office's "fade right/left",
        // its slants being 172 and 173. Older files keep the look they were made with.
        fn slants(shapes: &mut [openpub_core::model::Shape]) {
            for s in shapes {
                if s.wordart.is_some() && (s.shape_type == 168 || s.shape_type == 169) {
                    s.shape_type += 4;
                }
                slants(&mut s.children);
            }
        }
        for p in &mut doc.pages {
            slants(&mut p.shapes);
        }
    }
    if doc.pages.is_empty() {
        return Err("The document is damaged: it has no pages.".into());
    }
    if doc.images.len() > MAX_IMAGES {
        return Err("The document is damaged: it lists too many pictures.".into());
    }
    if !(doc.width.is_finite() && doc.height.is_finite() && doc.width >= 1.0 && doc.height >= 1.0 && doc.width <= 20000.0 && doc.height <= 20000.0) {
        return Err("The document is damaged: its page size isn't valid.".into());
    }
    for i in 0..doc.images.len() {
        if !IMAGE_TYPES.contains(&doc.images[i].mime.as_str()) {
            doc.images[i].mime = "application/octet-stream".into();
        }
        let name = format!("images/{i}.{}", image_ext(&doc.images[i].mime));
        let mut bytes = Vec::new();
        if let Ok(f) = zip.by_name(&name) {
            f.take(MAX_IMAGE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_IMAGE {
                return Err("The document is damaged: a picture in it is too large.".into());
            }
        }
        doc.images[i].bytes = bytes;
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openpub_core::model::{Page, Shape, WordArt};

    fn doc_with_wordart(shape_type: u16) -> Document {
        let wa = Shape { shape_type, wordart: Some(WordArt { text: "Hi".into(), ..Default::default() }), ..Default::default() };
        Document { width: 595.0, height: 842.0, pages: vec![Page { shapes: vec![wa], ..Default::default() }], ..Default::default() }
    }

    #[test]
    fn old_slants_keep_their_look() {
        let dir = std::env::temp_dir().join(format!("opub-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // a file from 0.3.14 or older: no version file, "slant up" saved as 168
        let old = dir.join("old.opub");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&old).unwrap());
            zip.start_file("document.json", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(serde_json::to_string(&doc_with_wordart(168)).unwrap().as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(read(&old).unwrap().pages[0].shapes[0].shape_type, 172);
        // written now: 168 is "fade right" and stays so
        let new = dir.join("new.opub");
        write(&doc_with_wordart(168), &new).unwrap();
        assert_eq!(read(&new).unwrap().pages[0].shapes[0].shape_type, 168);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
