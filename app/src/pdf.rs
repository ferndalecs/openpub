//! PDF export: asks WebView2 to print the page (already laid out one publication page per
//! sheet by the page script) into a PDF with the publication's page size.

use std::path::Path;

#[cfg(windows)]
pub fn print_to_pdf(webview: &wry::WebView, path: &Path, width_pt: f64, height_pt: f64, done: impl FnOnce(bool) + 'static) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{HSTRING, Interface};
    use wry::WebViewExtWindows;

    let e = |e: windows::core::Error| e.message().to_string();
    unsafe {
        let view: ICoreWebView2_7 = webview.webview().cast().map_err(|_| "this version of WebView2 can't write PDFs".to_string())?;
        let env: ICoreWebView2Environment6 = webview.environment().cast().map_err(|_| "this version of WebView2 can't write PDFs".to_string())?;
        let settings = env.CreatePrintSettings().map_err(e)?;
        settings.SetPageWidth(width_pt / 72.0).map_err(e)?;
        settings.SetPageHeight(height_pt / 72.0).map_err(e)?;
        settings.SetMarginTop(0.0).map_err(e)?;
        settings.SetMarginBottom(0.0).map_err(e)?;
        settings.SetMarginLeft(0.0).map_err(e)?;
        settings.SetMarginRight(0.0).map_err(e)?;
        settings.SetScaleFactor(1.0).map_err(e)?;
        settings.SetShouldPrintBackgrounds(true).map_err(e)?;
        settings.SetShouldPrintHeaderAndFooter(false).map_err(e)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            done(result.is_ok() && ok);
            Ok(())
        }));
        view.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler).map_err(e)?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn print_to_pdf(_webview: &wry::WebView, _path: &Path, _width_pt: f64, _height_pt: f64, _done: impl FnOnce(bool) + 'static) -> Result<(), String> {
    Err("PDF export is only available on Windows".into())
}
