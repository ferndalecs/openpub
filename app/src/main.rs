//! OpenPub: a viewer and editor for Microsoft Publisher files.
//!
//! The window is a WebView2 page (see `web/`); this program serves that page, the opened
//! document (as JSON) and its pictures through the `openpub://` scheme, and does the file work
//! (open, save, export) the page asks for.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assoc;
mod opub;
mod pdf;
mod recent;
mod recovery;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use openpub_core::model::{Document, Image};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Icon, WindowBuilder};
use wry::http::{Request, Response, header::CACHE_CONTROL, header::CONTENT_TYPE};
use wry::{DragDropEvent, WebViewBuilder, WebViewBuilderExtWindows};

const APP_HTML: &str = include_str!("../../web/app.html");
const APP_CSS: &str = include_str!("../../web/app.css");
const APP_JS: &str = include_str!("../../web/app.js");
const ICON_PNG: &[u8] = include_bytes!("../assets/openpub.png");

#[derive(Default)]
struct State {
    /// The open document as JSON (with its file name added).
    json: Option<String>,
    images: Vec<Image>,
    /// The file the document came from.
    path: Option<PathBuf>,
    /// Unsaved changes (reported by the page).
    dirty: bool,
    /// A test script is driving the program (no questions, nothing remembered).
    testing: bool,
    /// While testing: the answer to "lose the unsaved changes?" (instead of asking).
    test_answer: bool,
    /// The publication's name as shown ("Worksheet_8.pub", "Publication1").
    name: String,
    /// The recovery copy kept while there are unsaved changes (see recovery.rs).
    recovery: Option<recovery::Active>,
    /// Counts the times the copy was let go: a copy still being written for an older one is thrown away.
    recovery_gen: u64,
    autosave_busy: bool,
    /// While testing: recovery copies are written only when a test asks for them.
    autosave_test: bool,
    /// Recovery copies written (for tests).
    autosaves: u32,
}

/// Lets the current recovery copy go (the publication was saved, or closed on purpose).
fn drop_recovery(state: &Mutex<State>) {
    let mut st = state.lock().unwrap();
    st.recovery_gen += 1;
    if let Some(a) = st.recovery.take() {
        recovery::discard(a);
    }
}

/// Opens a recovery copy as the current publication, marked unsaved; this window keeps the copy
/// from now on. Returns the name shown.
fn recover(state: &Mutex<State>, file: &Path) -> Result<String, String> {
    let (doc, meta) = recovery::read(file)?;
    let name = if meta.name.is_empty() { "Recovered publication".to_string() } else { meta.name.clone() };
    let (json, images) = page_json(doc, &name, meta.original.as_deref(), true)?;
    drop_recovery(state);
    let mut st = state.lock().unwrap();
    st.json = Some(json);
    st.images = images;
    st.path = meta.original.clone();
    st.name = name.clone();
    st.dirty = true;
    st.recovery = recovery::adopt(file);
    Ok(name)
}

/// What to do once a save has finished.
#[derive(Clone, Copy, PartialEq)]
enum Then {
    Nothing,
    Close,
}

enum UserEvent {
    /// Ask for a file and open it.
    Choose,
    /// Open a file; `asked`: the person has already agreed to lose unsaved changes.
    Open { path: PathBuf, asked: bool },
    /// Start a blank publication with this page size (points), perhaps from one of the designs.
    New { width: f64, height: f64, template: Option<String> },
    Loaded { path: PathBuf, result: Result<(String, Vec<Image>), String> },
    Save { doc: String, ask: bool, then: Then, forced: Option<PathBuf> },
    ExportDocx { doc: String, forced: Option<PathBuf> },
    ExportPdf { width: f64, height: f64, forced: Option<PathBuf> },
    Quit,
    PdfDone(Result<PathBuf, String>),
    AddPicture,
    /// A picture the person chose has been read (or couldn't be).
    PictureReady(Result<(Image, u32, u32), String>),
    /// The page sent the publication for a recovery copy.
    Autosave { doc: String },
    /// A recovery copy has been written to a temporary file (or couldn't be).
    Autosaved { generation: u64, file: PathBuf, result: Result<PathBuf, String> },
    /// The page has loaded: offer any work left over from a window that closed unexpectedly.
    Ready,
    Associate,
    /// Open a web or e-mail address in the person's browser, after asking.
    OpenLink(String),
    /// Save a picture of a page (PNG data from the page) where the person chooses.
    SavePng { data: Vec<u8>, name: String, forced: Option<PathBuf> },
    /// Files are being dragged over the window: 0 none, 1 to open, 2 pictures to add.
    Drag(u8),
    /// Picture files to add (dropped on the window), at a point of the window (physical pixels).
    AddPictures { paths: Vec<PathBuf>, at: Option<(f64, f64)> },
    /// A picture pasted in the page (the bytes of the file).
    PastePicture(Vec<u8>),
    /// Pictures read for adding (and the ones that couldn't be).
    PicturesReady { items: Vec<(Image, u32, u32)>, errors: Vec<String>, at: Option<(f64, f64)> },
    /// Pictures the page made itself (the tiles of a picture border): stored, then their numbers
    /// handed back with `token`.
    AddImages { token: String, list: Vec<Vec<u8>> },
}

