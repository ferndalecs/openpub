//! The renderable document model. All lengths are in points (1/72 inch), measured from the
//! top-left corner of the page.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Document {
    pub width: f64,
    pub height: f64,
    pub pages: Vec<Page>,
    /// Distance between default tab stops.
    pub default_tab: f64,
    /// Vertical metrics of the fonts used (Publisher spaces lines with them).
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub fonts: std::collections::BTreeMap<String, FontMetrics>,
    /// Pictures, referenced by index from shapes.
    pub images: Vec<Image>,
    pub notes: Vec<String>,
}

/// A font's ascent, descent and line gap, as fractions of the font size.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct FontMetrics {
    pub ascent: f64,
    pub descent: f64,
    pub gap: f64,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Image {
    pub mime: String,
    /// EXIF orientation of a photo that the renderer must undo (1 = none). Browsers turn photos
    /// the way the camera recorded; Publisher shows the stored pixels as they are.
    #[serde(skip_serializing_if = "is_le_one")]
    pub orientation: u8,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Page {
    pub name: String,
    pub number: u32,
    pub shapes: Vec<Shape>,
    /// Colour behind everything on the page (set in OpenPub).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    /// A gradient or picture behind everything on the page (from a Publisher page background).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_fill: Option<Fill>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Shape {
    /// Publisher's internal id for the shape (debugging aid).
    pub seq: u32,
    /// "text", "picture", "table", "line", "group", "shape"
    pub kind: String,
    /// Office shape type number (1 rectangle, 3 ellipse, 202 text box, ...).
    pub shape_type: u16,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub rotation: f64,
    #[serde(skip_serializing_if = "is_false")]
    pub flip_h: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub flip_v: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub from_master: bool,
    /// Web or e-mail address the object links to (set in OpenPub).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Picture adjustments, -100 to 100 (0 = as stored), and black-and-white.
    #[serde(skip_serializing_if = "is_zero")]
    pub brightness: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub contrast: f64,
    #[serde(skip_serializing_if = "is_false")]
    pub gray: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Fill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<Line>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<usize>,
    /// A border made of small pictures (Publisher's BorderArt).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_art: Option<BorderArt>,
    /// Fractions cropped off the picture: left, top, right, bottom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<Table>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Shape>,
    /// Shape adjust handles (Office "adjust values"), when set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub adjust: Vec<Option<i32>>,
    /// Freeform outline as an SVG path in a `geo` coordinate box.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<Shadow>,
    /// WordArt: text drawn as a shape (fill and outline come from the shape).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wordart: Option<WordArt>,
    /// How text in frames behind this shape flows around it: "square", "tight", "through",
    /// "topbottom" or "none" (None = Publisher's default for the kind of shape).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<String>,
    /// Space kept clear around the shape when text wraps: left, top, right, bottom
    /// (None = 9 pt left and right, 0 above and below - the Office defaults).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_dist: Option<[f64; 4]>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct Shadow {
    pub color: String,
    pub opacity: f64,
    /// Offset in points (right and down are positive).
    pub dx: f64,
    pub dy: f64,
}

impl Default for Shadow {
    fn default() -> Self {
        Shadow { color: "#808080".into(), opacity: 1.0, dx: 2.0, dy: 2.0 }
    }
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct WordArt {
    /// Lines separated by line feeds.
    pub text: String,
    pub font: String,
    #[serde(skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub italic: bool,
    /// Font size in points (WordArt is usually stretched to the shape, so this is a hint).
    pub size: f64,
    /// The text is stretched to fill the shape.
    #[serde(skip_serializing_if = "is_false")]
    pub stretch: bool,
    /// Letters stand on top of one another (each turned a quarter turn against the shape).
    #[serde(skip_serializing_if = "is_false")]
    pub vertical: bool,
}

fn is_le_one(v: &u8) -> bool {
    *v <= 1
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}
fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Path {
    pub d: String,
    /// left, top, right, bottom of the coordinate space the path is drawn in
    pub geo: [f64; 4],
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct Fill {
    pub color: String,
    pub opacity: f64,
    /// Second colour and angle for gradients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color2: Option<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub angle: f64,
    /// Picture used as the fill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<usize>,
}

impl Default for Fill {
    fn default() -> Self {
        Fill { color: "#ffffff".into(), opacity: 1.0, color2: None, angle: 0.0, image: None }
    }
}

/// A picture border: eight pictures (top-left corner, top, top-right corner, right,
/// bottom-right corner, bottom, bottom-left corner, left) drawn `size` points square and
/// repeated along the edges.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct BorderArt {
    pub tiles: Vec<usize>,
    pub size: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct Line {
    pub color: String,
    pub width: f64,
    /// 0 solid, otherwise an Office dash style number
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub dash: u32,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub start_arrow: u32,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub end_arrow: u32,
    /// Arrowhead sizes: 0 narrow/short, 1 medium, 2 wide/long.
    #[serde(skip_serializing_if = "is_one")]
    pub start_arrow_w: u32,
    #[serde(skip_serializing_if = "is_one")]
    pub start_arrow_l: u32,
    #[serde(skip_serializing_if = "is_one")]
    pub end_arrow_w: u32,
    #[serde(skip_serializing_if = "is_one")]
    pub end_arrow_l: u32,
    /// The outline is drawn inside the shape's edge (otherwise centred on it).
    #[serde(skip_serializing_if = "is_false")]
    pub inset: bool,
    /// 0 single, 1 double, 2 thick-thin, 3 thin-thick, 4 triple.
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub compound: u32,
}

impl Default for Line {
    fn default() -> Self {
        Line { color: "#000000".into(), width: 0.75, dash: 0, start_arrow: 0, end_arrow: 0, start_arrow_w: 1, start_arrow_l: 1, end_arrow_w: 1, end_arrow_l: 1, inset: false, compound: 0 }
    }
}

fn is_one(v: &u32) -> bool {
    *v == 1
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct TextBody {
    /// left, top, right, bottom
    pub margins: [f64; 4],
    /// "top", "middle", "bottom"
    pub valign: String,
    pub columns: u32,
    pub column_gap: f64,
    /// Rotation of the text inside its frame in degrees (0, 90, 270).
    #[serde(skip_serializing_if = "is_zero")]
    pub rotate: f64,
    pub paras: Vec<Para>,
    /// Id of the text story (linked frames share one).
    pub story: u32,
    /// Position of this frame in a chain of linked frames (0 = first). Only the first frame of a
    /// chain holds the story's paragraphs; the text flows on into the others in order.
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub chain: u32,
    /// Rectangles (left, top, right, bottom, relative to the frame) of other shapes the text
    /// has to flow around.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub wrap: Vec<[f64; 4]>,
    /// The shapes (by `seq`) Publisher found in this frame's way when the file was saved; only
    /// these (and shapes added in OpenPub) can push its text. None = any shape can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap_with: Option<Vec<u32>>,
    /// The shape (by `seq`) each `wrap` rectangle belongs to.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub wrap_seq: Vec<u32>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Para {
    /// "left", "center", "right", "justify"
    pub align: String,
    pub left: f64,
    pub right: f64,
    pub first: f64,
    pub before: f64,
    pub after: f64,
    /// Line spacing: multiple of single spacing ("sp") unless `spacing_exact`.
    pub spacing: f64,
    #[serde(skip_serializing_if = "is_false")]
    pub spacing_exact: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bullet: Option<Bullet>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<Tab>,
    pub runs: Vec<Run>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Tab {
    pub pos: f64,
    /// "left", "center", "right", "decimal"
    pub align: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader: Option<char>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Bullet {
    /// The bullet character, or empty for numbered lists.
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// For numbered lists, the number format (None for bullets):
    /// 0 "1."  1 "1)"  2 "a."  3 "a)"  4 "A."  5 "A)"  6 "i."  7 "I."  8 "(1)"  9 "1"
    /// 13 "1st."  14 "One."  15 "First."
    /// Consecutive numbered paragraphs with the same format count up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    /// First number of a numbered list (default 1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    /// Overrides the punctuation of `number`: ".", ")", "()" (around), ":" or "" (none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub separator: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Run {
    pub text: String,
    pub font: String,
    pub size: f64,
    #[serde(skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub underline: bool,
    pub color: String,
    /// 1 superscript, 2 subscript
    #[serde(skip_serializing_if = "is_zero_u8")]
    pub script: u8,
    #[serde(skip_serializing_if = "is_false")]
    pub strike: bool,
    /// Text effect: 1 outline (hollow letters), 2 emboss, 3 engrave
    #[serde(skip_serializing_if = "is_zero_u8")]
    pub effect: u8,
    /// 1 small capitals, 2 all capitals
    #[serde(skip_serializing_if = "is_zero_u8")]
    pub caps: u8,
    /// Character spacing as a factor of each character's width (Publisher's "tracking":
    /// 0.875 = tight, 1.25 = very loose); 0 = normal.
    #[serde(skip_serializing_if = "is_zero")]
    pub tracking: f64,
    /// Extra space after each character, in points (Publisher's "kerning": expand or condense).
    #[serde(skip_serializing_if = "is_zero")]
    pub kerning: f64,
    /// "page" for a page-number field
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// A shape (table, picture, ...) that sits in the line like a character.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<Box<Shape>>,
    /// Number of the inline object this run stands for (resolved into `object`).
    #[serde(skip)]
    pub inline: Option<u32>,
}

fn is_zero_u8(v: &u8) -> bool {
    *v == 0
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Table {
    pub cols: Vec<f64>,
    pub rows: Vec<f64>,
    pub cells: Vec<Cell>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Cell {
    /// First/last row and column covered (0-based, inclusive).
    pub r0: u32,
    pub r1: u32,
    pub c0: u32,
    pub c1: u32,
    pub margins: [f64; 4],
    pub valign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Fill>,
    /// left, top, right, bottom
    pub borders: [Option<Line>; 4],
    pub paras: Vec<Para>,
}
