# OpenPub

A viewer and editor for Microsoft Publisher (`.pub`) files that does not need Publisher.
Open a publication, edit it, and export it to PDF or Word - on any Windows PC, with no Office
licence. With Microsoft retiring Publisher, OpenPub keeps existing publications readable and
usable.

**Download:** the MSI and setup program are on the
[Releases page](https://github.com/ferndalecs/openpub/releases). Windows 10/11, 64-bit; uses the
Microsoft Edge WebView2 runtime that comes with Windows.

For IT: the MSI installs per machine and silently
(`msiexec /i OpenPub.msi /qn`), registers `.pub` and `.opub`, and suits SCCM / Intune / GPO -
see [installer/README.md](installer/README.md) for the options.

```
openpub/
  core/       Rust library: reads .pub files into a document model (core/src/model.rs),
              Word export (docx.rs), HTML export, and `pubdump`, a developer tool
  web/        The page renderer (render.js), hyphenation (hyphen.js, generated) and the
              app's user interface (app.html / app.css / app.js)
  app/        The desktop program: a WebView2 window that hosts web/ and does the file work
  installer/  MSI and EXE installers (WiX) - see installer/README.md
  tools/      Scripts for checking the rendering against Microsoft Publisher itself
  samples/    Your test documents (not in the repository - see below)
```

## Run and build

Needs Rust 1.85 or later (edition 2024) on Windows; the installers also need WiX Toolset 5
(see [installer/README.md](installer/README.md)).

```
cargo run -p openpub -- samples/year7-booklet.pub      # or start without a file and use Open…
cargo build --release -p openpub                       # target/release/openpub.exe
powershell -File installer/build.ps1 -BuildApp         # installer/dist/OpenPub.msi + OpenPubSetup.exe
```

## What it does

* **File screen** (the File button; also the start screen): New (a blank publication in A4,
  A5, A3 or Letter, or a ready-made flyer, newsletter, certificate or notice - Ctrl+N), Open with the list of recent files, Save, Save As, Export, Print,
  and Info (location, pages, page size, and which of the publication's fonts are installed).
* **Status bar**: page navigation, the selected object with its position and size, the
  two-page view and a zoom slider (10% to 800%).
* **Open** `.pub` (Publisher 2003 and later) and `.opub` files: File > Open, Ctrl+O, drag and
  drop, or a path on the command line.
* **Edit** (ribbon with Home / Insert / Page / Shape / Table / Picture tabs):
  * Shapes: select (click, Shift+click or drag a box for several, Ctrl+A for all), move, resize,
    rotate (handle, exact angle, ±90°), nudge with the arrow keys, duplicate, delete, cut/copy/
    paste, group/ungroup, bring to front/send to back, exact position and size in cm.
  * Text: double-click to type (also in table cells and linked text boxes, where the text flows
    on through the chain); font, size (and larger/smaller steps), bold/italic/underline,
    strikethrough, superscript/subscript, colour, alignment, bullets and numbering, indents,
    line and paragraph spacing; text-box margins, vertical alignment and columns.
  * Find & Replace (Ctrl+F / Ctrl+H) across the whole publication, with Match case, Replace and
    Replace All (one undo step).
  * Shapes and pictures: a gallery of about 60 shapes (basic shapes, block arrows, flowchart,
    stars and banners, callouts); WordArt (text, font, straight/arched/wavy/slanted); fill colour,
    two-colour gradient and transparency, outline colour/width/dash, shadow; align objects with
    each other or the page, flip; a link to a web or e-mail address (Ctrl+click opens it, after
    asking); replace a picture, crop it with handles or by percentages, brightness, contrast,
    grayscale, show it inside a shape.
  * Tables: insert; add/delete rows and columns, merge/split cells, cell fill, vertical
    alignment and borders; header-row and banded-row colours.
  * Pages: add, duplicate, delete, reorder (buttons or drag in the page list); page size (A4,
    A5, A3, Letter, Legal, Tabloid or custom) and orientation; page background colour (a
    publication's own background colour, gradient or picture is shown); page
    border; edit the master page items (headers, footers, page numbers).
  * Undo/redo with Ctrl+Z / Ctrl+Y.
* **Save** to OpenPub's own format, `.opub` (a zip with `document.json` and the pictures).
  OpenPub does not write `.pub` files: the original is never modified.
* **Export** to PDF (real text, the publication's page size), a PNG picture of a page, to a Word document (`.docx`:
  editable text boxes - linked where Publisher links them -, real Word numbering, tables,
  pictures with their adjustments, Office shapes, WordArt as Word text effects, shadows, links
  on objects, page backgrounds) and print.
* **File association**: the installers register OpenPub for `.pub` and `.opub`; File > Options
  does the same for the current user. `openpub.exe --register` / `--unregister` do it from a
  script.

## How it works

A `.pub` file is an OLE compound file with three parts, all read in `core/src/pubfile.rs`:

* `Contents` – pages, master pages, page size, colour scheme, table grids, which shapes text
  flows around, default tab stops.
* `Escher/EscherStm` – Office drawing records: every shape's position, fill, outline, picture.
  Table cell fills and border segments are hidden shapes in the first drawing.
* `Quill/QuillSub/CONTENTS` – the text stories with character/paragraph formatting, table cell
  boundaries (`TCD`), and inline objects (`EOBJ`).

`core/src/builder.rs` combines them into the model, which is serialised to JSON;
`core/src/fonts.rs` adds the vertical metrics of the installed fonts, which Publisher uses to
space lines. `web/render.js` draws a page from that JSON with HTML/CSS/SVG (`web/shapes.js` has
the outlines of the ~150 Office autoshapes), so text shaping, fonts and printing come from the
browser engine. Text wrapping around shapes is done with CSS floats, one pair per horizontal
slab of the frame, and then corrected after layout: lines keep to Publisher's line grid, and
where a shape sits in the middle of a frame each line gets an invisible spacer at a word
boundary so the text carries on at the shape's far side. The editor (`web/app.js`) changes the same JSON model
and redraws the page; text typed into the page is read back from the DOM into paragraphs and
runs.

`web/hyphen.js` is generated: `cd tools/hyphen && npm install`, then
`node tools/build-hyphen.js` (Hypher + en-GB patterns).

## Security

OpenPub opens files other people made, so it treats them as untrusted:

* The file readers are written in Rust (memory-safe); a damaged file gives an error message.
  Compressed parts have size limits.
* The window is a WebView2 page that only ever shows the program's own files. A content security
  policy allows nothing from the network, no scripts but the program's own, no frames and no
  form posts; navigation to other sites, new windows and downloads are refused. OpenPub itself
  makes no network connections.
* Text from a document is put on the page as text, never as HTML. Colours read from `.opub`
  files must be plain `#rrggbb` values.
* Links on objects open only after a question, and only `http`, `https` and `mailto` addresses.
  Nothing embedded in a document is ever run.
* WebView2 keeps its working files in `%LOCALAPPDATA%\OpenPub\WebView2`, the recent-files list
  and settings in `%LOCALAPPDATA%\OpenPub`. The program writes nowhere else unless asked to
  save or export.
* `python tools/fuzz.py` damages copies of sample files in thousands of ways and checks the
  reader never crashes or hangs on them.
* `cargo audit` checks the Rust dependencies against the RustSec advisory database;
  `tools/sectest.js` checks the page's restrictions against a hostile file made by
  `tools/make-hostile-opub.py`.

The web engine is Microsoft's **WebView2 Runtime**, which is updated by Microsoft (Edge Update,
or WSUS / Configuration Manager), not by OpenPub: keep it current - see
[installer/README.md](installer/README.md). The installers are not code-signed.

## Checking against Publisher

The test documents aren't in the repository (they are other people's publications): put your
own `.pub` files in `samples/`. With Microsoft Publisher installed:

```
powershell -File tools/truth-all.ps1                 # Publisher's page PNGs + shape dump, every sample
python tools/check.py all                            # render every sample, score each page against
                                                     # Publisher's (0 = identical), out/shots-<slug>/
python tools/check.py <slug> 3 4                     # one sample, some pages
python tools/sheet.py out/shots-<slug> out/sheet.png 3 4   # side-by-side sheet (ours | Publisher)
python tools/inkrows.py <slug> <page> x0 y0 x1 y1    # where text lines start, ours vs Publisher
powershell -File tools/pubprobe.ps1 -Pub x.pub -Pages 2 -Expr '$s.TextWrap.Type'   # ask Publisher
```

`tools/makeprobe*.ps1` build test publications in Publisher through automation (wrapping, lists,
shapes and WordArt, vertical alignment, columns, page backgrounds, BorderArt) - see `samples/probe/`. `tools/samples.py` lists the
samples and their slugs.

The editor has automated checks that run inside a debug build:
`target/debug/openpub.exe samples/year7-booklet.pub --eval=tools/edittest.js` (and
`tools/apptest.js`, `tools/filetest.js` for the File screen and status bar, `tools/findtest.js` for Find &
Replace and the text buttons, `tools/pagetest.js` for the shapes gallery, align/flip and page
setup, `tools/extratest.js` for WordArt, effects, links, table styles, picture adjustments,
the page picture and the designs, `tools/wraptest.js` for editing text that flows round a
shape, `tools/safetytest.js` for not losing unsaved work, `tools/linktest.js` for linked text boxes
and text positions); results are printed as `[page] …` lines. `tools/docx-feat.sh` exports the
feature samples to Word, opens each in Word and compares them with Publisher's pages;
`tools/docx-open.ps1` checks that Word accepts an exported document and lists its links.

## Known gaps

* Rendering:
  * Text flows on both sides of a shape in the middle of a frame, as in Publisher - also in
    centred, right-aligned and justified text and inside columns - except in frames holding an
    inline table or picture, frames whose paragraphs are aligned differently, and centred or
    right-aligned text with more than one shape beside a line, where it keeps to the wider
    side. Line breaks beside a shape can differ a little.
  * WordArt: plain, arched, wavy and vertical (stacked) styles are drawn; 3-D/extruded styles,
    multi-stop and preset gradients and textures come out flat or approximated.
  * BorderArt (picture borders) is drawn from the tiles stored in the file, on Windows; it
    can't be added or changed in the editor. Gradients have two colours; patterned fills and
    page backgrounds come out as their main colour.
  * Horizontal scaling of characters isn't drawn (strikethrough, small caps, all caps, outline,
    emboss, engrave, tracking and kerning are).
  * Hyphenation uses English (UK) patterns for all text, so line breaks in other languages
    (e.g. Welsh) can differ from Publisher's.
  * When text doesn't fit a centred or bottom-aligned frame, Publisher drops the lines that
    don't fit before aligning; OpenPub aligns all of them.
* Editing: undo while typing is per editing session. When a shape that text flows around is
  moved in a document saved by Publisher, the text follows Publisher's saved list of what it
  flows around (shapes added in OpenPub always count). Editing a text box removes any optional
  hyphens the author put in it (OpenPub hyphenates by itself). Copying a linked text box gives a
  box of its own holding the text the original shows; deleting the page with the first box of a
  linked story empties the rest of the story (Undo brings it back).
* Word export: Word lays text out itself, so line breaks can differ from Publisher's; wrapping
  around shapes is approximated per paragraph, on one side of a shape. BorderArt and a picture
  shown inside a shape aren't carried into the Word file; links aren't clickable in the PDF.
* Saving back to `.pub` is not supported.

## Contributing

Issues and pull requests are welcome. A `.pub` file that renders wrongly is the most useful bug
report - only attach files you are allowed to share. Before sending a change to the renderer,
run `python tools/check.py all` on your samples to make sure the scores don't get worse.

## Licence

MIT - see [LICENSE](LICENSE). Anyone may use, copy, change and redistribute OpenPub, including
commercially. Third-party parts are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

OpenPub is an independent project, not made or endorsed by Microsoft. Microsoft Publisher,
Word and Windows are trademarks of Microsoft Corporation.
