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

* **File screen** (the File button; also the start screen, which opens on New for someone who
  hasn't opened anything yet): New (a blank publication in A4, A5, A3, Letter, A2 poster, A6
  postcard, DL leaflet or business card size, or a ready-made flyer, newsletter, certificate,
  notice, folded leaflet, greeting card or project cover - Ctrl+N), Open with the list of recent
  files, Save, Save As, Export, Print, Info (location, pages, page size, and which of the
  publication's fonts are installed) and Help (how to do the common things, and the keyboard
  shortcuts - F1 or the ? button).
* **Status bar**: page navigation, the selected object with its position and size, the
  two-page view and a zoom slider (10% to 800%).
* **Accessibility**: every control has a name for screen readers and a visible focus outline,
  text meets WCAG AA contrast, the page can be worked with the keyboard (Tab / Shift+Tab select
  the objects one by one and a screen reader hears which, Enter types in one, the arrow keys
  move it, Esc then Tab leaves the page), and in Windows high contrast the publication and the
  colour swatches keep their colours while the selection is drawn in the highlight colour.
* **Open** `.pub` (Publisher 2003 and later) and `.opub` files: File > Open, Ctrl+O, drag and
  drop, or a path on the command line.
* **Edit** (ribbon with Home / Insert / Page / Shape / Table / Picture tabs):
  * Shapes: select (click, Shift+click or drag a box for several, Ctrl+A for all), move, resize,
    rotate (handle, exact angle, ±90°), nudge with the arrow keys, duplicate, delete, cut/copy/
    paste, group/ungroup, bring to front/send to back, exact position and size in cm. Text boxes,
    shapes and lines are drawn with the mouse (choose the tool, then click on the page or drag);
    while moving, sizing or drawing, edges and centres line up with the page edges, centre and
    margins and with other objects, shown by pink guides (Alt to place freely). A right-click
    menu has the common commands.
  * Text: double-click to type, or select a box and just start typing (also in table cells and
    linked text boxes, where the text flows on through the chain); spelling checked as you type;
    font (a list of the computer's fonts, each shown in its own lettering, with the
    publication's and recently used fonts first) and size (a list, or type any size), larger/smaller
    steps, bold/italic/underline,
    strikethrough, superscript/subscript, colour, alignment, bullets and numbering, indents,
    line and paragraph spacing; text-box margins, vertical alignment and columns. A red marker
    shows a box whose text doesn't all fit; Make box fit text and Shrink text to fit fix it, or
    Link to text box carries the text on into another box (an empty one on any page, or a new
    one where the page is clicked) as Publisher's linked boxes do; Break link and the arrows
    between linked boxes too.
  * Find & Replace (Ctrl+F / Ctrl+H) across the whole publication, with Match case, Replace and
    Replace All (one undo step).
  * Shapes and pictures: a gallery of about 60 shapes (basic shapes, block arrows, flowchart,
    stars and banners, callouts); WordArt (words typed on the page - double-click it - font,
    straight/arched/wavy/slanted); fill colour,
    two-colour gradient and transparency, outline colour/width/dash, arrowheads on lines,
    shadow; a picture border (stars, hearts, dots, flowers, squares, checks, apples, smiley faces,
    or one from the publication); colours from a palette with the publication's own and recently used colours; align objects with
    each other or the page, flip; a link to a web or e-mail address (Ctrl+click opens it, after
    asking); add pictures with Insert > Picture, by dropping picture files on the page or by
    pasting (a screenshot, a picture copied from a web page); replace a picture, crop it with handles or by percentages, brightness, contrast,
    grayscale, show it inside a shape.
  * Tables: insert (point at the size on a grid, or type it); add/delete rows and columns, merge/split cells, cell fill, vertical
    alignment and borders; header-row and banded-row colours.
  * Pages: add, duplicate, delete, reorder (buttons or drag in the page list); page size (A2, A6, DL, business card, A4,
    A5, A3, Letter, Legal, Tabloid or custom) and orientation; page background colour (a
    publication's own background colour, gradient or picture is shown); page
    border; edit the master page items (headers, footers, page numbers).
  * Undo/redo with Ctrl+Z / Ctrl+Y.
* **Save** to OpenPub's own format, `.opub` (a zip with `document.json` and the pictures).
  OpenPub does not write `.pub` files: the original is never modified.
* **Shared folders**: saving over a publication that someone else (or another OpenPub window)
  saved after it was opened asks first: keep both (yours is saved as "name (2).opub" next to
  it) or replace theirs - nobody's changes disappear without a word.
* **Recovery copies**: while there are unsaved changes, a copy is written every 30 seconds (a
  hidden `~$<name>.recovery.opub` next to the publication, or in `%LOCALAPPDATA%\OpenPub\recovery`
  for a new or read-only one). If OpenPub or the computer stops before the work is saved, the
  next time the publication (or OpenPub) is opened it offers the changes back. Saving or closing
  normally removes the copy. A new publication not saved after 5 minutes gets a reminder.
* **Export** to PDF (real text, the publication's page size, fonts embedded, pictures at 220 dpi
  for the size they are shown at and photos as JPEG - a 32 MB booklet of photos gives a 1.5 MB
  PDF; a painting or photo cut out from its background goes in as a JPEG with a see-through mask
  rather than stored without loss, which took an 83-page textbook of watercolours from 16.5 to
  13 MB; drawings and screenshots stay sharp; shadows are drawn as a copy of the shape behind
  it, so they stay real drawing and text in the PDF), a PNG picture of a page, to a Word document (`.docx`:
  editable text boxes - linked where Publisher links them -, real Word numbering, tables,
  pictures with their adjustments, Office shapes, WordArt as Word text effects, shadows, links
  on objects, page backgrounds; pictures sized like the PDF's: the same booklet gives a 1.4 MB
  Word document) and print (pictures sent at 300 dpi for the size they're printed, not the
  camera's size) - every page, or as a folded booklet (pages two to a
  side in folding order, on A4 for pages bigger than A5; also as a PDF booklet).
* **Convert many files at once**: File > Open > Convert a whole folder turns every Publisher file
  in a folder and its subfolders into PDFs, Word documents or `.opub` files, saved next to the
  originals (which aren't changed); files already converted are skipped, and the work carries on
  in the background. For IT, the same from a script:

  ```
  openpub.exe --convert <folder or .pub file> --to pdf|docx|opub [--out <folder>] [--overwrite]
  ```

  `--out` puts the new files in another folder, with the same subfolders; existing files are only
  replaced with `--overwrite`. Each file gets a line (converted, not converted and why, already
  there) in `openpub-convert.log` in the output folder; the exit code is 0 when everything was
  converted, 1 when some files couldn't be, 2 for a mistake in the command. OpenPub is a Windows
  program, so wait for it to finish: `start /wait openpub.exe --convert …` in a batch file,
  `Start-Process openpub.exe -ArgumentList … -Wait -PassThru` in PowerShell. Word and `.opub`
  conversion needs no window; PDFs are drawn by OpenPub in a hidden window (about 8 seconds for
  an 83-page textbook), so run PDF conversions as a logged-on user rather than as SYSTEM.
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
  and settings in `%LOCALAPPDATA%\OpenPub` - or, on an account whose profile can't be written to
  (a broken or redirected profile), in `%TEMP%\OpenPub` (the recovery copies too). Apart from
  the recovery copies described above, the program writes nowhere else unless asked to save,
  export or convert. A conversion writes only the converted files and its log, in the folders it
  was given; the page never chooses where.
* `python tools/fuzz.py [runs] [seed] [slug,slug]` damages copies of sample files in thousands
  of ways and checks the reader never crashes or hangs on them (by default the smaller samples
  and the shapes probe; name samples to include the large ones). The reader's unit tests feed
  damaged freeform outlines to it directly.
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
and text positions, `tools/texttest.js` for the font and size lists, WordArt typed on the page and
text that doesn't fit). `tools/booktest.js` covers pattern fills and booklets; `tools/bordertest.js` picture borders and 3-D WordArt; `tools/gaptest.js` the marker on turned boxes, PDF links and pictures in shapes in Word; `tools/holetest.js` (on the Cymru textbook) text carried on past boxes in the middle of a line, freeform shapes and unhyphenated Welsh text; `tools/a11ytest.js` accessibility: names for screen readers, WCAG AA contrast and focus styles on every ribbon tab, the File screen and Help, and working the page with the keyboard (Tab / Shift+Tab step through the objects, Esc then Tab leaves the page); `tools/pdftest.js` (Year 7 booklet) pictures asked for at the size they are shown while a PDF is made (the PDF must come out under 5 MB); `tools/sharetest.js` saving over a publication someone else has saved since (keep both / replace). `tools/helptest.js` covers the help page, the table grid, the designs (all their text must
fit), the page sizes and the tooltips. `tools/drawtest.js` covers drawing with the mouse, snapping,
the right-click menu, colour swatches, arrowheads and pictures by paste and drop.
`tools/rectest.ps1` checks recovery copies: a window is killed mid-work
and the next one must offer the changes back, and a publication in a folder the person can only
read keeps its copy in their own folder without writing anything beside it (its windows open on
another monitor, without a console); results are printed as `[page] …` lines. `tools/docx-feat.sh` exports the
feature samples to Word, opens each in Word and compares them with Publisher's pages;
`tools/docx-open.ps1` checks that Word accepts an exported document and lists its links.

## Known gaps

* Rendering:
  * Text flows on both sides of a shape in the middle of a frame, as in Publisher - also in
    centred, right-aligned and justified text and inside columns - except in frames holding an
    inline table or picture, frames whose paragraphs are aligned differently, and centred or
    right-aligned text with more than one shape beside a line, where it keeps to the wider
    side. Line breaks beside a shape can differ a little.
  * WordArt: plain, arched, wavy and vertical (stacked) styles are drawn, and the styles that
    fit the words between two edges (slant, cascade, inflate, deflate, fade, triangle, can) by
    scaling and shearing each letter (fade up/down approximated); 3-D WordArt is drawn
    with depth in its side colour, its direction approximated (Office's 3-D projection isn't
    reproduced). Gradients of several colours, gradients from the middle out and texture fills
    are drawn (a texture is spread over the letters rather than repeated at its own size); 3-D
    perspective (WordArt turned in space) comes out flat.
  * BorderArt (picture borders) is drawn from the tiles stored in the file, on Windows. In the
    editor a picture border can be added (eight built-in designs, or one already in the
    publication), resized or taken off. In the Word export it becomes a picture of the border
    over its shape. Gradients have two colours. Pattern fills (shapes
    and page backgrounds) are drawn; in the Word export they become the colour they look like
    from a distance.
  * Strikethrough, small caps, all caps, outline, emboss, engrave, tracking, kerning and
    character width scaling are drawn (scaled words aren't hyphenated).
  * Hyphenation uses English (UK) patterns. Text marked as another language (e.g. Welsh) isn't
    hyphenated, as in Publisher, but Welsh text marked as English is, so its line breaks can
    differ from Publisher's; in English too, Publisher's own hyphenation sometimes breaks a word
    elsewhere.
  * A text line that has to move below a shape is moved down in steps of its line height, as
    Publisher does; a table in the text can still land a point or two away from where
    Publisher puts it.
  * When text doesn't fit a centred or bottom-aligned frame, Publisher drops the lines that
    don't fit before aligning; OpenPub aligns all of them.
  * Some tables that Publisher shows with white cells (no fill stored for them in the file)
    are see-through in OpenPub; what tells Publisher to fill them isn't known yet.
* Editing: undo while typing is per editing session. When a shape that text flows around is
  moved in a document saved by Publisher, the text follows Publisher's saved list of what it
  flows around (shapes added in OpenPub always count). Editing a text box removes any optional
  hyphens the author put in it (OpenPub hyphenates by itself). Copying a linked text box gives a
  box of its own holding the text the original shows; deleting the page with the first box of a
  linked story empties the rest of the story (Undo brings it back).
* Word export: Word lays text out itself, so line breaks can differ from Publisher's; wrapping
  around shapes is approximated per paragraph, on one side of a shape (Word can't make text in a
  text box flow round another object). Links on objects are clickable in exported PDFs.
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
