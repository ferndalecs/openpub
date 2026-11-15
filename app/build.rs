//! Puts the OpenPub icon and version details into the Windows program file.

fn main() {
    println!("cargo:rerun-if-changed=assets/openpub.ico");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/openpub.ico");
        res.set("ProductName", "OpenPub");
        res.set("FileDescription", "OpenPub - Publisher file viewer and editor");
        res.set("CompanyName", "OpenPub");
        if let Err(e) = res.compile() {
            // the program still works without its icon
            println!("cargo:warning=The icon couldn't be embedded: {e}");
        }
    }
}