/// Picture files OpenPub can add.
fn is_picture(p: &Path) -> bool {
    let e = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    matches!(e.as_str(), "png" | "jpg" | "jpeg" | "jfif" | "gif" | "bmp" | "tif" | "tiff")
}
/// Files dropped on the window: pictures to add when they are all pictures, else a file to open.
fn dropped(paths: &[PathBuf]) -> u8 {
    if !paths.is_empty() && paths.iter().all(|p| is_picture(p)) { 2 } else { 1 }
}

/// Reads picture bytes for adding (pasted pictures), guarded like files.
fn prepare_picture(bytes: Vec<u8>, what: &str) -> Result<(Image, u32, u32), String> {
    let (img, w, h) = std::panic::catch_unwind(|| openpub_core::images::prepare(bytes)).unwrap_or_else(|_| Err(format!("{what} is damaged or isn't a picture OpenPub can read.")))?;
    if w == 0 || h == 0 || w > 30000 || h > 30000 {
        return Err(format!("{what} is too large to add ({w} × {h} pixels)."));
    }
    Ok((img, w, h))
}

/// What the page may load: only its own files and the open document's pictures. Nothing from the
/// network, no scripts but the program's own, no frames, plug-ins or form posts - so even a
/// document crafted to smuggle something into the page has nowhere to send or fetch anything.
const CONTENT_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

