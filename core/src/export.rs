//! Writes a document as a folder with a self-contained web page (used for testing and sharing).

use crate::model::Document;
use std::path::Path;

/// The page renderer, with the shape geometry library it uses in front of it.
pub const RENDER_JS: &str = concat!(include_str!("../../web/shapes.js"), "\n", include_str!("../../web/render.js"));
pub const HYPHEN_JS: &str = include_str!("../../web/hyphen.js");

pub fn image_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

/// `dir/index.html` shows all pages; `index.html?page=3&scale=1.5` shows one page with nothing
/// around it (for screenshots).
pub fn export_html(doc: &Document, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for (i, img) in doc.images.iter().enumerate() {
        let name = format!("img-{i}.{}", image_ext(&img.mime));
        std::fs::write(dir.join(&name), &img.bytes).map_err(|e| e.to_string())?;
        names.push(name);
    }
    let json = serde_json::to_string(doc).map_err(|e| e.to_string())?.replace("</", "<\\/");
    let names_json = serde_json::to_string(&names).unwrap();
    let html = format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>OpenPub export</title>
<style>html,body{{margin:0;padding:0;background:#fff}} body.all{{background:#888}} body.all .op-page-wrap{{margin:12px auto;box-shadow:0 1px 6px rgba(0,0,0,.5)}}</style>
</head><body>
<script>{HYPHEN_JS}</script>
<script>{RENDER_JS}</script>
<script>
window.onerror = (m, s, l, c, e) => {{ document.title = "ERR " + m + " @" + l + ":" + c + " " + (e && e.stack); }};
const DOC = {json};
const IMAGES = {names_json};
const q = new URLSearchParams(location.search);
const scale = parseFloat(q.get('scale') || '1');
const opts = {{ scale, imageUrl: (i) => IMAGES[i] }};
const only = q.get('page');
if (!only) document.body.className = 'all';
const list = only ? [parseInt(only, 10) - 1] : DOC.pages.map((_, i) => i);
for (const i of list) {{
  const w = OpenPub.renderPage(DOC, i, opts);
  document.body.appendChild(w);
  w.opFinish();
}}
</script>
</body></html>
"#
    );
    std::fs::write(dir.join("index.html"), html).map_err(|e| e.to_string())
}
