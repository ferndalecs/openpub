// OpenPub page renderer: turns the document model (see core/src/model.rs) into DOM.
// All model lengths are points; the page element is laid out in CSS pt and scaled by the caller.
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';

  const CSS = `
.op-page { position: relative; background: #fff; overflow: hidden; font-kerning: normal; text-rendering: geometricPrecision; -webkit-font-smoothing: antialiased; }
.op-page * { box-sizing: border-box; }
.op-shape { position: absolute; }
.op-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.op-pic { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; }
.op-pic img { position: absolute; display: block; max-width: none; }
.op-text { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.op-flow { flex: none; width: 100%; }
.op-para { margin: 0; font-size: 0; line-height: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; hyphens: manual; }
.op-para span { font-kerning: normal; }
.op-tab { display: inline-block; text-indent: 0; white-space: pre; }
.op-obj { display: inline-block; position: relative; text-indent: 0; vertical-align: baseline; }
.op-wrap { margin: 0; padding: 0; }
.op-bullet { display: inline-block; text-indent: 0; white-space: pre; }
.op-table { position: absolute; left: 0; top: 0; border-collapse: collapse; table-layout: fixed; border-spacing: 0; }
.op-table td { padding: 0; overflow: hidden; }
.op-cell { width: 100%; }
`;

  function ensureCss(doc) {
    if (doc.getElementById('op-css')) return;
    const st = doc.createElement('style');
    st.id = 'op-css';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  const pt = (v) => (Math.round(v * 1000) / 1000) + 'pt';

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ---- fonts -------------------------------------------------------------------------------

  // Height of a single-spaced line as a multiple of the font size, per font face.
  const naturalCache = new Map();
  let probe = null;
  function naturalLineHeight(font, bold, italic) {
    const key = font + '|' + (bold ? 'b' : '') + (italic ? 'i' : '');
    let v = naturalCache.get(key);
    if (v !== undefined) return v;
    if (!probe) {
      probe = el('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;line-height:normal;font-size:200px;padding:0;border:0;margin:0';
      document.body.appendChild(probe);
    }
    probe.style.fontFamily = fontFamily(font);
    probe.style.fontWeight = bold ? 'bold' : 'normal';
    probe.style.fontStyle = italic ? 'italic' : 'normal';
    probe.textContent = 'Hg';
    v = probe.getBoundingClientRect().height / 200;
    if (!(v > 0.5 && v < 4)) v = 1.2;
    naturalCache.set(key, v);
    return v;
  }

  const SYMBOL_FONTS = /^(symbol|wingdings|wingdings 2|wingdings 3|webdings)$/i;

  function fontFamily(name) {
    return '"' + String(name).replace(/"/g, '') + '", "Calibri", sans-serif';
  }

  // ---- text --------------------------------------------------------------------------------

  // Vertical metrics of the document's fonts (Document.fonts), set by renderPage. Publisher
  // spaces lines with them; browsers use other tables of the same fonts.
  let FONTS = {};

  // The ascent and descent the browser lays text out with (measured in the page: canvas
  // metrics don't always agree with CSS layout).
  const cssCache = new Map();
  function cssMetrics(font, bold, italic) {
    const key = font + '|' + (bold ? 'b' : '') + (italic ? 'i' : '');
    let v = cssCache.get(key);
    if (v) return v;
    const box = el('div');
    box.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;line-height:normal;font-size:100px;padding:0;margin:0;border:0';
    const span = el('span');
    span.style.fontFamily = fontFamily(font);
    span.style.fontWeight = bold ? 'bold' : 'normal';
    span.style.fontStyle = italic ? 'italic' : 'normal';
    span.textContent = 'Hg';
    const mark = el('span');
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    span.appendChild(mark);
    box.appendChild(span);
    (document.body || document.documentElement).appendChild(box);
    const r = span.getBoundingClientRect(), b = mark.getBoundingClientRect();
    box.remove();
    const asc = (b.top - r.top) / 100, desc = (r.bottom - b.top) / 100;
    v = asc > 0.3 && asc < 3 && desc > 0 && desc < 2 ? { asc, desc } : { asc: 0.9, desc: 0.22 };
    cssCache.set(key, v);
    return v;
  }

  /** Height of a single-spaced line in Publisher, as a multiple of the font size. */
  function lineEm(font, bold, italic) {
    const f = FONTS[font];
    return f ? f.ascent + f.descent + f.gap : naturalLineHeight(font, bold, italic);
  }

  function styleRun(span, run, para) {
    const s = span.style;
    s.fontFamily = fontFamily(run.font);
    s.fontSize = pt(run.size);
    if (run.bold) s.fontWeight = 'bold';
    if (run.italic) s.fontStyle = 'italic';
    if (run.underline || run.strike) s.textDecoration = (run.underline ? 'underline' : '') + (run.strike ? ' line-through' : '');
    // text effects as Publisher draws them: hollow letters; or slightly heavier letters with a
    // soft edge (emboss to the lower right, engrave to the upper left)
    if (run.effect === 1) {
      s.webkitTextStroke = `${pt(run.size * 0.045)} ${run.color || '#000000'}`;
      s.webkitTextFillColor = 'transparent';
    } else if (run.effect === 2 || run.effect === 3) {
      const d = pt(run.size * 0.03 * (run.effect === 2 ? 1 : -1));
      s.webkitTextStroke = `${pt(run.size * 0.02)} ${run.color || '#000000'}`;
      s.textShadow = `${d} ${d} ${pt(run.size * 0.03)} rgba(0,0,0,.4)`;
    }
    if (run.caps === 1) s.fontVariantCaps = 'small-caps';
    if (run.caps === 2) s.textTransform = 'uppercase';
    s.color = run.color;
    const em = lineEm(run.font, run.bold, run.italic);
    const lh = para.spacing_exact ? para.spacing : para.spacing * em * run.size;
    s.lineHeight = pt(lh);
    // CSS centres the font's ascent+descent in the line; Publisher puts the baseline a fixed
    // distance from the top of the line (ascent plus most of the line gap) and any extra line
    // spacing underneath. Move the text to where Publisher has it.
    const bm = cssMetrics(run.font, run.bold, run.italic);
    const cssBase = (lh - (bm.asc + bm.desc) * run.size) / 2 + bm.asc * run.size;
    const f = FONTS[run.font];
    const single = em * run.size;
    const pubBase = f ? (f.ascent + 0.85 * f.gap) * run.size : (single - (bm.asc + bm.desc) * run.size) / 2 + bm.asc * run.size;
    const shift = pubBase - cssBase;
    if (Math.abs(shift) > 0.01) { s.position = 'relative'; s.top = pt(shift); }
    // where a line has to end to fit a frame, below the bottom of the letters' box: a single line
    // from the top of the line (the extra spacing of a last line may fall outside the frame)
    span.opBelow = single - (lh + (bm.asc + bm.desc) * run.size) / 2 - shift;
    // for finding the lines again after layout (snapWraps): the CSS baseline below the top of
    // the letters' box, and the line this run asks for (height, baseline below its top)
    span.opLine = { base: bm.asc * run.size - shift, lh, top: cssBase };
    // character spacing: tracking scales every character's width (CSS adds a fixed amount per
    // character, so use the average width of this run's characters); kerning adds points
    let ls = run.kerning || 0;
    if (run.tracking && run.tracking !== 1 && run.text) {
      const chars = [...run.text].length;
      // (a hair tighter: Publisher's own character widths are rounded, and lines it just fits
      // must fit here too)
      if (chars) ls += (run.tracking - 1) * textWidth(run, run.text) / chars - 0.03;
    }
    if (ls) s.letterSpacing = pt(ls);
    if (run.script === 1) { s.verticalAlign = 'super'; s.fontSize = pt(run.size * 0.65); span.opLine = null; }
    if (run.script === 2) { s.verticalAlign = 'sub'; s.fontSize = pt(run.size * 0.65); span.opLine = null; }
  }

  /** Text with its characters made wider or narrower (Publisher's character scaling): CSS can't
   * do that in a line of text, so each word is a box drawn stretched, taking the space it takes
   * stretched; the spaces between words stretch too. (Such words aren't hyphenated.) */
  function scaledText(span, text, run) {
    const k = Math.max(0.05, Math.min(6, run.scale));
    const ls = parseFloat(span.style.letterSpacing) || 0;
    span.style.wordSpacing = pt((k - 1) * textWidth(run, ' '));
    for (const tok of text.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) { span.appendChild(document.createTextNode(tok)); continue; }
      const w = el('span', 'op-sc');
      w.textContent = tok;
      const natural = textWidth(run, tok) + ls * [...tok].length;
      w.style.cssText = `display:inline-block;transform:scaleX(${k});transform-origin:0 0;margin-right:${pt((k - 1) * natural)}`;
      span.appendChild(w);
    }
  }

  /** Width of text in a run's font, in points. */
  let widthCanvas = null;
  function textWidth(run, text) {
    if (!widthCanvas) widthCanvas = document.createElement('canvas').getContext('2d');
    widthCanvas.font = `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}100px ${fontFamily(run.font)}`;
    return widthCanvas.measureText(symbolText(text, run.font)).width * run.size / 100;
  }

  // Symbol-encoded fonts keep their glyphs in the private use area.
  function symbolText(text, font) {
    if (!SYMBOL_FONTS.test(font)) return text;
    let out = '';
    for (const ch of text) {
      const c = ch.codePointAt(0);
      out += c >= 0x20 && c <= 0xff ? String.fromCodePoint(0xf000 + c) : ch;
    }
    return out;
  }

  // Publisher hyphenates automatically: mark where words may break.
  function hyphenate(text, font) {
    if (!window.OpenPubHyphenate || SYMBOL_FONTS.test(font)) return text;
    return window.OpenPubHyphenate(text);
  }

  // Editing support: formatting is kept on the elements so edited text can be read back.
  function runKey(run) {
    return JSON.stringify({ font: run.font, size: run.size, bold: !!run.bold, italic: !!run.italic, underline: !!run.underline, color: run.color, script: run.script || 0, strike: !!run.strike, effect: run.effect || 0, caps: run.caps || 0, tracking: run.tracking || 0, kerning: run.kerning || 0, scale: run.scale || 0 });
  }
  function paraKey(p) {
    const o = Object.assign({}, p);
    delete o.runs;
    return JSON.stringify(o);
  }

  function renderPara(p, ctx) {
    const d = el('div', 'op-para');
    if (ctx.editable) d.dataset.p = paraKey(p);
    const s = d.style;
    s.textAlign = p.align;
    if (p.align === 'justify') s.textAlignLast = 'left';
    if (p.left) s.marginLeft = pt(p.left);
    if (p.right) s.marginRight = pt(p.right);
    if (p.first) s.textIndent = pt(p.first);
    if (p.before) s.marginTop = pt(p.before);
    if (p.after) s.marginBottom = pt(p.after);
    const first = p.runs[0];
    if (p.bullet && first) {
      const b = el('span', 'op-bullet');
      const numbered = p.bullet.number != null;
      const brun = Object.assign({}, first, { font: (!numbered && p.bullet.font) || first.font, bold: numbered && !!first.bold, italic: false, underline: false });
      styleRun(b, brun, p);
      b.textContent = numbered ? numberLabel(p.bullet.number, ctx.listNo || 1, p.bullet.separator) : symbolText(p.bullet.text, brun.font);
      b.contentEditable = 'false';
      if (p.first < 0) b.style.minWidth = pt(-p.first);
      d.appendChild(b);
    }
    let any = false;
    // A picture or table alone on its line is placed wherever the line has any room, overlapping
    // shapes the text would avoid (browsers would move the line down until it fits instead)
    const lone = p.runs.every((r) => r.object || !r.text.trim()) && p.runs.filter((r) => r.object).length === 1 && p.runs.some((r) => r.object && r.object.kind === 'picture');
    let off = 0; // position in the paragraph (model characters)
    for (const run of p.runs) {
      if (run.object) {
        const o = el('span', 'op-obj');
        o.opOff = off++;
        o.opRun = run;
        o.contentEditable = 'false';
        o.style.width = pt(run.object.w);
        o.style.height = pt(run.object.h);
        // a table in the text: Publisher leaves about 3.3pt above it and the font's descent below
        // (Cymru p35, Year 7 booklet p11 and p18)
        if (run.object.kind === 'table' && run.object.table) {
          const f = FONTS[run.font];
          // (moved down rather than given a top margin: a taller line box can be placed
          // differently beside shapes the text flows round - Year 7 booklet p18)
          o.style.top = pt(3.3);
          o.opShift = 3.3;
          o.style.marginBottom = pt(3.3 + (f ? f.descent : 0.25) * (run.size || 10));
          // pushed below a shape, the line moves down in steps of its font's line height (snapWraps)
          if (!p.spacing_exact) o.opStep = (run.size || 10) * lineEm(run.font, run.bold, run.italic) * Math.max(1, p.spacing || 1);
        }
        if (lone && run.object.w > 2) {
          const give = run.object.w - 1;
          if (p.align === 'center') { o.style.marginLeft = pt(-give / 2); o.style.marginRight = pt(-give / 2); }
          else if (p.align === 'right') o.style.marginLeft = pt(-give);
          else o.style.marginRight = pt(-give);
        }
        renderShape(run.object, ctx, o);
        d.appendChild(o);
        any = true;
        continue;
      }
      const parts = run.text.split(/(\t|\n)/);
      for (const part of parts) {
        if (part === '') continue;
        if (part === '\n') {
          const br = el('br');
          const holder = el('span');
          holder.opOff = off++;
          if (ctx.editable) holder.dataset.r = runKey(run);
          styleRun(holder, run, p);
          holder.appendChild(br);
          d.appendChild(holder);
          any = true;
          continue;
        }
        const span = el('span', part === '\t' ? 'op-tab' : '');
        span.opOff = off;
        off += part.length;
        styleRun(span, run, p);
        if (ctx.editable) span.dataset.r = runKey(run);
        if (run.field) span.dataset.field = run.field;
        if (part === '\t') {
          span.textContent = '';
          ctx.tabs.push({ span, para: p, block: d });
        } else if (run.scale > 0 && Math.abs(run.scale - 1) > 0.005 && !run.field) {
          scaledText(span, symbolText(part, run.font), run);
        } else {
          span.textContent = run.field === 'page' ? String(ctx.pageNumber) : (ctx.noHyphen ? symbolText(part, run.font) : hyphenate(symbolText(part, run.font), run.font));
        }
        d.appendChild(span);
        any = true;
      }
    }
    if (!any && first) {
      const span = el('span', 'op-empty');
      if (ctx.editable) span.dataset.r = runKey(first);
      styleRun(span, first, p);
      // a no-break space: empty paragraphs need some width so shapes push them like other lines
      span.textContent = String.fromCharCode(0xa0);
      d.appendChild(span);
    }
    return d;
  }

  // Tabs can only be sized once the text before them has been laid out.
  function layoutTabs(ctx) {
    for (const t of ctx.tabs) {
      const blockRect = t.block.getBoundingClientRect();
      const r = t.span.getBoundingClientRect();
      const k = ctx.pxPerPt();
      // position of the tab inside the paragraph, measured from the paragraph's left indent
      const x = (r.left - blockRect.left) / k + (t.para.left || 0);
      let stop = null;
      for (const ts of t.para.tabs || []) {
        if (ts.pos > x + 0.5) { stop = ts; break; }
      }
      let target;
      if (stop) target = stop.pos;
      else target = (Math.floor((x + 0.5) / ctx.defaultTab) + 1) * ctx.defaultTab;
      t.span.style.width = pt(Math.max(0, target - x));
    }
    ctx.tabs.length = 0;
  }

  // Numbered lists: see Bullet.number in core/src/model.rs for the format codes.
  function roman(n) {
    const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
    return s;
  }
  function letters(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    return s;
  }
  const CARDINAL = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
  const ORDINAL = ['Zeroth', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth'];
  function ordinalSuffix(n) {
    const t = n % 100;
    if (t >= 11 && t <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }
  /** The number itself, without punctuation, for a format code. */
  function numberBody(fmt, n) {
    switch (fmt) {
      case 2: case 3: return letters(n);
      case 4: case 5: return letters(n).toUpperCase();
      case 6: return roman(n);
      case 7: return roman(n).toUpperCase();
      case 13: return ordinalSuffix(n);
      case 14: return CARDINAL[n] || String(n);
      case 15: return ORDINAL[n] || ordinalSuffix(n);
      default: return String(n);
    }
  }
  function numberLabel(fmt, n, sep) {
    if (sep != null) {
      const b = numberBody(fmt, n);
      return sep === '()' ? '(' + b + ')' : b + sep;
    }
    switch (fmt) {
      case 13: case 14: case 15: return numberBody(fmt, n) + '.';
      case 1: return n + ')';
      case 2: return letters(n) + '.';
      case 3: return letters(n) + ')';
      case 4: return letters(n).toUpperCase() + '.';
      case 5: return letters(n).toUpperCase() + ')';
      case 6: return roman(n) + '.';
      case 7: return roman(n).toUpperCase() + '.';
      case 8: return '(' + n + ')';
      case 9: return String(n);
      default: return n + '.';
    }
  }
  window.OpenPubNumberLabel = numberLabel;

  function renderFlow(paras, ctx) {
    const flow = el('div', 'op-flow');
    let prev = null;
    for (const p of paras) {
      const b = p.bullet;
      if (b && b.number != null) {
        const cont = prev && prev.number === b.number && prev.left === p.left && b.start == null;
        ctx.listNo = cont ? ctx.listNo + 1 : (b.start || 1);
        prev = { number: b.number, left: p.left };
      } else if (p.runs.some((r) => r.text || r.object)) {
        prev = null; // an empty paragraph doesn't end a list
      }
      flow.appendChild(renderPara(p, ctx));
    }
    // space after the last paragraph doesn't count towards the height of the text
    if (flow.lastChild) flow.lastChild.style.marginBottom = '0';
    return flow;
  }

  // Text flows around other shapes: one floated element per side whose outline follows the
  // shapes sitting on that side of the frame.
  function addWrap(flow, body, frame) {
    const m = body.margins;
    const cw = frame.w - m[0] - m[2];
    if (cw <= 1) return;
    const rects = [];
    // Publisher tests a line against shapes by its text height; the extra line spacing we add
    // underneath must not count, so shapes start that much lower.
    let slack = 0, head = 0;
    for (const p of body.paras) {
      const r = p.runs[0];
      if (r && !p.spacing_exact && p.spacing > 1) slack = Math.max(slack, (p.spacing - 1) * lineEm(r.font, r.bold, r.italic) * r.size);
    }
    // ...and the empty top of a line, above its capital letters, doesn't count either; nor does
    // the bottom of the line gap, below the descenders (a line reaches from its top to the
    // baseline - ascent plus 85% of the gap - plus the descent)
    let tail = 1.5;
    const fr = body.paras[0] && body.paras[0].runs.find((r) => r.text && r.text.trim());
    if (fr) {
      const f = FONTS[fr.font];
      if (f) {
        head = Math.max(0, (f.ascent + 0.85 * f.gap - 0.72) * fr.size);
        tail = 0.15 * f.gap * fr.size + 0.05;
      }
    }
    const p0 = body.paras[0];
    const firstH = fr ? lineEm(fr.font, fr.bold, fr.italic) * fr.size * (p0.spacing_exact ? 1 : Math.max(1, p0.spacing || 1)) : 0;
    // A shape wrapped tightly comes as thin bands (r[4] says which shape): the line's own top and
    // bottom allowances apply to the shape as a whole, so move all its bands down by the bottom
    // allowance and take the top one off its last.
    const bottoms = new Map();
    for (const r of body.wrap) if (r[4] != null) bottoms.set(r[4], Math.max(bottoms.has(r[4]) ? bottoms.get(r[4]) : -Infinity, r[3]));
    for (const r of body.wrap) {
      const x0 = Math.max(0, r[0] - m[0]), x1 = Math.min(cw, r[2] - m[0]);
      const y0 = Math.max(0, r[1] - m[1] + slack + tail);
      // (a shape hanging down over the top of the text: the first line must clear it entirely,
      // if the frame has room for it below - Year 7 booklet p11, where a heading box reaches
      // 0.7pt into the frame's text; short heading frames (p10) keep their line where it is)
      const room = frame.h - m[1] - m[3] >= r[3] - m[1] + firstH;
      const h = r[1] - m[1] <= 0 && room ? 0 : head;
      const y1 = r[4] != null ? Math.min(r[3] + slack + tail, bottoms.get(r[4]) - h) - m[1] : r[3] - m[1] - h;
      if (x1 - x0 > 0.5 && y1 - y0 > 0.5) rects.push({ x0, x1, y0, y1 });
    }
    if (!rects.length) return;
    // Text can pass on both sides of a shape when its paragraphs are all aligned the same way
    // (centred and right-aligned lines are centred or right-aligned in each gap: `align` 0.5, 1).
    // (a table or picture in the text can't be split around a shape: such frames keep to one gap)
    const kinds = new Set(body.paras.map((p) => (p.align === 'center' ? 0.5 : p.align === 'right' ? 1 : 0)));
    const twoSided = kinds.size === 1 && body.paras.every((p) => !p.runs.some((r) => r.object));
    const align = twoSided ? [...kinds][0] : 0;
    const cols = columnsOf(body, frame);
    // An unbroken run longer than a line (rows of underscores to write on) is broken wherever a
    // line ends. Publisher doesn't squeeze pieces of it into the slivers beside a shape: for
    // such text a gap must be wide enough to be worth a line.
    const lineW = cols ? cols.w : cw;
    const longRun = body.paras.some((p) => p.runs.some((r) => !r.object && r.text.split(/\s+/).some((w) => w.length * r.size * 0.45 > lineW)));
    const minGap = longRun ? Math.min(72, lineW / 3) : 0;
    if (cols) {
      // In a frame with columns the browser lays the flow out as one tall strip cut into
      // columns: put each column's part of the shapes at that column's place in the strip.
      const strip = [];
      for (let c = 0; c < cols.n; c++) {
        const left = c * (cols.w + cols.gap);
        for (const r of rects) {
          const x0 = Math.max(0, r.x0 - left), x1 = Math.min(cols.w, r.x1 - left);
          const y0 = Math.max(0, r.y0), y1 = Math.min(cols.h, r.y1);
          if (x1 - x0 > 0.5 && y1 - y0 > 0.5) strip.push({ x0, x1, y0: y0 + c * cols.h, y1: y1 + c * cols.h });
        }
      }
      if (!strip.length) return;
      flow.opWrap = { rects: strip, cw: cols.w, twoSided, align, cols: cols.n, minGap };
      buildFloats(flow);
      return;
    }
    flow.opWrap = { rects, cw, twoSided, align, minGap };
    buildFloats(flow);
  }

  const MIN_GAP = 12;

  /** The columns of a text body in its frame: how many, how wide, the gap and the height (points),
   * or null for a single column. */
  function columnsOf(body, frame) {
    const n = Math.min(63, Math.floor(body.columns || 1));
    if (!(n > 1) || !frame) return null;
    const m = body.margins;
    const w = frame.w - m[0] - m[2], h = frame.h - m[1] - m[3];
    const gap = Math.max(0, Math.min(body.column_gap || 0, w / n));
    const cw = (w - (n - 1) * gap) / n;
    if (!(cw > 4 && h > 4)) return null;
    return { n, w: cw, gap, h };
  }

  /**
   * Text on both sides of a shape. CSS floats only push text in from the frame's edges, so where a
   * shape sits in the middle (flow.opWrap.holes), each line that would run across it gets an
   * invisible spacer at a word boundary: the line carries on at the far side of the shape, as in
   * Publisher. Spacers have the class op-wrap, which the editor skips when it reads text back.
   */
  function fillHoles(flow, k) {
    // start afresh: take the spacers out and join the pieces of text they split
    for (const g of [...flow.querySelectorAll('.op-gap')]) g.remove();
    for (const s of [...flow.querySelectorAll('span')]) {
      if (s.opSpaced) { s.style.wordSpacing = ''; s.opSpaced = false; }
      const before = s.previousSibling;
      if (s.opTail && before && before.nodeType === 1 && before.firstChild && before.firstChild.nodeType === 3 && s.firstChild && s.firstChild.nodeType === 3) {
        before.firstChild.appendData(s.firstChild.data);
        s.remove();
      }
    }
    const W = flow.opWrap;
    if (!W || !W.holes || !W.holes.length) return false;
    // Justified text is set out as left-aligned text first (stretched lines can't be measured
    // for what fits beside a shape); justifyParts then spreads each part of a line over its gap.
    const justified = W.align ? [] : [...flow.children].filter((p) => p.classList.contains('op-para') && p.style.textAlign === 'justify');
    for (const p of justified) p.style.textAlign = 'left';
    const sh = W.shift || 0;
    const tried = new Map();
    let cursor = -Infinity, did = false;
    // in a frame with columns the shapes are placed along one tall strip (addWrap): a piece of
    // text in column c is c columns to the left and c column-heights further down the strip
    const cols = flow.opCols;
    for (let guard = 0; guard < 600; guard++) {
      const fr = flow.getBoundingClientRect();
      // the lines, with the pieces of text on each
      const lines = [];
      for (const para of flow.children) {
        if (!para.classList.contains('op-para')) continue;
        for (const span of para.children) {
          const l = span.opLine;
          if (!l || span.classList.contains('op-gap')) continue;
          for (const r of span.getClientRects()) {
            if (!r.height) continue;
            const c = cols ? Math.max(0, Math.min(cols.n - 1, Math.floor(((r.left - fr.left) / k + 0.5) / (cols.w + cols.gap)))) : 0;
            const left = fr.left + (cols ? c * (cols.w + cols.gap) * k : 0);
            const base = (r.top - fr.top) / k + l.base + (cols ? c * cols.h : 0);
            let line = lines.find((x) => Math.abs(x.base - base) < 0.6);
            if (!line) lines.push((line = { base, above: 0, below: 0, parts: [], left }));
            line.above = Math.max(line.above, l.top);
            line.below = Math.max(line.below, l.lh - l.top);
            line.parts.push({ span, x0: (r.left - left) / k, x1: (r.right - left) / k, top: r.top, bottom: r.bottom });
          }
        }
      }
      lines.sort((a, b) => a.base - b.base);
      let fixed = false;
      for (const line of lines) {
        const top = line.base - line.above - sh, bottom = line.base + line.below - sh;
        if (top < cursor - 0.25) continue;
        // the shapes in this line's way, from the left
        // (line positions are measured from the drawn text, to about a fifth of a point)
        // where a shape begins, not between the thin bands of a curved outline
        const inWay = W.holes.filter((h) => h.y0 < bottom + (h.first ? 0.2 : -0.01) && h.y1 > top + 0.01).sort((a, b) => a.x0 - b.x0);
        for (const h of inWay) {
          // (several slabs give one shape several holes: take their widest extent on this line)
          const x0 = Math.min(...inWay.filter((q) => q.x0 < h.x1 && q.x1 > h.x0).map((q) => q.x0));
          const x1 = Math.max(...inWay.filter((q) => q.x0 < h.x1 && q.x1 > h.x0).map((q) => q.x1));
          const key = Math.round(top * 4) + ':' + Math.round(x0);
          const n = tried.get(key) || 0;
          if (W.align) {
            // centred or right-aligned: every line beside the shape is set out once, whether or
            // not it reaches across
            if (n >= 1) continue;
            tried.set(key, 1);
            if (placeAligned(line, x0, x1, k, h.leftW, h.rightW, W.align)) { fixed = true; did = true; cursor = top; }
            break;
          }
          const crossing = line.parts.filter((q) => q.x1 > x0 + 0.5 && q.x0 < x1 - 0.5 && q.x1 - q.x0 > 0.01).sort((a, b) => a.x0 - b.x0)[0];
          if (!crossing) continue;
          if (n >= 2) continue;
          tried.set(key, n + 1);
          if (placeGap(crossing, x0, x1, { left: line.left }, k, h.leftW, h.rightW)) { fixed = true; did = true; cursor = top; }
          break;
        }
        if (fixed) break;
      }
      if (!fixed) break;
    }
    if (justified.length) {
      for (const g of [...flow.querySelectorAll('span.op-gap')]) if (g.opSeg && justified.includes(g.parentNode)) justifyParts(g, k);
      for (const p of justified) p.style.textAlign = 'justify';
    }
    return did;
  }

  /**
   * Justified text beside a shape: Publisher spreads the words before the shape across the gap
   * on its left and the words after it across the gap on its right. `gap` is the spacer over the
   * shape; the pieces of text on its line get the word spacing that fills their gaps.
   */
  function justifyParts(gap, k) {
    const seg = gap.opSeg;
    const g = gap.getClientRects()[0];
    if (!g) return;
    const onLine = (r) => r.width > 0 && r.bottom > g.top + 1 && r.top < g.bottom - 1;
    const rng = document.createRange();
    const boxOf = (tn, i) => {
      rng.setStart(tn, i);
      rng.setEnd(tn, i + 1);
      for (const r of rng.getClientRects()) if (onLine(r)) return r;
      return null;
    };
    const plain = (s) => s && s.nodeType === 1 && s.tagName === 'SPAN' && !s.classList.contains('op-wrap') && !s.classList.contains('op-tab') && !(s.dataset && s.dataset.field) && s.firstChild && s.firstChild.nodeType === 3 && s.firstChild === s.lastChild;
    // the spans of text on this line on one side of the spacer, cut off from their other lines
    const side = (dir) => {
      const out = [];
      let s = dir < 0 ? gap.previousSibling : gap.nextSibling;
      while (plain(s)) {
        const tn = s.firstChild, n = tn.data.length;
        let a = -1, b = -1;
        for (let i = 0; i < n; i++) if (boxOf(tn, i)) { if (a < 0) a = i; b = i; }
        if (a < 0) break;
        // (blank characters at a line's end have no box: they stay with the line)
        let end = b + 1;
        while (end < n && /\s/.test(tn.data[end])) end++;
        const whole = dir < 0 ? a === 0 || !/\S/.test(tn.data.slice(0, a)) : end >= n;
        let piece = s;
        if (!whole) {
          if (dir < 0) piece = splitSpan(s, a);
          else splitSpan(s, end);
        }
        out.push(piece);
        if (!whole) return { spans: out, more: true };
        s = dir < 0 ? piece.previousSibling : piece.nextSibling;
      }
      // more of the paragraph beyond this line?
      let more = false;
      for (let q = s; q; q = dir < 0 ? q.previousSibling : q.nextSibling) if (q.nodeType === 1 && q.tagName !== 'BR' && !q.classList.contains('op-wrap')) { more = true; break; }
      if (s && s.nodeType === 1 && s.tagName === 'BR') more = false;
      return { spans: out, more };
    };
    const spread = (spans, limit) => {
      // the ink's right edge and the spaces between the words
      let right = -Infinity, spaces = 0, pending = 0, seen = false;
      const order = spans.slice().sort((p, q) => (p.compareDocumentPosition(q) & 4 ? -1 : 1));
      for (const s of order) {
        const tn = s.firstChild;
        for (let i = 0; i < tn.data.length; i++) {
          const ch = tn.data[i];
          if (ch === ' ' || ch === '\u00A0') { if (seen) pending++; continue; }
          const r = boxOf(tn, i);
          if (!r) continue;
          seen = true;
          spaces += pending;
          pending = 0;
          right = Math.max(right, (r.right - seg.left) / k);
        }
      }
      const slack = limit - right - 0.3;
      if (!(spaces > 0) || !(slack > 0.05)) return;
      for (const s of order) { s.style.wordSpacing = pt(slack / spaces); s.opSpaced = true; }
    };
    const leftSide = side(-1), rightSide = side(1);
    if (leftSide.spans.length) spread(leftSide.spans, seg.x0);
    // the word after the spacer stays where it is
    const first = rightSide.spans[0];
    if (first) {
      const r = boxOf(first.firstChild, 0);
      if (r) gap.style.paddingLeft = pt(Math.max(0, parseFloat(gap.style.paddingLeft) + seg.x1 - (r.left - seg.left) / k));
    }
    // (a paragraph's last line isn't spread)
    if (rightSide.spans.length && rightSide.more) spread(rightSide.spans, seg.R);
  }

  /** Puts a spacer before the word that reaches across x0 on this piece of a line, so that the
   * word starts at x1. Returns false when there is nothing to move. */
  function placeGap(part, x0, x1, fr, k, leftW, rightW) {
    const span = part.span;
    const tn = span.firstChild && span.firstChild.nodeType === 3 ? span.firstChild : null;
    // The spacer is an empty copy of the text's own span, as wide as its left padding: a line
    // holding nothing else keeps its height, so a word that doesn't fit after the shape can move
    // down a line at a time, as in Publisher.
    const mkGap = (w) => {
      const g = span.cloneNode(false);
      g.className = 'op-wrap op-gap';
      g.removeAttribute('data-r');
      g.removeAttribute('data-field');
      g.contentEditable = 'false';
      g.style.paddingLeft = pt(Math.max(0, w));
      g.style.letterSpacing = '0';
      return g;
    };
    const rng = document.createRange();
    const box = (i) => {
      rng.setStart(tn, i);
      rng.setEnd(tn, i + 1);
      // a character at a line end can report a box on each line: the one on this line counts
      for (const r of rng.getClientRects()) if (r.bottom > part.top + 1 && r.top < part.bottom - 1 && r.width > 0) return r;
      return null;
    };
    let at = 0, startX = part.x0, longWord = false;
    if (tn && tn.data.length > 1 && !span.classList.contains('op-tab') && !(span.dataset && span.dataset.field)) {
      const text = tn.data;
      // the first character on this line that reaches past x0
      let c = -1, first = -1;
      for (let i = 0; i < text.length; i++) {
        const r = box(i);
        if (!r) continue;
        if (first < 0) first = i;
        if ((r.right - fr.left) / k > x0 + 0.3) { c = i; break; }
      }
      if (c < 0) return false;
      // back to the start of its word (not past the start of this line)
      let j = c;
      while (j > first && !/\s/.test(text[j - 1])) j--;
      if (j === first && first > 0 && !/\s/.test(text[first - 1]) && text[first - 1] !== '\u00AD') j = first; // a word carried on from the line above
      at = j;
      const r = box(Math.min(j, text.length - 1));
      if (r) startX = (r.left - fr.left) / k;
      // A "word" too long for any line (a row of underscores, say) is broken at line ends. It
      // doesn't hop over the shape: it keeps to the wider side (Publisher).
      let ws = c, we = c;
      while (ws > 0 && !/\s/.test(text[ws - 1])) ws--;
      while (we < text.length && !/\s/.test(text[we])) we++;
      const cb = box(c);
      const frameW = span.parentNode.getBoundingClientRect().width / k;
      longWord = !!cb && (we - ws) * cb.width / k > frameW;
      if (longWord && j === first) {
        if (leftW >= rightW && c > first) {
          // stay on the left: the line ends before the shape
          const rest = tn.splitText(c);
          const tail = span.cloneNode(false);
          tail.appendChild(rest);
          tail.opLine = span.opLine;
          tail.opTail = true;
          tail.opBelow = span.opBelow;
          if (span.opOff != null) tail.opOff = span.opOff + tn.data.replace(/\u00AD/g, '').length;
          span.after(tail);
          const br = el('br', 'op-wrap op-gap');
          tail.before(br);
          return true;
        }
        // otherwise it starts after the shape (the spacer below)
      }
    }
    if (startX >= x1 - 0.3) return false;
    // the word already follows a spacer on this line (justified text moved it back): widen that
    const prev = at === 0 ? span.previousSibling : null;
    if (prev && prev.nodeType === 1 && prev.tagName === 'SPAN' && prev.classList.contains('op-gap')) {
      const g = prev.getClientRects()[0];
      if (g && g.bottom > part.top + 1 && g.top < part.bottom - 1) {
        prev.style.paddingLeft = pt(Math.max(0, parseFloat(prev.style.paddingLeft) + x1 - startX));
        return true;
      }
    }
    const gap = mkGap(x1 - startX);
    gap.opSeg = { x0, x1, R: x1 + rightW, left: fr.left };
    let moved = span;
    if (at > 0) {
      // split the piece of text in two: the same formatting, the spacer between them
      const tail = span.cloneNode(false);
      const rest = tn.splitText(at);
      tail.appendChild(rest);
      tail.opLine = span.opLine;
      tail.opTail = true;
      tail.opBelow = span.opBelow;
      if (span.opOff != null) tail.opOff = span.opOff + tn.data.replace(/\u00AD/g, '').length;
      span.after(tail);
      moved = tail;
    }
    // inside an unbroken run there is nowhere for the line to end before the spacer: end it
    if (longWord && moved.previousSibling) moved.before(el('br', 'op-wrap op-gap'));
    moved.before(gap);
    // A word that doesn't fit after the shape goes to the next line whole (Publisher only breaks
    // a word that is wider than the frame); browsers would break it to fill the space.
    if (!longWord) moved.style.overflowWrap = 'normal';
    // where justified text moved the word a little, correct the spacer
    for (let n = 0; n < 2; n++) {
      const r = moved.getClientRects()[0];
      const g = gap.getClientRects()[0];
      if (!r || !g || r.top > g.bottom - 1) break; // the word went to the next line
      const off = x1 - (r.left - fr.left) / k;
      if (Math.abs(off) < 0.15) break;
      gap.style.paddingLeft = pt(Math.max(0, parseFloat(gap.style.paddingLeft) + off));
    }
    return true;
  }

  /** Splits a span of text before character `at`: returns the new span holding the rest (the
   * span itself when there is nothing to split off). */
  function splitSpan(span, at) {
    const tn = span.firstChild;
    if (!(at > 0) || !tn || tn.nodeType !== 3 || at >= tn.data.length) return span;
    const tail = span.cloneNode(false);
    tail.appendChild(tn.splitText(at));
    tail.opLine = span.opLine;
    tail.opTail = true;
    tail.opBelow = span.opBelow;
    if (span.opOff != null) tail.opOff = span.opOff + tn.data.replace(/\u00AD/g, '').length;
    span.after(tail);
    return tail;
  }

  /**
   * Centred or right-aligned text beside a shape (`a` 0.5 or 1): the words that fit in the gap on
   * the left stay there, the line carries on in the gap on the right, and each part is centred
   * (or right-aligned) in its own gap, as in Publisher. Done with two spacers: one where the
   * line jumps the shape, one at its start.
   */
  function placeAligned(line, x0, x1, k, leftW, rightW, a) {
    const parts = line.parts.filter((q) => q.x1 - q.x0 > 0.01).sort((p, q) => p.x0 - q.x0);
    if (!parts.length) return false;
    const left = line.left;
    const start = parts[0].x0, X = start + leftW;
    const rng = document.createRange();
    const boxOf = (tn, i, part) => {
      rng.setStart(tn, i);
      rng.setEnd(tn, i + 1);
      for (const r of rng.getClientRects()) if (r.bottom > part.top + 1 && r.top < part.bottom - 1 && r.width > 0) return r;
      return null;
    };
    const textOf = (span) => (span.firstChild && span.firstChild.nodeType === 3 && !span.classList.contains('op-tab') && !(span.dataset && span.dataset.field) ? span.firstChild : null);
    // where the line starts, and the first word that doesn't fit before the shape
    let head = null, cut = null, splitX = null, sw = 0, lastSeen = null;
    for (const part of parts) {
      const tn = textOf(part.span);
      if (!tn) {
        if (!head) head = { span: part.span, at: 0 };
        if (part.x1 > X + 0.3) { cut = { span: part.span, at: 0 }; splitX = part.x0; break; }
        lastSeen = { span: part.span, end: null };
        continue;
      }
      const text = tn.data;
      let first = -1, c = -1, last = -1;
      for (let i = 0; i < text.length; i++) {
        const r = boxOf(tn, i, part);
        if (!r) continue;
        if (first < 0) first = i;
        last = i;
        if ((r.right - left) / k > X + 0.3) { c = i; break; }
      }
      if (first < 0) continue;
      if (!head) head = { span: part.span, at: first };
      if (c >= 0) {
        let j = c;
        while (j > first && !/\s/.test(text[j - 1])) j--;
        cut = { span: part.span, at: j };
        const r = boxOf(tn, j, part);
        splitX = r ? (r.left - left) / k : part.x0;
        if (j > first && /\s/.test(text[j - 1])) { const s = boxOf(tn, j - 1, part); if (s) sw = s.width / k; }
        break;
      }
      lastSeen = { span: part.span, end: last + 1, text };
    }
    if (!head) return false;
    if (!cut) {
      // the whole line fits before the shape: the right-hand part starts with the next line
      splitX = Math.max(...parts.map((q) => q.x1));
      if (lastSeen && lastSeen.end != null) {
        let e = lastSeen.end;
        while (e < lastSeen.text.length && /\s/.test(lastSeen.text[e])) e++;
        if (e < lastSeen.text.length) cut = { span: lastSeen.span, at: e };
      }
      if (!cut && lastSeen) {
        let nx = lastSeen.span.nextSibling;
        while (nx && nx.nodeType === 1 && nx.classList.contains('op-wrap')) nx = nx.nextSibling;
        if (nx && nx.nodeType === 1 && nx.tagName === 'SPAN') cut = { span: nx, at: 0 };
      }
    }
    const mk = (ref, w) => {
      const g = ref.cloneNode(false);
      g.className = 'op-wrap op-gap';
      g.removeAttribute('data-r');
      g.removeAttribute('data-field');
      g.contentEditable = 'false';
      g.style.letterSpacing = '0';
      g.style.textDecoration = 'none';
      g.style.background = 'none';
      // (a word joiner: an empty box could be left at the end of the line above)
      g.textContent = '\u2060';
      size(g, w);
      return g;
    };
    const size = (g, w) => { g.style.paddingLeft = pt(Math.max(0, w)); g.style.marginLeft = w < 0 ? pt(w) : ''; };
    const hole = x1 - x0;
    const lw = Math.max(0, splitX - start), ls = Math.max(0, leftW - lw);
    const sameSpot = cut && cut.span === head.span && cut.at === head.at;
    // the spacer over the shape: first as wide as keeps the right-hand part to its gap
    const mid = mk(head.span, hole + ls);
    let moved = null;
    if (cut) {
      moved = splitSpan(cut.span, cut.at);
      moved.before(mid);
      moved.style.overflowWrap = 'normal';
    } else {
      parts[parts.length - 1].span.after(mid);
    }
    // how much of the right-hand gap the words there take up
    let rw = 0;
    const g = mid.getClientRects()[0];
    if (g && moved) {
      rng.setStartBefore(moved);
      rng.setEndAfter(moved.parentNode.lastChild);
      for (const r of rng.getClientRects()) {
        if (r.width > 0 && r.top < g.bottom - 1 && r.bottom > g.top + 1 && r.left >= g.right - 0.5) rw = Math.max(rw, (r.right - g.right) / k);
      }
    }
    const rs = Math.max(0, rightW - rw);
    size(mid, hole + (1 - a) * ls + a * rs - a * sw);
    const lead = a * (ls - rs + sw);
    if (Math.abs(lead) > 0.1) {
      const at = sameSpot ? mid : splitSpan(head.span, head.at);
      at.before(mk(head.span, lead));
    }
    return true;
  }

  function buildFloats(flow) {
    const { cw } = flow.opWrap;
    // (shapes stay where they are when centred or bottom-aligned text starts lower: alignWrapped)
    const sh = flow.opWrap.shift || 0;
    const rects = flow.opWrap.rects.map((r) => ({ x0: r.x0, x1: r.x1, y0: Math.max(0, r.y0 - sh), y1: r.y1 - sh })).filter((r) => r.y1 > r.y0);
    for (const f of [...flow.querySelectorAll(':scope > .op-wrap')]) f.remove();
    // Cut the frame into horizontal slabs where the set of shapes doesn't change. In each, the
    // text keeps to one of the gaps the shapes leave (Publisher fills every gap wide enough; one
    // is what CSS floats can do): the widest, preferring the one the slab above used.
    const ys = Array.from(new Set(rects.flatMap((r) => [r.y0, r.y1]))).sort((a, b) => a - b);
    const slabs = [];
    const holes = [];
    flow.opWrap.holes = holes;
    let prev = null;
    // the free gaps between the shapes overlapping [a, b]
    const gapsIn = (a, b) => {
      const xs = rects.filter((r) => r.y0 < b && r.y1 > a).map((r) => [Math.max(0, r.x0), Math.min(cw, r.x1)]).filter((q) => q[1] > q[0]).sort((u, v) => u[0] - v[0]);
      if (!xs.length) return null;
      const gaps = [];
      let x = 0;
      for (const [p, q] of xs) { if (p > x) gaps.push([x, p]); x = Math.max(x, q); }
      if (x < cw) gaps.push([x, cw]);
      return gaps;
    };
    for (let i = 0; i + 1 < ys.length; i++) {
      const a = ys[i], b = ys[i + 1];
      if (b - a < 0.01) continue;
      const xs = gapsIn(a, b);
      let gap = [0, cw];
      // gaps wide enough for a word: with two or more, the text uses all of them (the floats keep
      // it between the first and the last; fillHoles makes each line skip the shapes in between)
      const narrow = Math.max(MIN_GAP, flow.opWrap.minGap || 0);
      const usable = xs && flow.opWrap.twoSided ? xs.filter((g) => g[1] - g[0] >= narrow) : null;
      if (usable && (flow.opWrap.align ? usable.length === 2 : usable.length >= 2)) {
        gap = [usable[0][0], usable[usable.length - 1][1]];
        for (let n = 0; n + 1 < usable.length; n++) {
          const h = { x0: usable[n][1], x1: usable[n + 1][0], y0: a, y1: b, leftW: usable[n][1] - usable[n][0], rightW: usable[n + 1][1] - usable[n + 1][0] };
          // the top of a shape (no hole of the slab above continues into this one)
          h.first = !holes.some((q) => Math.abs(q.y1 - a) < 0.01 && q.x0 < h.x1 && q.x1 > h.x0);
          holes.push(h);
        }
        const lastSlab = slabs[slabs.length - 1];
        if (lastSlab && Math.abs(lastSlab.b - a) < 0.01 && Math.abs(lastSlab.L - gap[0]) < 0.01 && Math.abs(lastSlab.R - gap[1]) < 0.01) lastSlab.b = b;
        else slabs.push({ a, b, L: gap[0], R: gap[1] });
        prev = null;
        continue;
      }
      if (xs) {
        let score = -Infinity;
        gap = [cw, cw];
        for (const g of xs) {
          if (g[1] - g[0] < (flow.opWrap.minGap || 0)) continue; // (too narrow for this text)
          const keep = prev ? Math.max(0, Math.min(g[1], prev[1]) - Math.max(g[0], prev[0])) : 0;
          const s = g[1] - g[0] + 0.25 * keep;
          if (s > score) { score = s; gap = g; }
        }
      }
      const last = slabs[slabs.length - 1];
      if (last && Math.abs(last.b - a) < 0.01 && Math.abs(last.L - gap[0]) < 0.01 && Math.abs(last.R - gap[1]) < 0.01) last.b = b;
      else slabs.push({ a, b, L: gap[0], R: gap[1] });
      prev = xs ? gap : null;
    }
    // one pair of floats per slab, each pair below the one before (an empty float keeps the space
    // between slabs)
    const frag = document.createDocumentFragment();
    let y = 0;
    const add = (side, w, h) => {
      const f = el('div', 'op-wrap');
      f.style.cssText = `float:${side};clear:${side === 'left' ? 'both' : 'none'};width:${pt(Math.max(0, w))};height:${pt(h)}`;
      frag.appendChild(f);
    };
    for (const s of slabs) {
      if (s.L <= 0.01 && s.R >= cw - 0.01) continue;
      if (s.a > y + 0.01) add('left', 0, s.a - y);
      add('left', s.L, s.b - s.a);
      if (s.R < cw - 0.01) add('right', cw - s.R, s.b - s.a);
      y = s.b;
    }
    flow.insertBefore(frag, flow.firstChild);
  }

  /** The lines of a laid-out flow: { top, h } in points from the top of the flow, and whether
   * the line starts a paragraph (with the paragraph's own top). */
  function flowLines(flow, k) {
    const fb = flow.getBoundingClientRect();
    const ft = fb.top;
    // in a frame with columns, a line in column c is c column-heights further down the strip
    const cols = flow.opCols;
    const down = (r) => (cols ? Math.max(0, Math.floor(((r.left - fb.left) / k + 0.5) / (cols.w + cols.gap))) * cols.h : 0);
    const out = [];
    for (const para of flow.children) {
      if (!para.classList.contains('op-para')) continue;
      const lines = [];
      for (const span of para.querySelectorAll('span')) {
        const l = span.opLine;
        if (!l || span.parentElement.closest('.op-obj')) continue; // (not the text in a table)
        for (const r of span.getClientRects()) {
          if (!r.height) continue;
          const base = (r.top - ft) / k + l.base + down(r);
          let line = lines.find((x) => Math.abs(x.base - base) < 0.6);
          if (!line) lines.push((line = { base, above: 0, below: 0 }));
          line.above = Math.max(line.above, l.top);
          line.below = Math.max(line.below, l.lh - l.top);
        }
      }
      lines.sort((a, b) => a.base - b.base);
      const after = parseFloat(para.style.marginBottom) || 0; // (set in pt by renderPara)
      // a table on a line of its own: the line is the table, and moves in steps of the font's
      // line height (Year 7 booklet p18)
      const obj = !lines.length && para.querySelector('.op-obj');
      if (obj && obj.opStep) {
        const r = obj.getBoundingClientRect();
        out.push({ top: (r.top - ft) / k - (obj.opShift || 0) + down(r), h: r.height / k, paraTop: cols ? NaN : (para.getBoundingClientRect().top - ft) / k, advance: obj.opStep });
        continue;
      }
      lines.forEach((l, i) => out.push({
        top: l.base - l.above,
        h: l.above + l.below,
        // (a paragraph cut across columns has no single top: only the frame's first line is known)
        paraTop: i !== 0 ? null : !cols ? (para.getBoundingClientRect().top - ft) / k : para === flow.querySelector('.op-para') ? 0 : NaN,
        // how far the next line starts below this one's top: its height and, for a paragraph's
        // last line, the space after the paragraph
        advance: l.above + l.below + (i === lines.length - 1 ? after : 0),
      }));
    }
    return out;
  }

  /**
   * Publisher keeps a frame's lines on a grid, one line height apart: a line that can't sit next
   * to a shape moves down a whole line at a time until it's clear, where CSS puts it right under
   * the shape. Lengthen the floats so such lines land where Publisher puts them.
   */
  function snapWraps(flows, k) {
    for (const flow of flows) {
      if (!flow.isConnected || !flow.opWrap) continue;
      alignWrapped(flow, k);
      fillHoles(flow, k);
      let snapped = false;
      const done = new Set();
      for (let pass = 0; pass < 8; pass++) {
        const lines = flowLines(flow, k);
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
          const L = lines[i];
          const expect = L.paraTop != null ? L.paraTop : i > 0 ? lines[i - 1].top + lines[i - 1].h : null;
          if (expect == null || !(L.top - expect >= 0.5) || L.h < 1) continue;
          // (at least one: a line pushed down a fraction of a point still moves a whole line)
          const steps = Math.max(1, Math.ceil((L.top - expect) / L.advance - 0.02));
          const extra = expect + steps * L.advance - L.top;
          if (extra < 0.3) continue;
          // the shape it was pushed under
          const r = flow.opWrap.rects.find((q) => !done.has(q) && Math.abs(q.y1 - L.top) < 1.2);
          if (!r) continue;
          done.add(r);
          r.y1 += extra;
          changed = true;
          break;
        }
        if (!changed) break;
        snapped = true;
        buildFloats(flow);
      }
      if (snapped) fillHoles(flow, k); // the floats changed: place the spacers again
      alignWrapped(flow, k);
    }
  }

  /**
   * Centred or bottom-aligned text in a frame with shapes in the way: the floats standing for
   * the shapes would count towards the height of the text if the flex box aligned it, so the text
   * is laid out from the top and moved down here by the space left under its last line.
   */
  function alignWrapped(flow, k) {
    if (!flow.opValign) return;
    const box = flow.parentElement;
    const cs = getComputedStyle(box);
    const avail = box.getBoundingClientRect().height / k - (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) * 0.75;
    for (let i = 0; i < 4; i++) {
      const lines = flowLines(flow, k);
      if (!lines.length) return;
      const cur = flow.opWrap.shift || 0;
      const last = lines[lines.length - 1];
      const height = last.top + last.h - cur - (flow.opExtra || 0);
      const off = Math.max(0, (avail - height) / (flow.opValign === 'middle' ? 2 : 1));
      if (Math.abs(off - cur) < 0.2) return;
      flow.opWrap.shift = off;
      flow.style.paddingTop = pt(off);
      buildFloats(flow);
    }
  }

  function renderTextBody(body, ctx, frame, area) {
    const box = el('div', 'op-text');
    const owner = body;
    let m = body.margins;
    // text keeps clear of the outline: all of it when it's drawn inside the edge, half otherwise
    const lw = frame && frame.line ? (frame.line.inset && insetShape(frame) ? frame.line.width : frame.line.width / 2) : 0;
    // and of the shape's own edges (an ellipse holds its text in a smaller rectangle)
    const a = area || [0, 0, frame ? frame.w : 0, frame ? frame.h : 0];
    const inner = frame ? [a[0], a[1], frame.w - a[2], frame.h - a[3]] : [0, 0, 0, 0];
    if (lw || inner.some((v) => v)) {
      m = m.map((v, i) => v + lw + Math.max(0, inner[i]));
      body = Object.assign({}, body, { margins: m });
    }
    box.style.padding = `${pt(m[1])} ${pt(m[2])} ${pt(m[3])} ${pt(m[0])}`;
    box.style.justifyContent = body.valign === 'middle' ? 'center' : body.valign === 'bottom' ? 'flex-end' : 'flex-start';
    ctx.noHyphen = !!frame && frame.w < 30;
    const flow = renderFlow(body.paras, ctx);
    ctx.noHyphen = false;
    flow.opOwner = owner;
    if (ctx.editable && frame && frame.kind === 'text' && !owner.chain && body.paras.every((p) => p.runs.every((r) => !r.object && !/\S/.test(r.text)))) flow.classList.add('op-blank');
    // Centring and bottom alignment leave out the extra line spacing under the last line
    // (measured: tools/makeprobe4.ps1)
    if (body.valign === 'middle' || body.valign === 'bottom') {
      const last = body.paras[body.paras.length - 1];
      if (last && !last.spacing_exact && last.spacing > 1) {
        const extra = Math.max(0, ...last.runs.filter((r) => !r.object).map((r) => (last.spacing - 1) * lineEm(r.font, r.bold, r.italic) * r.size));
        if (extra > 0) { flow.style.marginBottom = pt(-extra); flow.opExtra = extra; }
      }
    }
    // columns: the text runs down one and carries on at the top of the next (what doesn't fit
    // the last one is hidden, as text that doesn't fit a frame is)
    const cols = columnsOf(body, frame);
    if (cols) {
      flow.style.columnCount = cols.n;
      flow.style.columnGap = pt(cols.gap);
      flow.style.columnFill = 'auto';
      flow.style.height = pt(cols.h);
      flow.style.marginBottom = '';
      flow.opCols = cols; // { n, w, gap, h }
      box.style.justifyContent = 'flex-start';
    }
    const wraps = frame && ctx.wraps ? ctx.wraps.get(frame) : null;
    if (wraps && wraps.length) addWrap(flow, Object.assign({}, body, { wrap: wraps }), frame);
    if (flow.opWrap && ctx.wrapFlows) {
      ctx.wrapFlows.push(flow);
      if (!cols && (body.valign === 'middle' || body.valign === 'bottom')) {
        flow.opValign = body.valign;
        box.style.justifyContent = 'flex-start';
      }
    }
    box.appendChild(flow);
    return box;
  }

  // ---- shapes ------------------------------------------------------------------------------

  let gradId = 0;

  const HEX16 = /^[0-9a-f]{16}$/i;
  /** The dots of a pattern fill: [x, y] of each set bit. */
  function patternDots(bits) {
    const out = [];
    for (let y = 0; y < 8; y++) {
      const row = parseInt(bits.slice(y * 2, y * 2 + 2), 16);
      for (let x = 0; x < 8; x++) if (row & (0x80 >> x)) out.push([x, y]);
    }
    return out;
  }
  // (a pattern dot is 0.75 pt: an 8-dot tile is 6 pt, as Publisher draws it at 96 dots per inch)
  const PATTERN_DOT = 0.75;
  /** A pattern as a picture for a CSS background (page backgrounds). */
  function patternCss(f) {
    const back = /^#[0-9a-f]{6}$/i.test(f.back || '') ? f.back : '#ffffff';
    const rects = patternDots(f.pattern).map(([x, y]) => `<rect x='${x}' y='${y}' width='1' height='1'/>`).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' shape-rendering='crispEdges'><rect width='8' height='8' fill='${back}'/><g fill='${f.color}'>${rects}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / ${pt(8 * PATTERN_DOT)} ${pt(8 * PATTERN_DOT)} repeat`;
  }

  function paint(node, shape, svg) {
    const f = shape.fill;
    if (f && !f.image && HEX16.test(f.pattern || '') && /^#[0-9a-f]{6}$/i.test(f.color)) {
      const id = 'opp' + (++gradId);
      const u = PATTERN_DOT, p = svgEl('pattern', { id, patternUnits: 'userSpaceOnUse', width: 8 * u, height: 8 * u });
      p.appendChild(svgEl('rect', { width: 8 * u, height: 8 * u, fill: /^#[0-9a-f]{6}$/i.test(f.back || '') ? f.back : '#ffffff' }));
      for (const [x, y] of patternDots(f.pattern)) p.appendChild(svgEl('rect', { x: x * u, y: y * u, width: u, height: u, fill: f.color, 'shape-rendering': 'crispEdges' }));
      const defs = svgEl('defs', {});
      defs.appendChild(p);
      svg.appendChild(defs);
      node.setAttribute('fill', `url(#${id})`);
      if (f.opacity < 1) node.setAttribute('fill-opacity', f.opacity);
    } else if (f && !f.image) {
      if (f.color2) {
        const id = 'opg' + (++gradId);
        const a = ((f.angle || 0) - 90) * Math.PI / 180;
        const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
        const g = svgEl('linearGradient', { id, x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy });
        g.appendChild(svgEl('stop', { offset: 0, 'stop-color': f.color }));
        g.appendChild(svgEl('stop', { offset: 1, 'stop-color': f.color2 }));
        const defs = svgEl('defs', {});
        defs.appendChild(g);
        svg.appendChild(defs);
        node.setAttribute('fill', `url(#${id})`);
      } else {
        node.setAttribute('fill', f.color);
      }
      if (f.opacity < 1) node.setAttribute('fill-opacity', f.opacity);
    } else {
      node.setAttribute('fill', 'none');
    }
    const l = shape.line;
    if (l) {
      node.setAttribute('stroke', l.color);
      node.setAttribute('stroke-width', l.width);
      const w = Math.max(l.width, 0.5);
      const dash = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1], 5: [1, 1], 6: [4, 3], 7: [8, 3], 8: [4, 3, 1, 3], 9: [8, 3, 1, 3], 10: [8, 3, 1, 3, 1, 3] }[l.dash];
      // round ends: the caps add half the width at each end of a dash, so dots come out round
      // and as far apart as square ones would be (Publisher's "round dot": 0x1d7 = 0; style 5)
      const round = l.round || l.dash === 5;
      if (round) node.setAttribute('stroke-linecap', 'round');
      if (dash) node.setAttribute('stroke-dasharray', dash.map((d, i) => (round ? (i % 2 ? d * w + w : Math.max(0.01, d * w - w)) : d * w)).join(' '));
    } else {
      node.setAttribute('stroke', 'none');
    }
  }

  // Shape outlines come from shapes.js (OpenPubGeometry); these are the fallbacks for shapes it
  // doesn't know, in the same form.
  function ellipsePath(x, y, w, h) {
    const rx = w / 2, ry = h / 2;
    return `M${x} ${y + ry}A${rx} ${ry} 0 1 1 ${x + w} ${y + ry}A${rx} ${ry} 0 1 1 ${x} ${y + ry}Z`;
  }
  function fallbackGeometry(shape) {
    const w = shape.w, h = shape.h;
    const adj = (i, d) => (shape.adjust && shape.adjust[i] != null ? shape.adjust[i] : d);
    const box = [0, 0, w, h];
    const one = (d, text) => ({ paths: [{ d, fill: true, stroke: true }], text: text || box });
    switch (shape.shape_type) {
      case 3: {
        const ix = w * 0.1464, iy = h * 0.1464;
        return one(ellipsePath(0, 0, w, h), [ix, iy, w - ix, h - iy]);
      }
      case 2: {
        const r = Math.min(w, h) * adj(0, 3600) / 21600, i = r * 0.29289;
        return one(`M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`, [i, i, w - i, h - i]);
      }
      case 4:
        return one(`M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`, [w / 4, h / 4, w * 3 / 4, h * 3 / 4]);
      case 5: {
        const a = w * adj(0, 10800) / 21600;
        return one(`M${a} 0L${w} ${h}L0 ${h}Z`, [a / 2, h / 2, (a + w) / 2, h]);
      }
      case 6:
        return one(`M0 0L${w} ${h}L0 ${h}Z`, [w / 12, h * 7 / 12, w * 7 / 12, h * 11 / 12]);
      case 13: {
        const ax = w * adj(0, 16200) / 21600, ay = h * adj(1, 5400) / 21600;
        return one(`M0 ${ay}L${ax} ${ay}L${ax} 0L${w} ${h / 2}L${ax} ${h}L${ax} ${h - ay}L0 ${h - ay}Z`, [0, ay, ax + (w - ax) * ay / h, h - ay]);
      }
      case 20: case 32:
        return { paths: [{ d: `M0 0L${w} ${h}`, fill: false, stroke: true }], text: box, ends: lineEnds([[0, 0], [w, h]]) };
      case 33:
        return { paths: [{ d: `M0 0H${w}V${h}`, fill: false, stroke: true }], text: box, ends: lineEnds([[0, 0], [w, 0], [w, h]]) };
      case 34: {
        const a = w * adj(0, 10800) / 21600;
        return { paths: [{ d: `M0 0H${a}V${h}H${w}`, fill: false, stroke: true }], text: box, ends: lineEnds([[0, 0], [a, 0], [a, h], [w, h]]) };
      }
      case 37: case 38: {
        const a = w * adj(0, 10800) / 21600;
        return { paths: [{ d: `M0 0C${a} 0 ${a} ${h} ${w} ${h}`, fill: false, stroke: true }], text: box, ends: lineEnds([[0, 0], [a, 0], [a, h], [w, h]]) };
      }
      case 202: case 1: case 75: case 201: case 0:
        return one(`M0 0H${w}V${h}H0Z`);
      default:
        return null;
    }
  }
  /** End points of a polyline and the directions pointing out of it, for arrowheads. */
  function lineEnds(pts) {
    const dir = (a, b) => {
      const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1;
      return { dx: dx / l, dy: dy / l };
    };
    const n = pts.length;
    let i = 1;
    while (i < n - 1 && Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) < 0.01) i++;
    let j = n - 2;
    while (j > 0 && Math.hypot(pts[j][0] - pts[n - 1][0], pts[j][1] - pts[n - 1][1]) < 0.01) j--;
    return {
      start: Object.assign({ x: pts[0][0], y: pts[0][1] }, dir(pts[0], pts[i])),
      end: Object.assign({ x: pts[n - 1][0], y: pts[n - 1][1] }, dir(pts[n - 1], pts[j])),
    };
  }
  function geometryOf(shape) {
    let g = null;
    if (window.OpenPubGeometry) {
      try { g = window.OpenPubGeometry(shape); } catch (e) { g = null; }
    }
    return g || fallbackGeometry(shape) || fallbackGeometry(Object.assign({}, shape, { shape_type: 1 }));
  }

  // Arrowheads (Office styles: 1 triangle, 2 stealth, 3 diamond, 4 oval, 5 open).
  function arrowHead(style, wSize, lSize, lw, end, color) {
    const k = [2, 3, 5];
    const lwB = Math.max(lw, 1);
    const hw = (k[wSize] != null ? k[wSize] : 3) * lwB / 2, len = (k[lSize] != null ? k[lSize] : 3) * lwB;
    const { x, y, dx, dy } = end;
    const px = -dy, py = dx; // perpendicular
    const P = (along, across) => `${x + dx * along + px * across} ${y + dy * along + py * across}`;
    let d, fill = color, stroke = 'none';
    switch (style) {
      case 2: d = `M${P(0, 0)}L${P(-len, hw)}L${P(-len * 0.6, 0)}L${P(-len, -hw)}Z`; break;
      case 3: d = `M${P(len / 2, 0)}L${P(0, hw)}L${P(-len / 2, 0)}L${P(0, -hw)}Z`; break;
      case 4: return svgEl('ellipse', { cx: x, cy: y, rx: Math.max(hw, len / 2), ry: Math.max(hw, len / 2), fill: color });
      case 5: d = `M${P(-len, hw)}L${P(0, 0)}L${P(-len, -hw)}`; fill = 'none'; stroke = color; break;
      default: d = `M${P(0, 0)}L${P(-len, hw)}L${P(-len, -hw)}Z`;
    }
    const node = svgEl('path', { d, fill, stroke });
    if (stroke !== 'none') { node.setAttribute('stroke-width', lw); node.setAttribute('stroke-linejoin', 'miter'); }
    return node;
  }
  /** How far a line should stop short of its end so it doesn't poke through the arrowhead. */
  function arrowInset(style, lSize, lw) {
    const k = [2, 3, 5];
    const len = (k[lSize] != null ? k[lSize] : 3) * Math.max(lw, 1);
    return style === 1 ? len * 0.9 : style === 2 ? len * 0.55 : 0;
  }

  function transformOf(shape, flips) {
    const t = [];
    if (shape.rotation) t.push(`rotate(${shape.rotation}deg)`);
    if (flips && (shape.flip_h || shape.flip_v)) t.push(`scale(${shape.flip_h ? -1 : 1}, ${shape.flip_v ? -1 : 1})`);
    return t.join(' ');
  }

  function shadeColor(hex, k) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m || !k) return hex;
    const n = parseInt(m[1], 16);
    const ch = (v) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('');
  }

  /** Publisher keeps an inset outline inside the edge of closed shapes (seen on rectangles,
   * frames, rounded rectangles and callouts); lines and connectors have no inside. */
  function insetShape(shape) {
    return shape.kind !== 'line' && ![20, 32, 33, 34, 35, 36, 37, 38, 39, 40].includes(shape.shape_type);
  }

  /** Draws one layer (fills or strokes) of a shape's geometry into an SVG element. */
  function drawPaths(svg, shape, geo, layer) {
    const lw = shape.line ? shape.line.width : 0;
    for (const p of geo.paths) {
      if (layer === 'fill' && (p.fill === false || !shape.fill)) continue;
      if (layer === 'stroke' && (p.stroke === false || !shape.line)) continue;
      const node = svgEl('path', { d: p.d });
      if (p.evenodd) node.setAttribute('fill-rule', 'evenodd');
      if (layer === 'fill') {
        paint(node, { fill: p.shade ? Object.assign({}, shape.fill, { color: shadeColor(shape.fill.color, p.shade) }) : shape.fill }, svg);
        svg.appendChild(node);
        continue;
      }
      paint(node, { line: shape.line }, svg);
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke-linejoin', geo.join || 'miter');
      node.setAttribute('stroke-miterlimit', '10');
      const l = shape.line;
      // an inset outline is drawn inside the edge: shrink the path by half the line width
      const inset = l.inset && insetShape(shape) && shape.w > lw && shape.h > lw && p.fill !== false;
      const scaleAbout = (by) => `translate(${by} ${by}) scale(${(shape.w - 2 * by) / shape.w} ${(shape.h - 2 * by) / shape.h})`;
      const compound = l.compound || 0;
      if (compound && p.fill !== false && shape.w > 3 * lw && shape.h > 3 * lw) {
        // double / thick-thin / thin-thick / triple lines: separate strokes inside one band
        const parts = { 1: [[0, 1 / 3], [2 / 3, 1]], 2: [[0, 0.6], [0.8, 1]], 3: [[0, 0.2], [0.4, 1]], 4: [[0, 1 / 6], [5 / 12, 7 / 12], [5 / 6, 1]] }[compound] || [[0, 1]];
        const base = inset ? 0 : -lw / 2;
        for (const [a, b] of parts) {
          const n = node.cloneNode();
          n.setAttribute('stroke-width', (b - a) * lw);
          n.setAttribute('vector-effect', 'non-scaling-stroke');
          n.setAttribute('transform', scaleAbout(base + (a + b) / 2 * lw));
          svg.appendChild(n);
        }
        continue;
      }
      if (inset) {
        node.setAttribute('vector-effect', 'non-scaling-stroke');
        node.setAttribute('transform', scaleAbout(lw / 2));
      }
      svg.appendChild(node);
    }
    if (layer === 'stroke' && shape.line && geo.ends) {
      const l = shape.line;
      for (const [which, style, ws, ls] of [['start', l.start_arrow, l.start_arrow_w, l.start_arrow_l], ['end', l.end_arrow, l.end_arrow_w, l.end_arrow_l]]) {
        if (!style) continue;
        svg.appendChild(arrowHead(style, ws == null ? 1 : ws, ls == null ? 1 : ls, l.width, geo.ends[which], l.color));
      }
    }
  }

  /** Shortens an open path's ends so the line stops under its arrowheads. */
  function trimForArrows(shape, geo) {
    const l = shape.line;
    if (!l || !geo.ends || (!l.start_arrow && !l.end_arrow)) return geo;
    const cut = (e, style, ls) => {
      const by = arrowInset(style, ls == null ? 1 : ls, l.width);
      return by ? { x: e.x - e.dx * by, y: e.y - e.dy * by } : null;
    };
    const s = l.start_arrow ? cut(geo.ends.start, l.start_arrow, l.start_arrow_l) : null;
    const e = l.end_arrow ? cut(geo.ends.end, l.end_arrow, l.end_arrow_l) : null;
    if (!s && !e) return geo;
    const paths = geo.paths.map((p) => {
      if (p.fill !== false) return p;
      let d = p.d;
      // replace the first move-to and the last coordinate pair
      if (s) d = d.replace(/^M\s*[-\d.e]+[ ,]+[-\d.e]+/i, `M${s.x} ${s.y}`);
      if (e) d = d.replace(/([-\d.e]+)[ ,]+([-\d.e]+)\s*$/i, `${e.x} ${e.y}`).replace(/([HV])\s*([-\d.e]+)\s*$/i, (m, cmd) => (cmd.toUpperCase() === 'H' ? `H${e.x}` : `V${e.y}`));
      return Object.assign({}, p, { d });
    });
    return Object.assign({}, geo, { paths });
  }

  function renderShape(shape, ctx, parent) {
    if (shape.kind === 'group') {
      const g = el('div', 'op-shape op-group');
      g.opShape = shape;
      g.style.cssText = 'left:0;top:0;width:0;height:0';
      if (shape.rotation || shape.flip_h || shape.flip_v) {
        g.style.transformOrigin = `${pt(shape.x + shape.w / 2)} ${pt(shape.y + shape.h / 2)}`;
        g.style.transform = transformOf(shape, true);
      }
      for (const c of shape.children || []) renderShape(c, ctx, g);
      parent.appendChild(g);
      return;
    }
    if (shape.kind === 'table') {
      parent.appendChild(renderTable(shape, ctx));
      return;
    }
    // (not 'op-' + kind: 'op-text' is the clipping text body, and a frame's outline reaches
    // outside the frame)
    const d = el('div', 'op-shape op-kind-' + shape.kind);
    d.opShape = shape;
    d.dataset.seq = shape.seq;
    d.style.left = pt(shape.x);
    d.style.top = pt(shape.y);
    d.style.width = pt(shape.w);
    d.style.height = pt(shape.h);
    // a line flipped once is mirrored after it's turned (Publisher), which turns it the other way
    const oneFlip = !!shape.flip_h !== !!shape.flip_v;
    const tr = transformOf(shape.kind === 'line' && oneFlip && shape.rotation ? Object.assign({}, shape, { rotation: -shape.rotation }) : shape, false);
    if (tr) d.style.transform = tr;
    if (shape.shadow) {
      const sh = shape.shadow;
      const c = /^#[0-9a-f]{6}$/i.test(sh.color) ? sh.color : '#808080';
      const a = Math.round(Math.max(0, Math.min(1, sh.opacity == null ? 1 : sh.opacity)) * 255).toString(16).padStart(2, '0');
      d.style.filter = `drop-shadow(${pt(sh.dx)} ${pt(sh.dy)} 0 ${c}${a})`;
    }

    // (an SVG without height isn't painted: give lines at least 1pt)
    const W = Math.max(shape.w, 1), H = Math.max(shape.h, 1);
    const mkSvg = () => {
      const s = svgEl('svg', { class: 'op-svg', width: pt(W), height: pt(H), viewBox: `0 0 ${W} ${H}` });
      if (shape.flip_h || shape.flip_v) s.style.transform = `scale(${shape.flip_h ? -1 : 1}, ${shape.flip_v ? -1 : 1})`;
      return s;
    };
    let geo = geometryOf(shape);
    if (shape.kind === 'line' || geo.paths.every((p) => p.fill === false)) geo = trimForArrows(shape, geo);

    if (shape.wordart) {
      d.appendChild(renderWordArt(shape, mkSvg()));
      parent.appendChild(d);
      return;
    }
    // fill first, then picture, then text, then the outline on top
    if (shape.fill && shape.kind !== 'line') {
      const bg = mkSvg();
      drawPaths(bg, shape, geo, 'fill');
      d.appendChild(bg);
    }
    if (shape.image != null) {
      const pic = el('div', 'op-pic');
      const img = el('img');
      img.src = ctx.imageUrl(shape.image);
      img.draggable = false;
      const c = shape.crop || [0, 0, 0, 0];
      const iw = shape.w / Math.max(0.01, 1 - c[0] - c[2]);
      const ih = shape.h / Math.max(0.01, 1 - c[1] - c[3]);
      // Publisher shows photos as stored, but browsers turn them the way the camera recorded
      // (EXIF orientation, even with image-orientation: none for file: pictures): undo that
      const info = ctx.images && ctx.images[shape.image];
      const orient = (info && info.orientation) || 1;
      const holder = el('div');
      holder.style.cssText = `position:absolute;left:${pt(-c[0] * iw)};top:${pt(-c[1] * ih)};width:${pt(iw)};height:${pt(ih)}`;
      const turned = orient >= 5;
      img.style.width = pt(turned ? ih : iw);
      img.style.height = pt(turned ? iw : ih);
      img.style.left = pt(turned ? (iw - ih) / 2 : 0);
      img.style.top = pt(turned ? (ih - iw) / 2 : 0);
      const turn = { 2: 'scaleX(-1)', 3: 'rotate(180deg)', 4: 'scaleY(-1)', 5: 'rotate(90deg) scaleY(-1)', 6: 'rotate(270deg)', 7: 'rotate(90deg) scaleX(-1)', 8: 'rotate(90deg)' }[orient];
      if (turn) img.style.transform = turn;
      // adjustments made in OpenPub
      const fl = [];
      if (shape.brightness) fl.push(`brightness(${Math.max(0, 1 + shape.brightness / 100)})`);
      if (shape.contrast) fl.push(`contrast(${Math.max(0, 1 + shape.contrast / 100)})`);
      if (shape.gray) fl.push('grayscale(1)');
      if (fl.length) img.style.filter = fl.join(' ');
      // a picture given a shape (ellipse, star...) shows inside its outline
      const outline = ![0, 1, 75, 201, 202].includes(shape.shape_type) && geo.paths.find((p) => p.fill !== false);
      if (outline) {
        const id = 'opc' + (++gradId);
        const defs = svgEl('svg', { class: 'op-svg', width: 0, height: 0 });
        const cp = svgEl('clipPath', { id, clipPathUnits: 'userSpaceOnUse' });
        cp.appendChild(svgEl('path', { d: outline.d, transform: `scale(${96 / 72})` }));
        defs.appendChild(cp);
        d.appendChild(defs);
        pic.style.clipPath = `url(#${id})`;
      }
      holder.appendChild(img);
      if (shape.flip_h || shape.flip_v) pic.style.transform = `scale(${shape.flip_h ? -1 : 1}, ${shape.flip_v ? -1 : 1})`;
      pic.appendChild(holder);
      d.appendChild(pic);
    }
    let area = geo.text;
    if (area && shape.flip_h) area = [shape.w - area[2], area[1], shape.w - area[0], area[3]];
    if (area && shape.flip_v) area = [area[0], shape.h - area[3], area[2], shape.h - area[1]];
    if (shape.border_art && shape.text) {
      // text keeps inside a picture border
      const b = Math.min(shape.border_art.size, shape.w / 3, shape.h / 3);
      const a = area || [0, 0, shape.w, shape.h];
      area = [Math.max(a[0], b), Math.max(a[1], b), Math.min(a[2], shape.w - b), Math.min(a[3], shape.h - b)];
    }
    if (shape.text) d.appendChild(renderTextBody((ctx.chains && ctx.chains.get(shape)) || shape.text, ctx, shape, area));
    if (shape.line) {
      const fg = mkSvg();
      drawPaths(fg, shape, geo, 'stroke');
      d.appendChild(fg);
    }
    if (shape.border_art) d.appendChild(renderBorderArt(shape, ctx));
    parent.appendChild(d);
  }

  /** A picture border: square tiles at the corners and, evenly spaced, along the edges. */
  function renderBorderArt(shape, ctx) {
    const box = el('div', 'op-borderart');
    box.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    const b = shape.border_art, t = b.tiles || [];
    const size = Math.min(b.size, shape.w / 2, shape.h / 2);
    if (!(size >= 1) || t.length !== 8 || t.some((i) => !ctx.images[i])) return box;
    // (Publisher fits the nearest whole number of tiles, squeezing or stretching them a little)
    const nx = Math.min(400, Math.max(2, Math.round(shape.w / size))), ny = Math.min(400, Math.max(2, Math.round(shape.h / size)));
    const put = (tile, x, y, w, h) => {
      const img = el('img');
      img.src = ctx.imageUrl(t[tile]);
      img.draggable = false;
      img.style.cssText = `position:absolute;left:${pt(x)};top:${pt(y)};width:${pt(w || size)};height:${pt(h || size)}`;
      box.appendChild(img);
    };
    const right = shape.w - size, bottom = shape.h - size;
    const ex = (shape.w - 2 * size) / Math.max(1, nx - 2), ey = (shape.h - 2 * size) / Math.max(1, ny - 2);
    for (let i = 0; i < nx - 2; i++) { put(1, size + i * ex, 0, ex + 0.05); put(5, size + i * ex, bottom, ex + 0.05); }
    for (let j = 0; j < ny - 2; j++) { put(7, 0, size + j * ey, 0, ey + 0.05); put(3, right, size + j * ey, 0, ey + 0.05); }
    put(0, 0, 0); put(2, right, 0); put(4, right, bottom); put(6, 0, bottom);
    return box;
  }

  // ---- WordArt -----------------------------------------------------------------------------

  let measureCanvas = null;
  function fontMetrics(font, bold, italic) {
    if (!measureCanvas) measureCanvas = document.createElement('canvas').getContext('2d');
    measureCanvas.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}100px ${fontFamily(font)}`;
    const m = measureCanvas.measureText('Hg');
    const asc = (m.fontBoundingBoxAscent || 90) / 100, desc = (m.fontBoundingBoxDescent || 22) / 100;
    // the ink of capital letters, which WordArt stretches to fill the shape
    const ink = measureCanvas.measureText('HÉgjpÅ');
    return { asc, desc, inkAsc: (ink.actualBoundingBoxAscent || 72) / 100, inkDesc: (ink.actualBoundingBoxDescent || 20) / 100, width: (t) => measureCanvas.measureText(t).width / 100 };
  }

  // Baseline offset (as a fraction of the shape height) and slope along the text, for the
  // common WordArt warps; t runs from 0 to 1 across the text.
  function wordArtWarp(type) {
    const s = (k) => (t) => k * Math.sin(Math.PI * t);
    return {
      144: s(-0.35), 145: s(0.35), // arch up / down
      146: s(-0.35), 147: s(-0.2), // circle, button: approximated as arches
      148: s(-0.25), 149: s(0.25), 150: s(-0.25), 151: s(-0.2),
      152: (t) => -0.25 * t * t, 153: (t) => 0.25 * t * t, // curve up / down
      154: (t) => -0.2 * t, 155: (t) => 0.2 * t, // cascade
      156: (t) => 0.06 * Math.sin(2 * Math.PI * t), 157: (t) => -0.06 * Math.sin(2 * Math.PI * t), // wave 1 / 2
      158: (t) => 0.08 * Math.sin(4 * Math.PI * t), 159: (t) => -0.08 * Math.sin(4 * Math.PI * t), // double wave
      168: (t) => -0.25 * t, 169: (t) => 0.25 * t, // slant up / down
      174: s(-0.15), 175: s(0.15),
    }[type] || null;
  }

  /** WordArt: one font size for every line, lines centred, the block stretched to fill the shape. */
  function renderWordArt(shape, svg) {
    const wa = shape.wordart;
    const lines = String(wa.text || '').replace(/\r\n?/g, '\n').split('\n').filter((l, i, a) => l || a.length === 1);
    const n = Math.max(1, lines.length);
    const W = shape.w, H = shape.h;
    const m = fontMetrics(wa.font, wa.bold, wa.italic);
    const warp = wordArtWarp(shape.shape_type);
    // with a warp, the letters need room to move up and down
    const room = warp ? 0.85 : 1;
    const lineH = H * room / n;
    const size = lineH / Math.max(0.5, m.inkAsc + m.inkDesc * 0.5);
    const widths = lines.map((l) => m.width(l) * size);
    const block = Math.max(1, ...widths);
    const sx = wa.stretch === false ? Math.min(1, W / block) : W / block;
    if (wa.vertical) {
      // stacked letters: along the shape's length, each turned a quarter turn back (the shape
      // itself is turned a quarter turn, so they stand upright) and stretched to its cell
      const band = H / n, ink = m.inkAsc + m.inkDesc * 0.5;
      lines.forEach((line, i) => {
        const chars = [...line];
        if (!chars.length) return;
        const cell = W / chars.length;
        const widest = Math.max(0.2, ...chars.map((ch) => m.width(ch)));
        chars.forEach((ch, j) => {
          if (!ch.trim()) return;
          const t = svgEl('text', { 'text-anchor': 'middle', x: 0, y: (m.inkAsc - ink / 2) * 100, 'font-size': 100 });
          t.setAttribute('font-family', fontFamily(wa.font));
          if (wa.bold) t.setAttribute('font-weight', 'bold');
          if (wa.italic) t.setAttribute('font-style', 'italic');
          t.setAttribute('transform', `translate(${(j + 0.5) * cell} ${(i + 0.5) * band}) rotate(-90) scale(${band * 0.96 / (widest * 100)} ${cell * 0.9 / (ink * 100)})`);
          t.textContent = ch;
          if (shape.fill) paint(t, { fill: shape.fill, line: shape.line }, svg);
          else paint(t, { line: shape.line }, svg);
          if (!shape.fill && !shape.line) t.setAttribute('fill', '#000000');
          if (shape.line) { t.setAttribute('vector-effect', 'non-scaling-stroke'); t.setAttribute('paint-order', 'stroke'); }
          svg.appendChild(t);
        });
      });
      svg.style.overflow = 'visible';
      return svg;
    }
    const g = svgEl('g', { transform: `scale(${sx} 1)` });
    const top = (H - lineH * n) / 2;
    lines.forEach((line, i) => {
      const t = svgEl('text', {});
      t.setAttribute('font-family', fontFamily(wa.font));
      t.setAttribute('font-size', size);
      if (wa.bold) t.setAttribute('font-weight', 'bold');
      if (wa.italic) t.setAttribute('font-style', 'italic');
      t.setAttribute('xml:space', 'preserve');
      const x0 = (block - widths[i]) / 2;
      const base = top + i * lineH + (lineH - (m.inkAsc + m.inkDesc * 0.5) * size) / 2 + m.inkAsc * size;
      if (warp) {
        // place letter by letter along the bent baseline
        let x = x0;
        const xs = [], ys = [], rot = [];
        for (const ch of line) {
          const cw = m.width(ch) * size;
          const mid = (x + cw / 2) / block;
          const y = base + warp(mid) * H;
          const slope = (warp(Math.min(1, mid + 0.01)) - warp(Math.max(0, mid - 0.01))) * H / (0.02 * block * sx);
          xs.push(x); ys.push(y); rot.push(Math.atan(slope) * 180 / Math.PI);
          x += cw;
        }
        t.setAttribute('x', xs.join(' '));
        t.setAttribute('y', ys.join(' '));
        t.setAttribute('rotate', rot.map((r) => r.toFixed(1)).join(' '));
      } else {
        t.setAttribute('x', x0);
        t.setAttribute('y', base);
      }
      t.textContent = line;
      if (shape.fill) paint(t, { fill: shape.fill, line: shape.line }, svg);
      else paint(t, { line: shape.line }, svg);
      if (!shape.fill && !shape.line) t.setAttribute('fill', '#000000');
      // a stroke on stretched text would be stretched too
      if (shape.line) { t.setAttribute('vector-effect', 'non-scaling-stroke'); t.setAttribute('paint-order', 'stroke'); }
      g.appendChild(t);
    });
    // 3-D: copies of the letters behind them, stepping back along the depth, in the side colour
    const ex = wa.extrude;
    if (ex && isFinite(ex.dx) && isFinite(ex.dy) && Math.hypot(ex.dx, ex.dy) > 0.2) {
      const len = Math.min(120, Math.hypot(ex.dx, ex.dy));
      const steps = Math.max(2, Math.min(60, Math.ceil(len / 0.6)));
      const base = /^#[0-9a-f]{6}$/i.test(ex.color || '') ? ex.color : shadeColor(shape.fill && /^#[0-9a-f]{6}$/i.test(shape.fill.color) ? shape.fill.color : '#808080', -0.45);
      const back = svgEl('g', {});
      for (let i = steps; i >= 1; i--) {
        const f = i / steps;
        const layer = svgEl('g', { transform: `translate(${ex.dx * f} ${ex.dy * f})` });
        const copy = g.cloneNode(true);
        // (the far end a little darker, so the sides read as sides)
        const c = shadeColor(base, -0.35 * f);
        for (const t of copy.querySelectorAll('text')) {
          t.setAttribute('fill', c);
          t.removeAttribute('fill-opacity');
          if (i < steps) t.setAttribute('stroke', 'none');
        }
        layer.appendChild(copy);
        back.appendChild(layer);
      }
      svg.appendChild(back);
    }
    svg.appendChild(g);
    svg.style.overflow = 'visible';
    return svg;
  }


  function renderTable(shape, ctx) {
    const t = shape.table;
    const wrap = el('div', 'op-shape op-tablewrap');
    wrap.opShape = shape;
    wrap.dataset.seq = shape.seq;
    wrap.style.left = pt(shape.x);
    wrap.style.top = pt(shape.y);
    wrap.style.width = pt(shape.w);
    wrap.style.height = pt(shape.h);
    if (shape.rotation) wrap.style.transform = `rotate(${shape.rotation}deg)`;
    const table = el('table', 'op-table');
    wrap.appendChild(table);
    table.style.width = pt(t.cols.reduce((a, b) => a + b, 0));
    const cg = el('colgroup');
    for (const w of t.cols) {
      const c = el('col');
      c.style.width = pt(w);
      cg.appendChild(c);
    }
    table.appendChild(cg);
    const rows = t.rows.map((h) => {
      const tr = el('tr');
      tr.style.height = pt(h);
      table.appendChild(tr);
      return tr;
    });
    const taken = new Set();
    const cells = t.cells.slice().sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
    const drawn = [];
    for (const c of cells) {
      if (c.r0 >= rows.length || c.c0 >= t.cols.length || taken.has(c.r0 + ',' + c.c0)) continue;
      const r1 = Math.min(c.r1, rows.length - 1), c1 = Math.min(c.c1, t.cols.length - 1);
      for (let r = c.r0; r <= r1; r++) for (let k = c.c0; k <= c1; k++) taken.add(r + ',' + k);
      const td = el('td');
      td.opCell = c; // the editor finds cells through this
      if (r1 > c.r0) td.rowSpan = r1 - c.r0 + 1;
      if (c1 > c.c0) td.colSpan = c1 - c.c0 + 1;
      // the text starts inside the border: Publisher draws borders centred on the grid lines and
      // keeps the text clear of the inner half (Cymru p43: 2.25pt borders, lines break earlier)
      const bw = (i) => (c.borders[i] ? c.borders[i].width / 2 : 0);
      const m = [c.margins[0] + bw(0), c.margins[1], c.margins[2] + bw(2), c.margins[3]];
      td.style.padding = `${pt(m[1])} ${pt(m[2])} ${pt(m[3])} ${pt(m[0])}`;
      td.style.verticalAlign = c.valign;
      if (c.fill) {
        // (a see-through fill: Cymru p78's cells are 50% pink over the white page)
        const o = c.fill.opacity == null ? 1 : c.fill.opacity;
        td.style.background = o < 1 ? `color-mix(in srgb, ${c.fill.color} ${Math.round(o * 1000) / 10}%, transparent)` : c.fill.color;
      }
      const inner = el('div', 'op-cell');
      let cellW = -m[0] - m[2];
      for (let k = c.c0; k <= c1; k++) cellW += t.cols[k];
      ctx.noHyphen = cellW < 30;
      const cellFlow = renderFlow(c.paras, ctx);
      ctx.noHyphen = false;
      cellFlow.opOwner = c;
      inner.appendChild(cellFlow);
      // the extra line spacing under the last line (see the row heights below)
      const lp = c.paras[c.paras.length - 1];
      const lr = lp && lp.runs.find((r) => !r.object && r.size);
      // Publisher's cell: the last line adds none of its extra line spacing to the row, and the
      // text starts a little lower (about a fifth of the font's line gap) - measured on Cymru p35,
      // Year 7 booklet p11 and p21
      if (lr && !lp.spacing_exact && lp.spacing > 1) inner.style.marginBottom = pt(-(lp.spacing - 1) * lineEm(lr.font, lr.bold, lr.italic) * lr.size);
      const fp = c.paras[0];
      const fr0 = fp && fp.runs.find((r) => !r.object && r.size);
      if (fr0 && FONTS[fr0.font]) inner.style.paddingTop = pt(0.22 * FONTS[fr0.font].gap * fr0.size);
      td.appendChild(inner);
      rows[c.r0].appendChild(td);
      if (c.borders.some((b) => b)) drawn.push({ td, borders: c.borders });
    }
    // grid positions no cell claimed still need a box so the columns line up
    for (let r = 0; r < rows.length; r++) {
      for (let k = 0; k < t.cols.length; k++) {
        if (!taken.has(r + ',' + k)) rows[r].appendChild(el('td'));
      }
    }
    // Borders are drawn over the laid-out cells, centred on the grid lines as Publisher does
    // (rows grow with their text, so positions are only known after layout).
    ctx.after.push(() => {
      const svg = svgEl('svg', { class: 'op-svg' });
      const px = 96 / 72;
      const seen = new Set();
      for (const { td, borders } of drawn) {
        const x0 = td.offsetLeft, y0 = td.offsetTop, x1 = x0 + td.offsetWidth, y1 = y0 + td.offsetHeight;
        const sides = [[x0, y0, x0, y1], [x0, y0, x1, y0], [x1, y0, x1, y1], [x0, y1, x1, y1]];
        for (let i = 0; i < 4; i++) {
          const b = borders[i];
          if (!b) continue;
          const key = sides[i].map((v) => Math.round(v * 4)).join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const [ax, ay, bx, by] = sides[i];
          svg.appendChild(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: b.color, 'stroke-width': b.width * px, 'stroke-linecap': 'square' }));
        }
      }
      wrap.appendChild(svg);
    });
    return wrap;
  }

  // Publisher doesn't show text that doesn't fit its frame: hide paragraphs that start below
  // the bottom of their frame (the frame itself clips the rest).
  function hideOverflow(pg) {
    for (const box of pg.querySelectorAll('.op-text')) {
      const flow = box.firstElementChild;
      if (!flow) continue;
      // (a turned or flipped box is measured unturned)
      const shapeEl = box.closest('.op-shape');
      const turn = shapeEl && shapeEl.style.transform;
      if (turn) shapeEl.style.transform = 'none';
      // the first line always shows; later ones need (most of) their text height inside the frame
      const limit = box.getBoundingClientRect().bottom;
      for (const para of flow.children) {
        if (!para.classList.contains('op-para') || para === flow.querySelector('.op-para')) continue;
        const first = para.querySelector('span');
        const r = first && first.getClientRects()[0];
        if (r && r.top + r.height * 0.95 > limit) para.style.visibility = 'hidden';
      }
      box.opOverflow = textCutOff(box, flow, limit);
      if (turn) shapeEl.style.transform = turn;
    }
  }

  /** Whether words in a text box are hidden because they don't fit: a paragraph left out, or
   * its last line cut off at the bottom. (Not worked out for table cells, or a linked box whose
   * text carries on in the next one.) */
  function textCutOff(box, flow, limit) {
    const el = box.closest('.op-shape');
    const sh = el && el.opShape;
    if (!sh || box.closest('td')) return false;
    if (flow.opOwner && flow.opOwner._range && flow.opOwner._range[1]) return false;
    const words = (n) => /\S/.test(n.textContent.replace(/[\u00AD\u2060]/g, ''));
    for (const para of flow.children) {
      if (!para.classList.contains('op-para') || !words(para)) continue;
      if (para.style.visibility === 'hidden') return true;
      const spans = [...para.querySelectorAll('span')].filter((s) => !s.classList.contains('op-wrap') && words(s));
      const last = spans[spans.length - 1];
      const rs = last ? last.getClientRects() : [];
      const r = rs[rs.length - 1];
      if (r && r.top + r.height * 0.95 > limit) return true;
    }
    return false;
  }

  // ---- pages -------------------------------------------------------------------------------

  /**
   * Renders one page. `opts.imageUrl(index)` gives the URL of a picture; `opts.scale` is the
   * zoom (1 = 100%, i.e. 96 CSS px per inch). Returns the wrapper element (sized in px).
   */
  // ---- linked text frames ----------------------------------------------------------------------

  // A story can flow through a chain of frames (TextBody.chain 0, 1, 2 ...; only frame 0 holds the
  // paragraphs). Each frame shows the text from where the previous one filled up. Positions in a
  // story are { p: paragraph, o: character offset in it }.

  const runLen = (r) => (r.object ? 1 : r.text.length);

  /** Paragraphs from position `from` up to (not including) `to` (null = the end). */
  function sliceStory(paras, from, to) {
    const out = [];
    const end = to || { p: paras.length, o: 0 };
    for (let p = from.p; p < paras.length && (p < end.p || (p === end.p && end.o > 0)); p++) {
      const src = paras[p];
      const a = p === from.p ? from.o : 0;
      const b = p === end.p ? end.o : Infinity;
      const runs = [];
      let pos = 0;
      for (const r of src.runs) {
        const len = runLen(r), s = Math.max(a, pos), e = Math.min(b, pos + len);
        if (e > s || (len === 0 && pos >= a && pos <= b)) runs.push(r.object ? r : Object.assign({}, r, { text: r.text.slice(s - pos, e - pos) }));
        pos += len;
      }
      const para = Object.assign({}, src, { runs: runs.length ? runs : [Object.assign({}, src.runs[0] || {}, { text: '' })] });
      if (a > 0) { para.bullet = null; para.first = 0; para.before = 0; } // a paragraph carried on from the previous frame
      if (b < Infinity) para.after = 0;
      out.push(para);
    }
    return out;
  }

  /** Puts edited paragraphs back into the story in place of the range they were cut from. */
  function spliceStory(paras, from, to, edited) {
    const head = sliceStory(paras, { p: 0, o: 0 }, from);
    const tail = to ? sliceStory(paras, to, null) : [];
    if (from.o > 0 && head.length) {
      // the first edited paragraph continues the last one before it
      const last = head.pop(), first = edited[0];
      edited = [Object.assign({}, paras[from.p], { runs: last.runs.concat(first ? first.runs : []) })].concat(edited.slice(1));
    }
    if (to && to.o > 0 && tail.length) {
      const first = tail.shift(), last = edited.pop();
      const props = paras[to.p];
      edited = edited.concat([Object.assign({}, props, { runs: (last ? last.runs : []).concat(first.runs) })]);
    }
    return head.concat(edited, tail).map((p) => Object.assign({}, p, { runs: p.runs.filter((r, i, a) => r.object || r.text || a.length === 1) }));
  }

  /** Where the text in a rendered frame stops fitting: a story position relative to the paragraphs
   * rendered, or null when everything fits. */
  function overflowPoint(box) {
    const flow = box.querySelector('.op-flow');
    if (!flow) return null;
    const br = box.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(box).paddingBottom) || 0;
    const limit = br.bottom - pad + 0.5;
    const paras = [...flow.children].filter((c) => c.classList.contains('op-para'));
    for (let pi = 0; pi < paras.length; pi++) {
      const para = paras[pi];
      if (para.getBoundingClientRect().bottom <= limit) continue;
      // the first piece of this paragraph whose line runs past the bottom
      const items = [];
      for (const span of para.querySelectorAll('*')) {
        if (span.opOff == null) continue;
        const tn = span.firstChild && span.firstChild.nodeType === 3 && !span.dataset.field ? span.firstChild : null;
        if (tn) {
          let off = span.opOff;
          for (let i = 0; i < tn.data.length; i++) {
            if (tn.data[i] === '­') continue;
            items.push({ node: tn, i, off });
            off++;
          }
        } else items.push({ el: span, off: span.opOff });
      }
      // the bottom of the line a piece sits on
      const px = 96 / 72;
      const bottom = (it) => {
        if (it.el) return it.el.getBoundingClientRect().bottom + (it.el.opBelow || 0) * px;
        const r = document.createRange();
        r.setStart(it.node, it.i);
        r.setEnd(it.node, it.i + 1);
        const rects = r.getClientRects();
        return rects.length ? rects[0].bottom + (it.node.parentNode.opBelow || 0) * px : -Infinity;
      };
      let lo = 0, hi = items.length; // first item that doesn't fit
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bottom(items[mid]) > limit) hi = mid; else lo = mid + 1;
      }
      if (lo >= items.length) continue;
      return { p: pi, o: lo === 0 ? 0 : items[lo].off };
    }
    return null;
  }

  /** Text frames that belong to chains, grouped by story, each list in chain order. */
  function storyChains(doc) {
    const byStory = new Map();
    const walk = (list, page) => {
      for (const s of list) {
        if (s.children) walk(s.children, page);
        if (s.text && s.text.story) {
          if (!byStory.has(s.text.story)) byStory.set(s.text.story, []);
          byStory.get(s.text.story).push({ shape: s, page });
        }
      }
    };
    doc.pages.forEach((pg, i) => walk(pg.shapes, i));
    const out = new Map();
    for (const [id, frames] of byStory) {
      if (frames.length < 2 || !frames.some((f) => f.shape.text.chain)) continue;
      frames.sort((a, b) => (a.shape.text.chain || 0) - (b.shape.text.chain || 0));
      out.set(id, frames);
    }
    return out;
  }

  // views rendered last time, so changes made through them (formatting) reach the story
  let liveViews = [];
  function flushViews() {
    for (const v of liveViews) {
      const now = JSON.stringify(v.paras);
      if (now !== v._orig) v._commit(v.paras);
    }
    liveViews = [];
  }

  /** For each chained frame on page `index`: a stand-in text body showing its part of the story.
   * Writing its `paras` (the editor does) puts the text back into the story. */
  function chainViews(doc, index, base) {
    const views = new Map();
    const chains = storyChains(doc);
    if (!chains.size) return views;
    // an off-screen page (the page's CSS rules apply to what's laid out in it)
    const host = el('div', 'op-page');
    host.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;width:0;height:0;overflow:visible';
    (document.body || document.documentElement).appendChild(host);
    try {
      for (const frames of chains.values()) {
        if (!frames.some((f) => f.page === index)) continue;
        const first = frames[0].shape.text;
        const story = first.paras;
        let from = { p: 0, o: 0 };
        const ranges = [];
        for (let k = 0; k < frames.length; k++) {
          const { shape, page } = frames[k];
          if (k === frames.length - 1) { ranges.push([from, null]); break; }
          // lay this frame's share out off screen to see where it fills up
          const body = Object.assign({}, shape.text, { paras: sliceStory(story, from, null), valign: 'top' });
          // (laid out unscaled, off the page)
          const tctx = Object.assign({}, base, { tabs: [], after: [], wrapFlows: [], editable: false, wraps: computeWraps(doc.pages[page]), pxPerPt: () => 96 / 72 });
          const frame = el('div');
          frame.style.cssText = `position:absolute;left:0;top:0;width:${pt(shape.w)};height:${pt(shape.h)}`;
          const geo = geometryOf(shape);
          const box = renderTextBody(body, tctx, shape, geo.text);
          frame.appendChild(box);
          host.appendChild(frame);
          layoutTabs(tctx);
          snapWraps(tctx.wrapFlows, 96 / 72);
          const cut = overflowPoint(box);
          frame.remove();
          const to = cut ? { p: from.p + cut.p, o: cut.p === 0 ? from.o + cut.o : cut.o } : { p: story.length, o: 0 };
          ranges.push([from, to]);
          from = to;
        }
        frames.forEach(({ shape, page }, k) => {
          if (page !== index) return;
          const [a, b] = ranges[k] || [{ p: story.length, o: 0 }, null];
          let cur = sliceStory(story, a, b);
          const view = Object.assign({}, shape.text);
          Object.defineProperty(view, 'paras', {
            get: () => cur,
            set: (v) => { cur = v; view._commit(v); },
            enumerable: true,
          });
          view._orig = JSON.stringify(cur);
          view._range = [a, b];
          view._commit = (v) => {
            first.paras = spliceStory(first.paras, a, b, JSON.parse(JSON.stringify(v)));
            view._orig = JSON.stringify(v);
          };
          views.set(shape, view);
          liveViews.push(view);
        });
      }
    } finally {
      host.remove();
    }
    return views;
  }

  // ---- text wrapping -------------------------------------------------------------------------

  // Publisher's rule (checked against Publisher itself with tools/makeprobe.ps1): text in a
  // frame keeps clear of every shape in front of it on the same page whose wrapping isn't
  // "none", except shapes that cover the frame's whole text area; master-page items don't push
  // page text.
  // "square" keeps clear of the bounding box, "tight"/"through" of the outline, "topbottom" of
  // the full width. Returns Map(frame shape -> [[x0, y0, x1, y1] relative to the frame]).
  function computeWraps(page) {
    const out = new Map();
    const list = page.shapes;
    const box = (s) => {
      if (!s.rotation || s.kind === 'group') return [s.x, s.y, s.x + s.w, s.y + s.h];
      const a = s.rotation * Math.PI / 180, c = Math.abs(Math.cos(a)), si = Math.abs(Math.sin(a));
      const w = s.w * c + s.h * si, h = s.w * si + s.h * c, cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    };
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f.text) continue;
      const fr = [f.x, f.y, f.x + f.w, f.y + f.h];
      const rects = [];
      // the shapes Publisher found in this frame's way when it saved the file (shapes added in
      // OpenPub, numbered from 1000000, always count)
      const allowed = f.text.wrap_with ? new Set(f.text.wrap_with) : null;
      for (let j = i + 1; j < list.length; j++) {
        const o = list[j];
        const mode = o.wrap || 'square';
        if (mode === 'none' || (o.from_master && !f.from_master)) continue;
        if (allowed && o.seq < 1000000 && !allowed.has(o.seq)) continue;
        const r = box(o);
        // WordArt wrapped tightly: around its letters, not its whole box
        if (o.wordart && (mode === 'tight' || mode === 'through')) { const h = r[3] - r[1]; r[1] += h * 0.2; r[3] -= h * 0.2; }
        if (r[2] <= fr[0] || r[0] >= fr[2] || r[3] <= fr[1] || r[1] >= fr[3]) continue;
        const d = o.wrap_dist || [9, 0, 9, 0];
        // a shape covering the frame's whole text area - but for strips at the sides too narrow
        // for text - doesn't push its text away
        const m = f.text.margins || [0, 0, 0, 0], SIDE = 12;
        if (r[0] - d[0] <= fr[0] + m[0] + SIDE && r[1] - d[1] <= fr[1] + m[1] && r[2] + d[2] >= fr[2] - m[2] - SIDE && r[3] + d[3] >= fr[3] - m[3]) continue;
        const bands = (mode === 'tight' || mode === 'through') && !o.wordart ? outlineBands(o) : null;
        if (bands) {
          for (const b of bands) rects.push([b[0] - d[0] - f.x, b[1] - f.y, b[2] + d[2] - f.x, b[3] - f.y, o.seq]);
          continue;
        }
        // tight and through wrapping keep the distance at the sides only (measured: probe-wrap)
        const close = mode === 'tight' || mode === 'through';
        let w = [r[0] - d[0], close ? r[1] : r[1] - d[1], r[2] + d[2], close ? r[3] : r[3] + d[3]];
        if (mode === 'topbottom') w = [fr[0] - 1, w[1], fr[2] + 1, w[3]];
        rects.push([w[0] - f.x, w[1] - f.y, w[2] - f.x, w[3] - f.y]);
      }
      if (rects.length) out.set(f, rects);
    }
    return out;
  }

  /** The horizontal extent of a shape's outline in thin bands (page coordinates), or null when
   * the outline is its bounding box. */
  function outlineBands(s) {
    if (s.kind !== 'shape' || [1, 0, 75, 201, 202].includes(s.shape_type) || !s.w || !s.h) return null;
    const geo = geometryOf(s);
    const p = geo && geo.paths && geo.paths.find((q) => q.fill !== false);
    if (!p) return null;
    const node = document.createElementNS(SVG, 'path');
    node.setAttribute('d', p.d);
    let len = 0;
    try { len = node.getTotalLength(); } catch (e) { return null; }
    if (!(len > 0)) return null;
    const a = (s.rotation || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const cx = s.w / 2, cy = s.h / 2;
    const step = 3, n = Math.min(4000, Math.ceil(len / 1.5));
    const lo = new Map(), hi = new Map();
    for (let i = 0; i <= n; i++) {
      const q = node.getPointAtLength(len * i / n);
      let x = s.flip_h ? s.w - q.x : q.x, y = s.flip_v ? s.h - q.y : q.y;
      const rx = cx + (x - cx) * cos - (y - cy) * sin, ry = cy + (x - cx) * sin + (y - cy) * cos;
      x = s.x + rx; y = s.y + ry;
      const k = Math.floor(y / step);
      lo.set(k, Math.min(lo.has(k) ? lo.get(k) : Infinity, x));
      hi.set(k, Math.max(hi.has(k) ? hi.get(k) : -Infinity, x));
    }
    const out = [];
    for (const k of [...lo.keys()].sort((a2, b2) => a2 - b2)) out.push([lo.get(k), k * step, hi.get(k), (k + 1) * step]);
    return out;
  }

  function renderPage(doc, index, opts) {
    ensureCss(document);
    const scale = (opts && opts.scale) || 1;
    const page = doc.pages[index];
    FONTS = doc.fonts || {};
    const wrap = el('div', 'op-page-wrap');
    wrap.style.cssText = `position:relative;width:${doc.width * scale * 96 / 72}px;height:${doc.height * scale * 96 / 72}px;overflow:hidden;flex:none`;
    const pg = el('div', 'op-page');
    pg.style.width = pt(doc.width);
    pg.style.height = pt(doc.height);
    pg.style.transformOrigin = '0 0';
    pg.style.transform = `scale(${scale})`;
    wrap.appendChild(pg);
    const ctx = {
      imageUrl: (opts && opts.imageUrl) || ((i) => 'images/' + i),
      pageNumber: page.number,
      tabs: [],
      after: [],
      wrapFlows: [],
      editable: !!(opts && opts.editable),
      images: doc.images || [],
      defaultTab: doc.default_tab > 1 ? doc.default_tab : 36,
      pxPerPt: () => scale * 96 / 72,
    };
    ctx.wraps = computeWraps(page);
    flushViews();
    ctx.chains = chainViews(doc, index, ctx);
    // (only a plain colour: this goes into a style)
    const hex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
    const bf = page.background_fill;
    let back = null;
    if (bf && Number.isInteger(bf.image) && ctx.images[bf.image]) back = `url("${ctx.imageUrl(bf.image)}") center / 100% 100% no-repeat`;
    else if (bf && hex(bf.color) && HEX16.test(bf.pattern || '')) back = patternCss(bf);
    else if (bf && hex(bf.color) && hex(bf.color2)) back = `linear-gradient(${Number(bf.angle) || 0}deg, ${bf.color}, ${bf.color2})`;
    else if (hex(page.background)) back = page.background;
    if (back) {
      const bg = el('div', 'op-pagebg');
      bg.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;background:${back};-webkit-print-color-adjust:exact;print-color-adjust:exact`;
      pg.appendChild(bg);
    }
    for (const s of page.shapes) renderShape(s, ctx, pg);
    // tab stops need real layout: the caller attaches the page, then calls finish()
    pg.lang = 'en-GB';
    wrap.opFinish = () => {
      layoutTabs(ctx);
      snapWraps(ctx.wrapFlows, ctx.pxPerPt());
      ctx.wrapFlows.length = 0;
      hideOverflow(pg);
      for (const f of ctx.after) f();
      ctx.after.length = 0;
    };
    return wrap;
  }

  window.OpenPub = { renderPage, naturalLineHeight, storyChains, sliceStory };
})();