fn respond(mime: &str, body: Cow<'static, [u8]>, cache: bool) -> Response<Cow<'static, [u8]>> {
    // (a type that can't go in a header - from a damaged file - is sent as plain data)
    let mime = if mime.bytes().all(|b| b.is_ascii_graphic() || b == b' ') && !mime.is_empty() { mime } else { "application/octet-stream" };
    Response::builder()
        .header(CONTENT_TYPE, mime)
        .header(CACHE_CONTROL, if cache { "max-age=31536000, immutable" } else { "no-store" })
        .header("Content-Security-Policy", CONTENT_POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
}

/// The page is only ever the program's own (served as openpub://localhost, which WebView2 shows
/// as http://openpub.localhost).
fn own_page(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    ["openpub://localhost/", "http://openpub.localhost/", "https://openpub.localhost/"].iter().any(|p| u.starts_with(p)) || u == "about:blank"
}

fn serve(state: &Mutex<State>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/');
    let js = "text/javascript; charset=utf-8";
    match path {
        "" | "index.html" | "app.html" => respond("text/html; charset=utf-8", APP_HTML.as_bytes().into(), false),
        "app.css" => respond("text/css; charset=utf-8", APP_CSS.as_bytes().into(), false),
        "app.js" => respond(js, APP_JS.as_bytes().into(), false),
        "render.js" => respond(js, openpub_core::export::RENDER_JS.as_bytes().into(), false),
        "hyphen.js" => respond(js, openpub_core::export::HYPHEN_JS.as_bytes().into(), false),
        // what the start screen should offer
        "start.json" => {
            let ask = !state.lock().unwrap().testing && !recent::assoc_asked() && !assoc::pub_is_ours();
            respond("application/json; charset=utf-8", format!("{{\"askAssoc\":{ask}}}").into_bytes().into(), false)
        }
        "recent.json" => respond("application/json; charset=utf-8", recent::json().into_bytes().into(), false),
        // the fonts installed on this computer, for the font list
        "fonts.json" => respond("application/json; charset=utf-8", serde_json::to_string(openpub_core::fonts::families()).unwrap_or_else(|_| "[]".into()).into_bytes().into(), false),
        "state.json" if cfg!(debug_assertions) => {
            let st = state.lock().unwrap();
            let rec = st.recovery.as_ref().map(|a| a.file.to_string_lossy().to_string());
            let body = serde_json::json!({ "dirty": st.dirty, "recovery": rec, "autosaves": st.autosaves, "path": st.path });
            respond("application/json; charset=utf-8", body.to_string().into_bytes().into(), false)
        }
        "doc.json" => {
            let st = state.lock().unwrap();
            let body = st.json.clone().unwrap_or_else(|| "{}".into());
            respond("application/json; charset=utf-8", body.into_bytes().into(), false)
        }
        p if p.starts_with("img/") => {
            let st = state.lock().unwrap();
            match p[4..].parse::<usize>().ok().and_then(|i| st.images.get(i)) {
                Some(img) => respond(&img.mime, img.bytes.clone().into(), true),
                None => Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap(),
            }
        }
        _ => Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap(),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn is_opub(path: &Path) -> bool {
    path.extension().map(|e| e.eq_ignore_ascii_case("opub")).unwrap_or(false)
}

/// Reads a `.pub` or `.opub` file: the document as JSON for the page, and its pictures.
fn load(path: &Path) -> Result<(String, Vec<Image>), String> {
    let doc = if is_opub(path) { opub::read(path)? } else { openpub_core::pubfile::load(path)? };
    page_json(doc, &file_name(path), Some(path), false)
}

/// A document as JSON for the page (`recovered`: from a recovery copy, so unsaved), and its pictures.
fn page_json(mut doc: Document, name: &str, path: Option<&Path>, recovered: bool) -> Result<(String, Vec<Image>), String> {
    let images = std::mem::take(&mut doc.images);
    let mut value = serde_json::to_value(&doc).map_err(|e| e.to_string())?;
    // the page only needs to know how many pictures there are
    value["images"] = serde_json::Value::Array(images.iter().map(|i| serde_json::json!({ "mime": i.mime, "orientation": i.orientation })).collect());
    value["name"] = name.into();
    if let Some(p) = path {
        value["path"] = p.to_string_lossy().to_string().into();
    }
    if recovered {
        value["recovered"] = true.into();
    }
    Ok((value.to_string(), images))
}

/// A blank one-page publication, as JSON for the page.
fn blank(width: f64, height: f64, name: &str, template: Option<&str>) -> String {
    let mut doc = Document { width, height, default_tab: 36.0, ..Default::default() };
    doc.pages.push(openpub_core::model::Page { name: String::new(), number: 1, shapes: Vec::new(), ..Default::default() });
    // line spacing needs the metrics of the fonts people are likely to pick
    for font in ["Calibri", "Arial", "Times New Roman", "Cambria", "Georgia", "Verdana", "Tahoma", "Segoe UI", "Comic Sans MS", "Century Gothic", "Arial Black"] {
        if let Some(m) = openpub_core::fonts::metrics(font) {
            doc.fonts.insert(font.to_string(), m);
        }
    }
    let mut value = serde_json::to_value(&doc).unwrap_or_default();
    value["name"] = name.into();
    if let Some(t) = template {
        value["template"] = t.into();
    }
    value.to_string()
}

/// The document the page sent, with the pictures put back.
fn document_from(json: &str, images: &[Image]) -> Result<Document, String> {
    let mut doc: Document = serde_json::from_str(json).map_err(|e| format!("The document couldn't be read back: {e}"))?;
    doc.images = images.to_vec();
    Ok(doc)
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn main() -> wry::Result<()> {
    let mut initial: Option<PathBuf> = None;
    let mut test_script: Option<String> = None;
    for arg in std::env::args_os().skip(1) {
        match arg.to_str() {
            Some("--register") => {
                std::process::exit(if assoc::register().is_ok() { 0 } else { 1 });
            }
            Some("--unregister") => {
                std::process::exit(if assoc::unregister().is_ok() { 0 } else { 1 });
            }
            // development aid: run a script in the page once the document has loaded
            Some(a) if cfg!(debug_assertions) && a.starts_with("--eval=") => test_script = std::fs::read_to_string(&a[7..]).ok(),
            _ => initial = Some(PathBuf::from(arg)),
        }
    }
    let state = Arc::new(Mutex::new(State::default()));
    let testing = test_script.is_some();
    {
        let mut st = state.lock().unwrap();
        st.testing = testing;
        st.test_answer = true;
    }
    // Once the program's page has loaded, the window never navigates again: no reloading (F5, the
    // context menu's Refresh), which would throw away unsaved changes.
    let page_ready = Arc::new(AtomicBool::new(false));
    let nav_ready = page_ready.clone();
    let ipc_ready = page_ready.clone();
    let mut untitled = 0;

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let icon = openpub_core::images::rgba(ICON_PNG).and_then(|(rgba, w, h)| Icon::from_rgba(rgba, w, h).ok());
    let window = WindowBuilder::new().with_title("OpenPub").with_window_icon(icon).with_inner_size(LogicalSize::new(1360.0, 900.0)).build(&event_loop).expect("window");

    let serve_state = state.clone();
    let ipc_state = state.clone();
    let ipc_proxy = proxy.clone();
    let drop_proxy = proxy.clone();
    // WebView2 keeps its working files (cache, settings) in a folder: by default next to the
    // program, which ordinary users can't write to once it is installed in Program Files. Use the
    // person's own profile.
    let data_dir = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("OpenPub").join("WebView2"));
    if let Some(d) = &data_dir {
        let _ = std::fs::create_dir_all(d);
    }
    let mut web_context = wry::WebContext::new(data_dir);
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        // the window never leaves the program's own page, opens no other windows, downloads nothing
        .with_navigation_handler(move |url| own_page(&url) && !nav_ready.load(Ordering::SeqCst))
        // browser keys (F5 reload, Ctrl+F browser find, Ctrl+P browser print...) are the program's own
        .with_browser_accelerator_keys(false)
        .with_new_window_req_handler(|_url, _features| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_url, _path| false)
        .with_custom_protocol("openpub".into(), move |_id, request| serve(&serve_state, request))
        .with_ipc_handler(move |req: Request<String>| on_message(req.body(), &ipc_state, &ipc_proxy, &ipc_ready))
        .with_drag_drop_handler(move |e| {
            match e {
                DragDropEvent::Enter { paths, .. } => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(dropped(&paths)));
                }
                DragDropEvent::Leave => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(0));
                }
                DragDropEvent::Drop { paths, position } => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(0));
                    // pictures are added where they're dropped; a publication is opened
                    if dropped(&paths) == 2 {
                        let _ = drop_proxy.send_event(UserEvent::AddPictures { paths, at: Some((position.0 as f64, position.1 as f64)) });
                    } else if let Some(p) = paths.iter().find(|p| !is_picture(p)).or(paths.first()) {
                        let _ = drop_proxy.send_event(UserEvent::Open { path: p.clone(), asked: false });
                    }
                }
                _ => {}
            }
            true
        })
        .with_devtools(cfg!(debug_assertions))
        .with_url("openpub://localhost/index.html")
        .build(&window);
    let webview = match webview {
        Ok(w) => w,
        Err(e) => {
            // most likely the Microsoft Edge WebView2 Runtime is missing or damaged: say so, rather
            // than closing without a word
            rfd::MessageDialog::new()
                .set_title("OpenPub")
                .set_level(rfd::MessageLevel::Error)
                .set_description(format!("OpenPub couldn't start its window. It needs the Microsoft Edge WebView2 Runtime, which may be missing or out of date on this computer - ask your IT support to install or repair it.

({e})"))
                .show();
            return Err(e);
        }
    };

    let initial_path = initial.clone();
    if let Some(p) = initial {
        let _ = proxy.send_event(UserEvent::Open { path: p, asked: false });
    }

    let note = |webview: &wry::WebView, msg: &str| {
        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.note({})", js_string(msg)));
    };
    let error = |webview: &wry::WebView, msg: &str| {
        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.error({})", js_string(msg)));
    };
    let discard_ok = |state: &Mutex<State>, window: &tao::window::Window| -> bool {
        {
            let st = state.lock().unwrap();
            if !st.dirty {
                return true;
            }
            if st.testing {
                return st.test_answer;
            }
        }
        rfd::MessageDialog::new()
            .set_parent(window)
            .set_title("OpenPub")
            .set_description("This document has changes that haven't been saved. Open another file and lose them?")
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes
    };

    // "Recover the changes?" - Some(true): recover, Some(false): delete the copy, None: not now
    let ask_recover = |state: &Mutex<State>, window: &tao::window::Window, name: &str, time: u64| -> Option<bool> {
        {
            let st = state.lock().unwrap();
            if st.testing {
                return Some(st.test_answer);
            }
        }
        // (Windows shows its own Yes / No / Cancel buttons: the question says what each does)
        let answer = rfd::MessageDialog::new()
            .set_parent(window)
            .set_title("OpenPub - recover unsaved changes")
            .set_level(rfd::MessageLevel::Warning)
            .set_description(format!("OpenPub closed before the changes to \u{201c}{name}\u{201d} were saved. A copy of them was kept at {}.\n\nRecover the changes?\n\nYes \u{2013} open the changes now\nNo \u{2013} delete the copy\nCancel \u{2013} decide later (the copy is kept)", recovery::when(time)))
            .set_buttons(rfd::MessageButtons::YesNoCancel)
            .show();
        match answer {
            rfd::MessageDialogResult::Yes => Some(true),
            rfd::MessageDialogResult::No => Some(false),
            _ => None,
        }
    };
    let initial_given = initial_path.is_some();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::LoopDestroyed => drop_recovery(&state),
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if !state.lock().unwrap().dirty {
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                let answer = rfd::MessageDialog::new()
                    .set_parent(&window)
                    .set_title("OpenPub")
                    .set_description("Save the changes to this document before closing?")
                    .set_buttons(rfd::MessageButtons::YesNoCancel)
                    .show();
                match answer {
                    rfd::MessageDialogResult::Yes => {
                        let _ = webview.evaluate_script("window.ipc.postMessage(JSON.stringify({cmd:'save', doc: OpenPubApp.docJson(), then:'close'}))");
                    }
                    rfd::MessageDialogResult::No => *control_flow = ControlFlow::Exit,
                    _ => {}
                }
            }
            Event::UserEvent(UserEvent::Choose) => {
                if !discard_ok(&state, &window) {
                    return;
                }
                let picked = rfd::FileDialog::new()
                    .set_title("Open")
                    .add_filter("Publications", &["pub", "opub"])
                    .add_filter("Publisher files", &["pub"])
                    .add_filter("OpenPub documents", &["opub"])
                    .add_filter("All files", &["*"])
                    .set_parent(&window)
                    .pick_file();
                if let Some(p) = picked {
                    // (the unsaved changes are only gone once the new file has loaded)
                    let _ = proxy.send_event(UserEvent::Open { path: p, asked: true });
                }
            }
            Event::UserEvent(UserEvent::Open { path, asked }) => {
                if !asked && !discard_ok(&state, &window) {
                    return;
                }
                window.set_title(&format!("Opening {}… – OpenPub", file_name(&path)));
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    // a file damaged in a way the reader doesn't expect must not take the program down
                    let result = std::panic::catch_unwind(|| load(&path)).unwrap_or_else(|_| Err("the file is damaged or isn't a publication OpenPub can read".into()));
                    let _ = proxy.send_event(UserEvent::Loaded { path, result });
                });
            }
            Event::UserEvent(UserEvent::Loaded { path, result }) => match result {
                Ok((json, images)) => {
                    drop_recovery(&state);
                    {
                        let mut st = state.lock().unwrap();
                        st.name = file_name(&path);
                        st.json = Some(json);
                        st.images = images;
                        st.path = Some(path.clone());
                        st.dirty = false;
                    }
                    window.set_title(&format!("{} – OpenPub", file_name(&path)));
                    if !testing {
                        recent::add(&path);
                    }
                    let _ = webview.evaluate_script("window.OpenPubApp && OpenPubApp.reload()");
                    // changes to this publication left over from a window that closed unexpectedly
                    let left = recovery::beside(&path).filter(|f| recovery::is_orphan(f)).or_else(|| recovery::orphans().into_iter().find(|(_, m)| m.original.as_deref() == Some(path.as_path())).map(|(f, _)| f));
                    if let Some(f) = left {
                        let time = recovery::read(&f).map(|(_, m)| m.time).unwrap_or(0);
                        match ask_recover(&state, &window, &file_name(&path), time) {
                            Some(true) => match recover(&state, &f) {
                                Ok(name) => {
                                    window.set_title(&format!("{name} – OpenPub"));
                                    let _ = webview.evaluate_script("window.OpenPubApp && OpenPubApp.reload()");
                                }
                                Err(e) => error(&webview, &format!("The copy couldn't be recovered: {e}")),
                            },
                            Some(false) => recovery::delete(&f),
                            None => {}
                        }
                    }
                    if let Some(js) = test_script.take() {
                        // test scripts write their results to out/ under the current directory
                        let out = std::env::current_dir().map(|d| d.join("out").to_string_lossy().replace('\\', "/") + "/").unwrap_or_else(|_| "out/".into());
                        let _ = webview.evaluate_script(&format!("window.OPENPUB_OUT = {};", js_string(&out)));
                        let _ = webview.evaluate_script(&format!("setTimeout(async () => {{ try {{ {js} }} catch (e) {{ window.ipc.postMessage(JSON.stringify({{cmd:'log', text:'ERROR ' + e + ' ' + (e.stack || '')}})) }} }}, 1500)"));
                    }
                }
                Err(e) => {
                    let title = state.lock().unwrap().path.as_deref().map(|p| format!("{} – OpenPub", file_name(p))).unwrap_or_else(|| "OpenPub".into());
                    window.set_title(&title);
                    if !path.is_file() {
                        recent::remove(&path);
                    }
                    error(&webview, &format!("Couldn't open {}: {e}", path.display()));
                }
            },
            Event::UserEvent(UserEvent::New { width, height, template }) => {
                if !discard_ok(&state, &window) {
                    return;
                }
                untitled += 1;
                let name = format!("Publication{untitled}");
                drop_recovery(&state);
                {
                    let mut st = state.lock().unwrap();
                    st.name = name.clone();
                    st.json = Some(blank(width.clamp(36.0, 14400.0), height.clamp(36.0, 14400.0), &name, template.as_deref()));
                    st.images = Vec::new();
                    st.path = None;
                    st.dirty = false;
                }
                window.set_title(&format!("{name} – OpenPub"));
                let _ = webview.evaluate_script("window.OpenPubApp && OpenPubApp.reload()");
            }
            Event::UserEvent(UserEvent::Save { doc, ask, then, forced }) => {
                let current = state.lock().unwrap().path.clone();
                let target = match &current {
                    _ if forced.is_some() => forced.clone(),
                    Some(p) if is_opub(p) && !ask => Some(p.clone()),
                    _ => {
                        let mut dlg = rfd::FileDialog::new().set_title("Save as an OpenPub document").add_filter("OpenPub documents", &["opub"]).set_parent(&window);
                        if let Some(p) = &current {
                            if let Some(dir) = p.parent() {
                                dlg = dlg.set_directory(dir);
                            }
                            dlg = dlg.set_file_name(format!("{}.opub", p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Publication".into())));
                        } else {
                            dlg = dlg.set_file_name("Publication.opub");
                        }
                        dlg.save_file().map(|p| if is_opub(&p) { p } else { with_ext(p, "opub") })
                    }
                };
                let Some(target) = target else { return };
                let keep = forced.is_none() && !testing;
                let result = {
                    let st = state.lock().unwrap();
                    document_from(&doc, &st.images).and_then(|d| opub::write(&d, &target))
                };
                match result {
                    Ok(()) => {
                        drop_recovery(&state);
                        {
                            let mut st = state.lock().unwrap();
                            st.path = Some(target.clone());
                            st.name = file_name(&target);
                            st.dirty = false;
                        }
                        window.set_title(&format!("{} – OpenPub", file_name(&target)));
                        if keep {
                            recent::add(&target);
                        }
                        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.saved({}, {})", js_string(&file_name(&target)), js_string(&target.to_string_lossy())));
                        if then == Then::Close {
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                    Err(e) => error(&webview, &format!("Couldn't save: {e}")),
                }
            }
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Autosave { doc }) => {
                let job = {
                    let mut st = state.lock().unwrap();
                    if !st.dirty || st.autosave_busy || (st.testing && !st.autosave_test) || st.json.is_none() {
                        return;
                    }
                    if st.recovery.is_none() {
                        st.recovery = recovery::start(st.path.as_deref());
                    }
                    let Some(file) = st.recovery.as_ref().map(|a| a.file.clone()) else { return };
                    st.autosave_busy = true;
                    let meta = recovery::Meta { name: st.name.clone(), original: st.path.clone(), time: recovery::now() };
                    (st.images.clone(), meta, file, st.recovery_gen)
                };
                let (images, meta, file, generation) = job;
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(|| document_from(&doc, &images).and_then(|d| recovery::write_temp(&d, &meta, &file))).unwrap_or_else(|_| Err("couldn't write the copy".into()));
                    let _ = proxy.send_event(UserEvent::Autosaved { generation, file, result });
                });
            }
            Event::UserEvent(UserEvent::Autosaved { generation, file, result }) => {
                let mut st = state.lock().unwrap();
                st.autosave_busy = false;
                match result {
                    // (only if the copy is still wanted: the publication may have been saved meanwhile)
                    Ok(tmp) if generation == st.recovery_gen && st.recovery.as_ref().map(|a| a.file == file).unwrap_or(false) => {
                        if recovery::finish(&tmp, &file).is_ok() {
                            recovery::index_add(&file);
                            st.autosaves += 1;
                        }
                    }
                    Ok(tmp) => {
                        let _ = std::fs::remove_file(tmp);
                    }
                    // (tried again with the next change)
                    Err(_) => {}
                }
            }
            Event::UserEvent(UserEvent::Ready) => {
                // work left over from a window that closed unexpectedly (when no file was named:
                // a named file's own copy is offered when it opens)
                if initial_given || state.lock().unwrap().testing {
                    return;
                }
                if let Some((f, meta)) = recovery::orphans().into_iter().next() {
                    match ask_recover(&state, &window, &meta.name, meta.time) {
                        Some(true) => match recover(&state, &f) {
                            Ok(name) => {
                                window.set_title(&format!("{name} – OpenPub"));
                                let _ = webview.evaluate_script("window.OpenPubApp && OpenPubApp.reload()");
                            }
                            Err(e) => error(&webview, &format!("The copy couldn't be recovered: {e}")),
                        },
                        Some(false) => recovery::delete(&f),
                        None => {}
                    }
                }
            }
            Event::UserEvent(UserEvent::ExportDocx { doc, forced }) => {
                let Some(target) = forced.or_else(|| export_target(&state, &window, "Export as a Word document", "Word documents", "docx")) else { return };
                let result = {
                    let st = state.lock().unwrap();
                    document_from(&doc, &st.images).and_then(|d| openpub_core::docx::export_docx(&d, &target))
                };
                match result {
                    Ok(()) => note(&webview, &format!("Exported {}", file_name(&target))),
                    Err(e) => error(&webview, &format!("Couldn't export: {e}")),
                }
            }
            Event::UserEvent(UserEvent::ExportPdf { width, height, forced }) => {
                let Some(target) = forced.or_else(|| export_target(&state, &window, "Export as PDF", "PDF files", "pdf")) else {
                    let _ = webview.evaluate_script("window.OpenPubApp && OpenPubApp.printDone('')");
                    return;
                };
                let done = proxy.clone();
                let out = target.clone();
                if let Err(e) = pdf::print_to_pdf(&webview, &target, width, height, move |ok| {
                    let _ = done.send_event(UserEvent::PdfDone(if ok { Ok(out) } else { Err("the PDF couldn't be written".into()) }));
                }) {
                    let _ = proxy.send_event(UserEvent::PdfDone(Err(e)));
                }
            }
            Event::UserEvent(UserEvent::PdfDone(result)) => {
                let msg = match result {
                    Ok(p) => format!("Exported {}", file_name(&p)),
                    Err(e) => format!("Couldn't export: {e}"),
                };
                let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.printDone({})", js_string(&msg)));
            }
            Event::UserEvent(UserEvent::AddPicture) => {
                let picked = rfd::FileDialog::new().set_title("Add a picture").add_filter("Pictures", &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff"]).set_parent(&window).pick_file();
                let Some(p) = picked else { return };
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let _ = proxy.send_event(UserEvent::PictureReady(read_picture(&p)));
                });
            }
            Event::UserEvent(UserEvent::PictureReady(result)) => {
                match result {
                    Ok((img, w, h)) => {
                        let index = {
                            let mut st = state.lock().unwrap();
                            st.images.push(img);
                            st.images.len() - 1
                        };
                        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.pictureAdded({index}, {w}, {h})"));
                    }
                    Err(e) => error(&webview, &e),
                }
            }
            Event::UserEvent(UserEvent::Associate) => match assoc::register() {
                Ok(()) => {
                    assoc::open_default_apps();
                    note(&webview, "OpenPub is now registered for .pub files. If another program still opens them, choose OpenPub for .pub in the Windows Default apps page that just opened.");
                }
                Err(e) => error(&webview, &format!("Couldn't register OpenPub for .pub files: {e}")),
            },
            Event::UserEvent(UserEvent::OpenLink(url)) => match safe_link(&url) {
                Ok(url) => {
                    let go = rfd::MessageDialog::new()
                        .set_parent(&window)
                        .set_title("Open this link?")
                        .set_description(format!("{url}\n\nThis opens in your web browser or mail program."))
                        .set_buttons(rfd::MessageButtons::OkCancel)
                        .show();
                    if go == rfd::MessageDialogResult::Ok {
                        if let Err(e) = std::process::Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(&url).spawn() {
                            error(&webview, &format!("Couldn't open the link: {e}"));
                        }
                    }
                }
                Err(e) => error(&webview, &e),
            },
            Event::UserEvent(UserEvent::SavePng { data, name, forced }) => {
                let target = forced.or_else(|| {
                    let mut dlg = rfd::FileDialog::new().set_title("Save page as a picture").add_filter("PNG pictures", &["png"]).set_parent(&window).set_file_name(format!("{name}.png"));
                    if let Some(dir) = state.lock().unwrap().path.as_deref().and_then(|p| p.parent()) {
                        dlg = dlg.set_directory(dir);
                    }
                    dlg.save_file().map(|p| if p.extension().is_some() { p } else { p.with_extension("png") })
                });
                let Some(target) = target else { return };
                match std::fs::write(&target, &data) {
                    Ok(()) => note(&webview, &format!("Saved {}", file_name(&target))),
                    Err(e) => error(&webview, &format!("Couldn't save the picture: {e}")),
                }
            }
            Event::UserEvent(UserEvent::Drag(kind)) => {
                let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.drag({kind})"));
            }
            Event::UserEvent(UserEvent::AddPictures { paths, at }) => {
                if state.lock().unwrap().json.is_none() {
                    note(&webview, "Open a publication or start a new one first, then drop the pictures on a page.");
                    return;
                }
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let (mut items, mut errors) = (Vec::new(), Vec::new());
                    for p in paths.iter().take(20) {
                        match read_picture(p) {
                            Ok(x) => items.push(x),
                            Err(e) => errors.push(e),
                        }
                    }
                    if paths.len() > 20 {
                        errors.push(format!("Only 20 pictures can be added at once ({} were dropped).", paths.len()));
                    }
                    let _ = proxy.send_event(UserEvent::PicturesReady { items, errors, at });
                });
            }
            Event::UserEvent(UserEvent::AddImages { token, list }) => {
                let mut st = state.lock().unwrap();
                if st.json.is_none() {
                    return;
                }
                let mut out = Vec::new();
                for bytes in list {
                    match prepare_picture(bytes, "A border picture") {
                        Ok((img, _, _)) => {
                            st.images.push(img);
                            out.push(st.images.len() - 1);
                        }
                        Err(_) => out.push(usize::MAX),
                    }
                }
                drop(st);
                let list: Vec<serde_json::Value> = out.iter().map(|i| if *i == usize::MAX { serde_json::Value::Null } else { (*i).into() }).collect();
                let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.imagesAdded({}, {})", js_string(&token), serde_json::Value::Array(list)));
            }
            Event::UserEvent(UserEvent::PastePicture(bytes)) => {
                if state.lock().unwrap().json.is_none() {
                    return;
                }
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let (items, errors) = match prepare_picture(bytes, "The pasted picture") {
                        Ok(x) => (vec![x], Vec::new()),
                        Err(e) => (Vec::new(), vec![e]),
                    };
                    let _ = proxy.send_event(UserEvent::PicturesReady { items, errors, at: None });
                });
            }
            Event::UserEvent(UserEvent::PicturesReady { items, errors, at }) => {
                if !errors.is_empty() {
                    error(&webview, &errors.join("\n"));
                }
                if items.is_empty() {
                    return;
                }
                let list: Vec<serde_json::Value> = {
                    let mut st = state.lock().unwrap();
                    if st.json.is_none() {
                        return;
                    }
                    items
                        .into_iter()
                        .map(|(img, w, h)| {
                            let mime = img.mime.clone();
                            st.images.push(img);
                            serde_json::json!({ "index": st.images.len() - 1, "w": w, "h": h, "mime": mime })
                        })
                        .collect()
                };
                let at = at.map(|(x, y)| serde_json::json!([x, y])).unwrap_or(serde_json::Value::Null);
                let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.picturesAdded({}, {at})", serde_json::Value::Array(list)));
            }
            _ => {}
        }
    });
}

