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
        for (i, img) in doc.images.iter().enumerate() {
            // pictures are already compressed
            zip.start_file(format!("images/{i}.{}", image_ext(&img.mime)), stored).map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => std::fs::rename(&tmp, path).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn read(path: &Path) -> Result<Document, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open the file: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "This isn't an OpenPub document.".to_string())?;
    let mut json = String::new();
    zip.by_name("document.json").map_err(|_| "This isn't an OpenPub document.".to_string())?.read_to_string(&mut json).map_err(|e| e.to_string())?;
    let mut doc: Document = serde_json::from_str(&json).map_err(|e| format!("The document is damaged: {e}"))?;
    for i in 0..doc.images.len() {
        let name = format!("images/{i}.{}", image_ext(&doc.images[i].mime));
        let mut bytes = Vec::new();
        if let Ok(mut f) = zip.by_name(&name) {
            f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        }
        doc.images[i].bytes = bytes;
    }
    Ok(doc)
}
