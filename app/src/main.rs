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

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use openpub_core::model::{Document, Image};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Icon, WindowBuilder};
use wry::http::{Request, Response, header::CACHE_CONTROL, header::CONTENT_TYPE};
use wry::{DragDropEvent, WebViewBuilder};

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
    Open(PathBuf),
    /// Start a blank publication with this page size (points).
    New { width: f64, height: f64 },
    Loaded { path: PathBuf, result: Result<(String, Vec<Image>), String> },
    Save { doc: String, ask: bool, then: Then, forced: Option<PathBuf> },
    ExportDocx { doc: String, forced: Option<PathBuf> },
    ExportPdf { width: f64, height: f64, forced: Option<PathBuf> },
    Quit,
    PdfDone(Result<PathBuf, String>),
    AddPicture,
    Associate,
    /// Open a web or e-mail address in the person's browser, after asking.
    OpenLink(String),
    /// Save a picture of a page (PNG data from the page) where the person chooses.
    SavePng { data: Vec<u8>, name: String, forced: Option<PathBuf> },
    Drag(bool),
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
    let mut doc = if is_opub(path) { opub::read(path)? } else { openpub_core::pubfile::load(path)? };
    let images = std::mem::take(&mut doc.images);
    let mut value = serde_json::to_value(&doc).map_err(|e| e.to_string())?;
    // the page only needs to know how many pictures there are
    value["images"] = serde_json::Value::Array(images.iter().map(|i| serde_json::json!({ "mime": i.mime, "orientation": i.orientation })).collect());
    value["name"] = file_name(path).into();
    value["path"] = path.to_string_lossy().to_string().into();
    Ok((value.to_string(), images))
}

/// A blank one-page publication, as JSON for the page.
fn blank(width: f64, height: f64, name: &str) -> String {
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
    state.lock().unwrap().testing = testing;
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
        .with_navigation_handler(|url| own_page(&url))
        .with_new_window_req_handler(|_url, _features| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_url, _path| false)
        .with_custom_protocol("openpub".into(), move |_id, request| serve(&serve_state, request))
        .with_ipc_handler(move |req: Request<String>| on_message(req.body(), &ipc_state, &ipc_proxy))
        .with_drag_drop_handler(move |e| {
            match e {
                DragDropEvent::Enter { .. } => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(true));
                }
                DragDropEvent::Leave => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(false));
                }
                DragDropEvent::Drop { paths, .. } => {
                    let _ = drop_proxy.send_event(UserEvent::Drag(false));
                    if let Some(p) = paths.into_iter().next() {
                        let _ = drop_proxy.send_event(UserEvent::Open(p));
                    }
                }
                _ => {}
            }
            true
        })
        .with_devtools(cfg!(debug_assertions))
        .with_url("openpub://localhost/index.html")
        .build(&window)?;

    if let Some(p) = initial {
        let _ = proxy.send_event(UserEvent::Open(p));
    }

    let note = |webview: &wry::WebView, msg: &str| {
        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.note({})", js_string(msg)));
    };
    let error = |webview: &wry::WebView, msg: &str| {
        let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.error({})", js_string(msg)));
    };
    let discard_ok = |state: &Mutex<State>, window: &tao::window::Window| -> bool {
        if !state.lock().unwrap().dirty {
            return true;
        }
        rfd::MessageDialog::new()
            .set_parent(window)
            .set_title("OpenPub")
            .set_description("This document has changes that haven't been saved. Open another file and lose them?")
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
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
                    state.lock().unwrap().dirty = false;
                    let _ = proxy.send_event(UserEvent::Open(p));
                }
            }
            Event::UserEvent(UserEvent::Open(path)) => {
                if !discard_ok(&state, &window) {
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
                    {
                        let mut st = state.lock().unwrap();
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
            Event::UserEvent(UserEvent::New { width, height }) => {
                if !discard_ok(&state, &window) {
                    return;
                }
                untitled += 1;
                let name = format!("Publication{untitled}");
                {
                    let mut st = state.lock().unwrap();
                    st.json = Some(blank(width.clamp(36.0, 14400.0), height.clamp(36.0, 14400.0), &name));
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
                        dlg.save_file().map(|p| if is_opub(&p) { p } else { p.with_extension("opub") })
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
                        {
                            let mut st = state.lock().unwrap();
                            st.path = Some(target.clone());
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
                match std::fs::read(&p).map_err(|e| e.to_string()).and_then(openpub_core::images::prepare) {
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
            Event::UserEvent(UserEvent::Drag(on)) => {
                let _ = webview.evaluate_script(&format!("window.OpenPubApp && OpenPubApp.drag({on})"));
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
    dlg.save_file().map(|p| if p.extension().is_some() { p } else { p.with_extension(ext) })
}

/// A message from the page.
fn on_message(body: &str, state: &Mutex<State>, proxy: &EventLoopProxy<UserEvent>) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(body) else { return };
    let doc = || msg["doc"].as_str().unwrap_or("{}").to_string();
    let forced = || if cfg!(debug_assertions) { msg["path"].as_str().map(PathBuf::from) } else { None };
    let event = match msg["cmd"].as_str() {
        Some("open") => UserEvent::Choose,
        // only files from the recent list: the page can't name arbitrary paths
        Some("openRecent") => match msg["path"].as_str().map(PathBuf::from) {
            Some(p) if recent::contains(&p) => UserEvent::Open(p),
            _ => return,
        },
        Some("forgetRecent") => {
            if let Some(p) = msg["path"].as_str() {
                recent::remove(Path::new(p));
            }
            return;
        }
        Some("new") => UserEvent::New { width: msg["width"].as_f64().unwrap_or(595.276), height: msg["height"].as_f64().unwrap_or(841.89) },
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
