//! Developer tool: `pubdump raw <file.pub>` prints the low-level structure of a .pub file.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: pubdump raw|json|html|docx <file.pub> [out]");
        std::process::exit(2);
    }
    let path = std::path::Path::new(&args[2]);
    match args[1].as_str() {
        "raw" => print!("{}", openpub_core::pubfile::dump_raw(path).unwrap_or_else(|e| e)),
        "text" => print!("{}", openpub_core::pubfile::dump_text(path).unwrap_or_else(|e| e)),
        "hex" => print!("{}", openpub_core::pubfile::dump_hex(path, &args[3], usize::from_str_radix(&args[4], 16).unwrap(), usize::from_str_radix(&args[5], 16).unwrap()).unwrap_or_else(|e| e)),
        "json" => match openpub_core::pubfile::load(path) {
            Ok(doc) => println!("{}", serde_json::to_string(&doc).unwrap()),
            Err(e) => eprintln!("{e}"),
        },
        "html" => match openpub_core::pubfile::load(path) {
            Ok(doc) => openpub_core::export::export_html(&doc, std::path::Path::new(&args[3])).unwrap(),
            Err(e) => eprintln!("{e}"),
        },
        "docx" => match openpub_core::pubfile::load(path) {
            Ok(doc) => {
                if let Err(e) = openpub_core::docx::export_docx(&doc, std::path::Path::new(&args[3])) {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
            Err(e) => eprintln!("{e}"),
        },
        other => eprintln!("unknown mode {other}"),
    }
}