/// A link OpenPub will hand to Windows: web and e-mail addresses only (other kinds can start
/// programs), with nothing that could be read as more than an address.
fn safe_link(url: &str) -> Result<String, String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let kind_ok = (lower.starts_with("https://") || lower.starts_with("http://")) && u.len() > 10 || lower.starts_with("mailto:") && u.len() > 9;
    if !kind_ok {
        return Err("Only web addresses (http or https) and e-mail addresses (mailto:) can be opened.".into());
    }
    if u.len() > 2000 || u.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '"' | '<' | '>' | '^' | '`' | '|')) {
        return Err("That address has characters that aren't allowed in a link.".into());
    }
    Ok(u.to_string())
}

/// Asks where to export to, suggesting the document's name with the new extension.
fn export_target(state: &Mutex<State>, window: &tao::window::Window, title: &str, kind: &str, ext: &str) -> Option<PathBuf> {
    let current = state.lock().unwrap().path.clone();
    let mut dlg = rfd::FileDialog::new().set_title(title).add_filter(kind, &[ext]).set_parent(window);
    if let Some(p) = &current {
        if let Some(dir) = p.parent() {
            dlg = dlg.set_directory(dir);
        }
        dlg = dlg.set_file_name(format!("{}.{ext}", p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Publication".into())));
    }
    dlg.save_file().map(|p| if p.extension().map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false) { p } else { with_ext(p, ext) })
}

/// Reads a picture file the person chose: not too large, and a damaged one can't take the
/// program down.
fn read_picture(p: &Path) -> Result<(Image, u32, u32), String> {
    const MAX_FILE: u64 = 50 * 1024 * 1024;
    let size = std::fs::metadata(p).map_err(|e| format!("Couldn't read {}: {e}", file_name(p)))?.len();
    if size > MAX_FILE {
        return Err(format!("{} is too large to add (the limit is 50 MB).", file_name(p)));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Couldn't read {}: {e}", file_name(p)))?;
    let (img, w, h) = std::panic::catch_unwind(|| openpub_core::images::prepare(bytes)).unwrap_or_else(|_| Err(format!("{} is damaged or isn't a picture OpenPub can read.", file_name(p))))?;
    if w == 0 || h == 0 || w > 30000 || h > 30000 {
        return Err(format!("{} is too large to add ({w} × {h} pixels).", file_name(p)));
    }
    Ok((img, w, h))
}

/// The path with `.ext` added (not replacing what follows a dot in the name: "Report v1.2").
fn with_ext(p: PathBuf, ext: &str) -> PathBuf {
    let mut s = p.into_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

/// A message from the page.
fn on_message(body: &str, state: &Mutex<State>, proxy: &EventLoopProxy<UserEvent>, page_ready: &AtomicBool) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(body) else { return };
    let doc = || msg["doc"].as_str().unwrap_or("{}").to_string();
    let forced = || if cfg!(debug_assertions) { msg["path"].as_str().map(PathBuf::from) } else { None };
    let event = match msg["cmd"].as_str() {
        Some("open") => UserEvent::Choose,
        // only files from the recent list: the page can't name arbitrary paths
        Some("openRecent") => match msg["path"].as_str().map(PathBuf::from) {
            Some(p) if recent::contains(&p) => UserEvent::Open { path: p, asked: false },
            _ => return,
        },
        Some("forgetRecent") => {
            if let Some(p) = msg["path"].as_str() {
                recent::remove(Path::new(p));
            }
            return;
        }
        Some("new") => UserEvent::New {
            width: msg["width"].as_f64().unwrap_or(595.276),
            height: msg["height"].as_f64().unwrap_or(841.89),
            // one of the page's own design names
            template: msg["template"].as_str().filter(|t| !t.is_empty() && t.len() <= 32 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).map(str::to_string),
        },
        Some("ready") => {
            page_ready.store(true, Ordering::SeqCst);
            UserEvent::Ready
        }
        Some("autosave") => UserEvent::Autosave { doc: doc() },
        Some("addImages") => {
            use base64::Engine;
            let token: String = msg["token"].as_str().unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
            // small PNG pictures only (at most 16, 1 MB each)
            let list: Vec<Vec<u8>> = msg["list"]
                .as_array()
                .map(|a| a.iter().take(16).filter_map(|v| v.as_str()).filter(|s| s.len() < 1_400_000).filter_map(|s| base64::engine::general_purpose::STANDARD.decode(s).ok()).filter(|b| b.starts_with(&[0x89, b'P', b'N', b'G'])).collect())
                .unwrap_or_default();
            if list.is_empty() {
                return;
            }
            UserEvent::AddImages { token, list }
        }
        Some("pastePicture") => {
            use base64::Engine;
            let data = msg["data"].as_str().unwrap_or("");
            // (50 MB of picture at most)
            if data.len() > 70 * 1024 * 1024 {
                let _ = proxy.send_event(UserEvent::PicturesReady { items: Vec::new(), errors: vec!["The pasted picture is too large to add (the limit is 50 MB).".into()], at: None });
                return;
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return };
            UserEvent::PastePicture(bytes)
        }
        // test aid: picture files added as if dropped at a point of the window
        Some("addPictureFiles") if cfg!(debug_assertions) => {
            let paths: Vec<PathBuf> = msg["paths"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
            let at = match (msg["x"].as_f64(), msg["y"].as_f64()) {
                (Some(x), Some(y)) => Some((x, y)),
                _ => None,
            };
            UserEvent::AddPictures { paths, at }
        }
        Some("autosaveTest") if cfg!(debug_assertions) => {
            state.lock().unwrap().autosave_test = true;
            return;
        }
        // test aids: answer "lose the changes?", open any file, report the program's state
        Some("testAnswer") if cfg!(debug_assertions) => {
            state.lock().unwrap().test_answer = msg["value"].as_bool().unwrap_or(true);
            return;
        }
        Some("openPath") if cfg!(debug_assertions) => match msg["path"].as_str() {
            Some(p) => UserEvent::Open { path: PathBuf::from(p), asked: false },
            None => return,
        },
        Some("save") => UserEvent::Save { doc: doc(), ask: false, then: if msg["then"] == "close" { Then::Close } else { Then::Nothing }, forced: forced() },
        Some("saveAs") => UserEvent::Save { doc: doc(), ask: true, then: Then::Nothing, forced: forced() },
        Some("docx") => UserEvent::ExportDocx { doc: doc(), forced: forced() },
        Some("pdf") => UserEvent::ExportPdf { width: msg["width"].as_f64().unwrap_or(595.0), height: msg["height"].as_f64().unwrap_or(842.0), forced: forced() },
        Some("log") if cfg!(debug_assertions) => {
            println!("[page] {}", msg["text"].as_str().unwrap_or(""));
            return;
        }
        Some("quit") if cfg!(debug_assertions) => UserEvent::Quit,
        Some("addPicture") => UserEvent::AddPicture,
        Some("associate") => UserEvent::Associate,
        // the answer to the first-run question
        Some("assocAnswer") => {
            recent::set_assoc_asked();
            if msg["yes"] == true { UserEvent::Associate } else { return }
        }
        Some("openLink") => UserEvent::OpenLink(msg["url"].as_str().unwrap_or("").to_string()),
        Some("savePng") => {
            use base64::Engine;
            let Ok(data) = base64::engine::general_purpose::STANDARD.decode(msg["data"].as_str().unwrap_or("")) else { return };
            // a PNG and nothing else
            if !data.starts_with(&[0x89, b'P', b'N', b'G']) {
                return;
            }
            let name: String = msg["name"].as_str().unwrap_or("Page").chars().filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
            UserEvent::SavePng { data, name, forced: forced() }
        }
        Some("dirty") => {
            state.lock().unwrap().dirty = msg["value"].as_bool().unwrap_or(false);
            return;
        }
        _ => return,
    };
    let _ = proxy.send_event(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_added_not_replaced() {
        assert_eq!(with_ext(PathBuf::from(r"C:\x\Report v1.2"), "pdf"), PathBuf::from(r"C:\x\Report v1.2.pdf"));
        assert_eq!(with_ext(PathBuf::from("Newsletter"), "opub"), PathBuf::from("Newsletter.opub"));
    }

    #[test]
    fn opub_without_pages_is_refused() {
        let dir = std::env::temp_dir().join(format!("openpub-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.opub");
        let doc = Document { width: 595.0, height: 842.0, ..Default::default() };
        opub::write(&doc, &path).unwrap();
        assert!(!dir.join("empty.opub.tmp").exists(), "the temporary file is gone");
        let err = opub::read(&path).unwrap_err();
        assert!(err.contains("no pages"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
