// Automated check of the editing features (rotation, multi-selection, groups, clipboard, tables,
// paragraphs, text boxes, shape properties, master pages, pages, pictures), run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/edittest.js
// Works on any publication: it adds a page and its own shapes, and uses the document's tables,
// pictures and master items where it has them. Prints "[page] OK ..." / "[page] FAIL ..." lines and a
// SUMMARY line, saves out/edit-<name>.opub and .docx (check them with tools/edittest-verify.js and
// tools/docx-check.ps1) and quits.
const T = OpenPubApp.test;
const out = window.OPENPUB_OUT; // <current directory>/out/, set by the app
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const CM = 72 / 2.54, IND = 72 / 2.54;
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (detail !== undefined && !cond ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
};
const section = async (name, fn) => {
  log('--- ' + name);
  try { if (typeof refresh === 'function') refresh(); await fn(); } catch (e) { failN++; log('FAIL ' + name + ' threw ' + e + ' ' + String(e.stack || '').split('\n').slice(0, 4).join(' | ')); }
};
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const doc = () => T.doc();
const S = () => T.state();
const selShapes = () => (S().sel ? S().sel.shapes : []);
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const rect = (el) => el.getBoundingClientRect();
const centre = (el) => { const r = rect(el); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const pe = (target, type, x, y, opts = {}) => target.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true }, opts)));
const click = (el, opts = {}, at) => { const c = at || centre(el); pe(el, 'pointerdown', c.x, c.y, opts); pe(pagesEl, 'pointerup', c.x, c.y, opts); };
function drag(target, from, to, opts = {}, steps = 4) {
  // (Alt: the shapes go exactly where dragged, without lining up with the page or other shapes)
  opts = Object.assign({ altKey: true }, opts);
  pe(target, 'pointerdown', from.x, from.y, opts);
  for (let i = 1; i <= steps; i++) pe(pagesEl, 'pointermove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, opts);
  pe(pagesEl, 'pointerup', to.x, to.y, opts);
}
const key = (k, opts = {}) => $('view').dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
const kpx = (page) => rect(T.sheets()[page].el).width / doc().width; // screen px per point
const toScreen = (page, p) => { const r = rect(T.sheets()[page].el); const f = kpx(page); return { x: r.left + p.x * f, y: r.top + p.y * f }; };
const el = (page, s) => T.shapeEl(page, s);
const own = (page) => doc().pages[page].shapes.filter((s) => !s.from_master);
const cellAt = (t, r, c) => t.cells.find((x) => x.r0 <= r && x.r1 >= r && x.c0 <= c && x.c1 >= c);
const tdOf = (page, sh, cell) => [...el(page, sh).querySelectorAll('td')].find((td) => td.opCell === cell);
/** Every grid position is covered by exactly one cell, and the frame matches the grid. */
function gridOK(sh) {
  const t = sh.table, seen = new Map();
  for (const c of t.cells) {
    if (c.r0 > c.r1 || c.c0 > c.c1 || c.r1 >= t.rows.length || c.c1 >= t.cols.length || c.r0 < 0 || c.c0 < 0) return 'bad cell ' + JSON.stringify([c.r0, c.r1, c.c0, c.c1]);
    for (let r = c.r0; r <= c.r1; r++) for (let q = c.c0; q <= c.c1; q++) {
      if (seen.has(r + ',' + q)) return 'overlap at ' + r + ',' + q;
      seen.set(r + ',' + q, c);
    }
  }
  if (seen.size !== t.rows.length * t.cols.length) return 'holes: ' + seen.size + ' of ' + t.rows.length * t.cols.length;
  if (!near(sh.w, t.cols.reduce((a, b) => a + b, 0), 0.01) || !near(sh.h, t.rows.reduce((a, b) => a + b, 0), 0.01)) return 'frame != grid';
  return '';
}
function typeInto(page, shape, owner, text, at) {
  const flow = [...el(page, shape).querySelectorAll('.op-flow')].find((f) => f.opOwner === owner);
  T.startEdit(page, shape, flow, null, at || { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
  document.execCommand('insertText', false, text);
  T.commitEdit();
}
function newTextBox(text, x, y, w, h) {
  T.addText();
  document.execCommand('insertText', false, text);
  T.commitEdit();
  const s = S().sel.shape;
  if (x != null) { T.setGeom('x', x); T.setGeom('y', y); T.setGeom('w', w); T.setGeom('h', h); }
  return s;
}
function shapeAt(page, s, opts) { click(el(page, s), opts); }
/** The current object for a shape (undo replaces a page's objects with copies). */
function fresh(s) {
  if (!s) return s;
  let hit = null;
  const walk = (x) => { if (!hit && x.seq === s.seq) hit = x; (x.children || []).forEach(walk); };
  doc().pages.forEach((pg) => pg.shapes.forEach(walk));
  return hit || s;
}
const refresh = () => { A = fresh(A); B = fresh(B); C = fresh(C); D = fresh(D); };
/** Adds paragraphs at the end of a text body by typing Enter and the text. */
function addParas(page, shape, owner, lines) {
  const flow = [...el(page, shape).querySelectorAll('.op-flow')].find((f) => f.opOwner === owner);
  T.startEdit(page, shape, flow, null, { a: { p: 1e6, o: 1e9 }, b: { p: 1e6, o: 1e9 } });
  for (const l of lines) {
    document.execCommand('insertParagraph');
    document.execCommand('insertText', false, l);
  }
  T.commitEdit();
}

T.quiet(true);
const name = String(doc().name || 'doc').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-');
log('edittest on ' + doc().name + ': ' + doc().pages.length + ' pages');
$('zoom').value = 'fit-page';
$('zoom').dispatchEvent(new Event('change'));
await wait(400);

// a fresh page to work on, after the first one (it gets the first page's master items)
T.goTo(0);
await wait(300);
T.addPage();
await wait(600);
const P = S().current;
let A, B, C, D;

await section('ribbon', async () => {
  check('Home tab is shown first', S().tab === 'home' && !$('p-home').hidden);
  T.showTab('insert');
  check('Insert tab switches panels', !$('p-insert').hidden && $('p-home').hidden);
  $('t-page').click();
  check('Page tab by click', S().tab === 'page' && !$('p-page').hidden);
  check('contextual tabs hidden with nothing selected', $('t-shape').hidden && $('t-table').hidden && $('t-picture').hidden && $('t-textbox').hidden);
  T.showTab('home');
});

await section('shape properties', async () => {
  A = newTextBox('ET-ROT rotated box', 80, 110, 130, 70);
  check('exact X/Y/W/H (points)', near(A.x, 80) && near(A.y, 110) && near(A.w, 130) && near(A.h, 70), { x: A.x, y: A.y, w: A.w, h: A.h });
  check('Shape Format and Text Box tabs appear', !$('t-shape').hidden && !$('t-textbox').hidden);
  $('gx').value = '3';
  $('gx').dispatchEvent(new Event('change'));
  check('X field in cm', near(A.x, 3 * CM), A.x);
  $('gw').value = '50 mm';
  $('gw').dispatchEvent(new Event('change'));
  check('W field accepts mm', near(A.w, 5 * CM), A.w);
  T.setGeom('x', 80);
  T.setGeom('w', 130);
  T.setFill('#ddeeff');
  T.setTransparency(40);
  check('fill transparency', A.fill && near(A.fill.opacity, 0.6, 0.001), A.fill);
  T.setLine({ color: '#004488', width: 1.5 });
  T.setLine({ dash: 6 });
  check('outline dash style', A.line && A.line.dash === 6 && A.line.width === 1.5, A.line);
  $('dash').value = '8';
  $('dash').dispatchEvent(new Event('change'));
  check('dash from the ribbon', A.line.dash === 8, A.line);
});

await section('rotation', async () => {
  T.select(P, A);
  await wait(50);
  const box = document.querySelector('.selbox');
  const rot = box && box.querySelector('.h.rot');
  check('rotate handle shown', !!rot);
  const c = centre(box), rr = rect(rot), th = 47 * Math.PI / 180, R = 120;
  drag(rot, { x: rr.left + 6, y: rr.top + 6 }, { x: c.x + R * Math.sin(th), y: c.y - R * Math.cos(th) }, { shiftKey: true });
  check('drag the rotate handle (Shift snaps to 15°)', A.rotation === 45, A.rotation);
  drag(document.querySelector('.selbox .h.rot'), { x: c.x, y: c.y - 60 }, { x: c.x + R * Math.sin(th), y: c.y - R * Math.cos(th) });
  check('drag without Shift is free', near(A.rotation, 47, 1.5), A.rotation);
  // resizing a rotated shape keeps the opposite edge in place
  T.setRotation(45);
  const a = 45 * Math.PI / 180;
  const leftMid = (s) => ({ x: s.x + s.w / 2 - Math.cos(a) * s.w / 2, y: s.y + s.h / 2 - Math.sin(a) * s.w / 2 });
  const l0 = leftMid(A), w0 = A.w;
  await wait(50);
  const he = document.querySelector('.selbox .h.e'), hc = centre(he);
  drag(he, hc, { x: hc.x + 30, y: hc.y + 30 });
  const l1 = leftMid(A);
  check('resize a rotated shape along its own axis', A.w > w0 + 20 && near(l0.x, l1.x) && near(l0.y, l1.y), { w0, w: A.w, l0, l1 });
  T.setRotation(30);
  check('numeric rotation', A.rotation === 30, A.rotation);
  T.rotateBy(90);
  check('rotate right 90°', A.rotation === 120, A.rotation);
  T.rotateBy(-90);
  $('grot').value = '30';
  $('grot').dispatchEvent(new Event('change'));
  check('rotation field', A.rotation === 30, A.rotation);
  T.setGeom('w', 130);
  check('rotation survives a redraw', (el(P, A).style.transform || '').includes('rotate(30deg)'), el(P, A).style.transform);
});

await section('multi-selection', async () => {
  T.addBasic(1); B = S().sel.shape;
  T.setGeom('x', 360); T.setGeom('y', 120); T.setGeom('w', 80); T.setGeom('h', 60);
  T.addBasic(3); C = S().sel.shape;
  T.setGeom('x', 380); T.setGeom('y', 240); T.setGeom('w', 80); T.setGeom('h', 60);
  T.addBasic(1); D = S().sel.shape;
  T.setGeom('x', 60); T.setGeom('y', 330); T.setGeom('w', 60); T.setGeom('h', 40);
  T.select(0, null);
  await wait(50);
  // rubber band around B and C only
  const s0 = toScreen(P, { x: 350, y: 105 }), s1 = toScreen(P, { x: 480, y: 315 });
  const start = document.elementFromPoint(s0.x, s0.y);
  drag(start, s0, s1);
  check('rubber band selects the shapes inside it', selShapes().length === 2 && selShapes().includes(B) && selShapes().includes(C), selShapes().map((s) => s.seq));
  check('multi-selection shows one box each plus the outline', document.querySelectorAll('.selbox.multi').length === 2 && document.querySelectorAll('.selbox.union').length === 1);
  shapeAt(P, D, { shiftKey: true });
  check('Shift+click adds', selShapes().length === 3 && selShapes().includes(D));
  shapeAt(P, D, { ctrlKey: true });
  check('Ctrl+click removes', selShapes().length === 2 && !selShapes().includes(D));
  const bx = B.x, cx = C.x, by = B.y, cy = C.y;
  key('ArrowRight');
  key('ArrowDown', { shiftKey: true });
  check('arrow keys move the whole selection', near(B.x, bx + 1, 0.01) && near(C.x, cx + 1, 0.01) && near(B.y, by + 10, 0.01) && near(C.y, cy + 10, 0.01), { bx: B.x, cx: C.x, by: B.y, cy: C.y });
  await wait(30);
  const f = kpx(P), b0 = { x: B.x, y: B.y }, c0 = { x: C.x, y: C.y };
  const bc = centre(el(P, B));
  drag(el(P, B), bc, { x: bc.x + 40, y: bc.y + 20 });
  check('dragging one moves all selected', near(B.x - b0.x, 40 / f) && near(C.x - c0.x, 40 / f) && near(C.y - c0.y, 20 / f) && selShapes().length === 2, { dB: B.x - b0.x, dC: C.x - c0.x, n: selShapes().length });
  T.setFill('#ff0000');
  check('fill applies to all selected', B.fill.color === '#ff0000' && C.fill.color === '#ff0000');
  T.setLine({ color: '#00aa00' });
  check('outline applies to all selected', B.line.color === '#00aa00' && C.line.color === '#00aa00');
  T.setTransparency(25);
  check('transparency applies to all selected', near(B.fill.opacity, 0.75, 0.001) && near(C.fill.opacity, 0.75, 0.001));
  // restack
  T.reorder(false);
  const sh = doc().pages[P].shapes, firstOwn = sh.findIndex((s) => !s.from_master);
  check('send to back keeps the selection together above the master items', sh.indexOf(B) === firstOwn && sh.indexOf(C) === firstOwn + 1, { b: sh.indexOf(B), c: sh.indexOf(C), firstOwn });
  T.reorder(true);
  check('bring to front', sh.indexOf(B) === sh.length - 2 && sh.indexOf(C) === sh.length - 1);
  // duplicate + delete
  const n0 = own(P).length;
  T.duplicate();
  const copies = selShapes();
  check('duplicate copies every selected shape with new ids', own(P).length === n0 + 2 && copies.length === 2 && !copies.includes(B) && copies.every((s) => s.seq !== B.seq && s.seq !== C.seq));
  T.removeSelected();
  check('delete removes every selected shape', own(P).length === n0 && !S().sel);
  // text formatting on two text boxes
  const E = newTextBox('ET-M1', 60, 420, 120, 40), F = newTextBox('ET-M2', 200, 420, 120, 40);
  T.selectMany(P, [E, F]);
  T.format({ bold: true });
  T.format({ size: 15 });
  check('text formatting applies to all selected', [E, F].every((s) => s.text.paras[0].runs.every((r) => r.bold && r.size === 15)));
  T.format({ align: 'center' });
  check('paragraph formatting applies to all selected', [E, F].every((s) => s.text.paras[0].align === 'center'));
  // Ctrl+A
  key('a', { ctrlKey: true });
  check('Ctrl+A selects all of the page\'s own shapes', selShapes().length === own(P).length);
  T.select(0, null);
});

await section('group / ungroup', async () => {
  T.selectMany(P, [B, C]);
  const n0 = own(P).length;
  const u = { x0: Math.min(B.x, C.x), y0: Math.min(B.y, C.y), x1: Math.max(B.x + B.w, C.x + C.w), y1: Math.max(B.y + B.h, C.y + C.h) };
  T.groupSel();
  let G = S().sel.shape;
  check('group', G.kind === 'group' && G.children.length === 2 && G.children.includes(B) && own(P).length === n0 - 1, { kind: G.kind });
  check('group frame encloses its members', near(G.x, u.x0) && near(G.y, u.y0) && near(G.x + G.w, u.x1) && near(G.y + G.h, u.y1));
  check('group shows resize and rotate handles', !!document.querySelector('.selbox .h.se') && !!document.querySelector('.selbox .h.rot'));
  key('g', { ctrlKey: true, shiftKey: true });
  check('Ctrl+Shift+G ungroups', selShapes().length === 2 && own(P).includes(B) && own(P).includes(C));
  key('g', { ctrlKey: true });
  G = S().sel.shape;
  check('Ctrl+G groups', G.kind === 'group' && own(P).length === n0 - 1);
  const bx = B.x;
  T.nudge(5, 0);
  check('moving a group moves its members', near(B.x, bx + 5, 0.01));
  const bw = B.w, cw = C.w, gx = G.x, bOff = B.x - G.x;
  T.setGeom('w', G.w * 2);
  check('resizing a group scales its members', near(B.w, bw * 2) && near(C.w, cw * 2) && near(G.x, gx) && near(B.x + B.w / 2 - G.x, (bOff + bw / 2) * 2), { bw: B.w, cw: C.w });
  T.setGeom('w', G.w / 2);
  // drag a group's corner handle
  await wait(30);
  const h = document.querySelector('.selbox .h.se'), hc = centre(h), gw = G.w;
  drag(h, hc, { x: hc.x + 30, y: hc.y + 15 });
  check('group resize handle', G.w > gw + 10 && near(B.w / bw, G.w / gw, 0.05), { gw, w: G.w });
  // rotate the group, then ungroup: members keep their place on the page
  T.setGeom('w', gw);
  T.setRotation(90);
  const gcx = G.x + G.w / 2, gcy = G.y + G.h / 2;
  const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  T.ungroupSel();
  const want = { x: gcx - (bcy - gcy), y: gcy + (bcx - gcx) };
  check('ungrouping a rotated group keeps members in place', near(B.x + B.w / 2, want.x) && near(B.y + B.h / 2, want.y) && B.rotation === 90, { got: [B.x + B.w / 2, B.y + B.h / 2, B.rotation], want });
  T.undo();
  T.undo();
  G = doc().pages[P].shapes.find((s) => s.kind === 'group');
  check('undo brings the group back', !!G && G.children.length === 2);
  if (G) {
    T.select(P, G);
    T.ungroupSel();
  }
  // a lasting group for the saved file
  const g1 = newTextBox('ET-G1', 60, 500, 110, 40), g2 = newTextBox('ET-G2', 200, 520, 110, 40);
  T.selectMany(P, [g1, g2]);
  T.groupSel();
});

await section('clipboard', async () => {
  T.select(P, A);
  const n0 = own(P).length;
  T.copySel(false);
  T.pasteClip();
  const copy = S().sel.shape;
  check('copy + paste on the same page', own(P).length === n0 + 1 && copy !== A && copy.seq !== A.seq && near(copy.x, A.x + 12) && textOf(copy.text) === textOf(A.text), { seq: copy.seq, x: copy.x });
  $('paste').click();
  check('the Paste button pastes again, offset again', near(S().sel.shape.x, A.x + 24));
  // other page
  T.goTo(0);
  await wait(300);
  const m0 = doc().pages[0].shapes.length;
  T.pasteClip();
  const there = S().sel;
  check('paste onto another page', there.page === 0 && doc().pages[0].shapes.length === m0 + 1 && near(there.shape.x, A.x), { page: there.page });
  T.undo();
  check('undo the paste', doc().pages[0].shapes.length === m0);
  T.goTo(P);
  await wait(300);
  // cut
  T.select(P, copy);
  T.copySel(true);
  check('cut removes the shape', !doc().pages[P].shapes.includes(copy) && !S().sel);
  T.pasteClip();
  check('paste after cut puts it back in place', near(S().sel.shape.x, copy.x) && S().sel.shape.seq !== copy.seq);
  T.removeSelected();
  T.select(P, doc().pages[P].shapes.find((s) => s.seq !== A.seq && !s.from_master && s.text && textOf(s.text).startsWith('ET-ROT')));
  T.removeSelected();
  // keyboard
  T.select(P, D);
  const n1 = own(P).length;
  key('c', { ctrlKey: true });
  key('v', { ctrlKey: true });
  await wait(400);
  check('Ctrl+C / Ctrl+V', own(P).length === n1 + 1 && S().sel.shape !== D);
  key('x', { ctrlKey: true });
  check('Ctrl+X', own(P).length === n1);
  // text from another program
  window.dispatchEvent(new Event('blur'));
  T.select(0, null);
  T.handlePaste('Pasted line one\nPasted line two');
  const tb = S().sel && S().sel.shape;
  check('pasting text makes a text box', tb && tb.kind === 'text' && tb.text.paras.length === 2 && textOf(tb.text) === 'Pasted line one\nPasted line two');
  if (tb) T.removeSelected();
});

let TB;
await section('tables', async () => {
  T.goTo(P);
  await wait(200);
  // Insert > Table: the drop-down asks for rows and columns
  $('addtable').click();
  check('table drop-down opens', !$('tblpop').hidden);
  $('tblrows').value = '3';
  $('tblcols').value = '3';
  $('tblinsert').click();
  TB = S().sel.shape;
  check('table drop-down closes', $('tblpop').hidden);
  T.setGeom('x', 250);
  T.setGeom('y', 580);
  check('insert table', TB.kind === 'table' && TB.table.rows.length === 3 && TB.table.cols.length === 3 && gridOK(TB) === '', gridOK(TB));
  check('Table tab shown and active', !$('t-table').hidden && S().tab === 'table');
  await wait(50);
  // type into a cell with a double-click
  let td = tdOf(P, TB, cellAt(TB.table, 0, 0));
  const tc = centre(td);
  td.querySelector('.op-flow').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: tc.x, clientY: tc.y }));
  check('double-click edits cell text', S().editing);
  document.execCommand('insertText', false, 'ET-TABLE');
  T.commitEdit();
  check('cell text typed', textOf(cellAt(TB.table, 0, 0)).startsWith('ET-TABLE'), textOf(cellAt(TB.table, 0, 0)));
  // click a cell of the selected table
  click(tdOf(P, TB, cellAt(TB.table, 1, 1)));
  let cs = S().cellSel;
  check('click selects a cell', cs && cs.r0 === 1 && cs.c0 === 1 && cs.r1 === 1 && cs.c1 === 1, cs && [cs.r0, cs.c0, cs.r1, cs.c1]);
  check('selected cells are highlighted', document.querySelectorAll('.selbox .cell').length === 1);
  // drag across cells
  const a = centre(tdOf(P, TB, cellAt(TB.table, 0, 0))), b = centre(tdOf(P, TB, cellAt(TB.table, 1, 2)));
  drag(tdOf(P, TB, cellAt(TB.table, 0, 0)), a, b);
  cs = S().cellSel;
  check('drag selects a range of cells', cs && cs.r0 === 0 && cs.c0 === 0 && cs.r1 === 1 && cs.c1 === 2, cs && [cs.r0, cs.c0, cs.r1, cs.c1]);
  click(tdOf(P, TB, cellAt(TB.table, 2, 2)), { shiftKey: true });
  cs = S().cellSel;
  check('Shift+click extends the range', cs && cs.r1 === 2 && cs.c1 === 2 && document.querySelectorAll('.selbox .cell').length === 9);
  // rows and columns
  T.selectCells(1, 1);
  T.insertRows(true);
  check('insert row below', TB.table.rows.length === 4 && TB.table.cells.length === 12 && gridOK(TB) === '' && S().cellSel.r0 === 1, gridOK(TB));
  T.insertRows(false);
  check('insert row above (selection follows its cells)', TB.table.rows.length === 5 && gridOK(TB) === '' && S().cellSel.r0 === 2 && textOf(cellAt(TB.table, 0, 0)).startsWith('ET-TABLE'));
  T.insertCols(true);
  check('insert column right', TB.table.cols.length === 4 && gridOK(TB) === '', gridOK(TB));
  T.insertCols(false);
  check('insert column left', TB.table.cols.length === 5 && gridOK(TB) === '' && S().cellSel.c0 === 2);
  const w0 = TB.w;
  T.deleteRows();
  check('delete row', TB.table.rows.length === 4 && gridOK(TB) === '', gridOK(TB));
  T.selectCells(0, 4);
  T.deleteCols();
  check('delete column (table narrows)', TB.table.cols.length === 4 && TB.w < w0 && gridOK(TB) === '', gridOK(TB));
  // merge and split
  T.selectCells(1, 1, 2, 2);
  T.mergeCells();
  let m = cellAt(TB.table, 1, 1);
  check('merge cells', m.r1 === 2 && m.c1 === 2 && TB.table.cells.length === 13 && gridOK(TB) === '', gridOK(TB));
  T.selectCells(1, 1);
  T.splitCells();
  check('split a merged cell', TB.table.cells.length === 16 && gridOK(TB) === '', gridOK(TB));
  T.selectCells(3, 0, 3, 1);
  T.mergeCells();
  check('merge across a row', cellAt(TB.table, 3, 0).c1 === 1 && gridOK(TB) === '');
  // fill, alignment, borders
  T.selectCells(0, 0, 0, 3);
  T.setCellFill('#ffee00');
  check('cell fill', [0, 1, 2, 3].every((c) => cellAt(TB.table, 0, c).fill && cellAt(TB.table, 0, c).fill.color === '#ffee00') && !cellAt(TB.table, 1, 0).fill);
  T.setCellVAlign('middle');
  check('cell vertical alignment', cellAt(TB.table, 0, 2).valign === 'middle' && cellAt(TB.table, 1, 2).valign !== 'middle');
  T.selectCells(1, 1);
  T.setBorders('none');
  const c11 = cellAt(TB.table, 1, 1);
  check('no borders (also on the neighbours\' shared edges)', c11.borders.every((x) => !x) && !cellAt(TB.table, 1, 0).borders[2] && !cellAt(TB.table, 0, 1).borders[3] && !cellAt(TB.table, 1, 2).borders[0] && !cellAt(TB.table, 2, 1).borders[1]);
  $('bwidth').value = '2.25';
  $('bwidth').dispatchEvent(new Event('change'));
  T.setBorders('all');
  check('all borders with the pen width', c11.borders.every((x) => x && x.width === 2.25) && cellAt(TB.table, 1, 0).borders[2].width === 2.25);
  T.setPen({ color: '#ff0000' });
  check('border colour restyles the selected borders', c11.borders.every((x) => x.color === '#ff0000') && cellAt(TB.table, 0, 1).borders[3].color === '#ff0000');
  T.selectCells(1, 2, 2, 3);
  T.setPen({ width: 1 });
  T.setBorders('none');
  T.setBorders('outside');
  const c12 = cellAt(TB.table, 1, 2), c22 = cellAt(TB.table, 2, 3);
  check('outside borders', c12.borders[0] && c12.borders[1] && !c12.borders[2] && !c12.borders[3] && c22.borders[2] && c22.borders[3] && !c22.borders[0]);
  T.setBorders('inside');
  check('inside borders', c12.borders[2] && c12.borders[3]);
  // drag a column line and a row line
  T.select(0, null);
  T.select(P, TB);
  await wait(50);
  const f = kpx(P), tr = rect(el(P, TB)), col0 = TB.table.cols[0];
  const lineAt = { x: tr.left + col0 * f, y: tr.top + 8 };
  drag(document.elementFromPoint(lineAt.x + 1, lineAt.y), { x: lineAt.x + 1, y: lineAt.y }, { x: lineAt.x + 31, y: lineAt.y });
  check('drag a column line', near(TB.table.cols[0], col0 + 30 / f, 1) && gridOK(TB) === '', { before: col0, after: TB.table.cols[0] });
  await wait(30);
  const ys = T.rowEdges(P, TB), tr2 = rect(el(P, TB)), row0 = ys[1] - ys[0];
  const rowAt = { x: tr2.left + 10, y: tr2.top + ys[1] * f };
  drag(document.elementFromPoint(rowAt.x, rowAt.y - 1), { x: rowAt.x, y: rowAt.y - 1 }, { x: rowAt.x, y: rowAt.y + 24 });
  check('drag a row line', near(TB.table.rows[0], row0 + 25 / f, 1.5) && gridOK(TB) === '', { before: row0, after: TB.table.rows[0] });
  // move the table by its grip
  const grip = document.querySelector('.selbox .h.grip'), gc = centre(grip), tx = TB.x;
  drag(grip, gc, { x: gc.x - 20, y: gc.y });
  check('move a table by its grip', near(TB.x, tx - 20 / f, 0.5), { tx, x: TB.x });
  // clear and undo
  T.selectCells(0, 0);
  T.clearCells();
  check('Delete clears the selected cells', textOf(cellAt(TB.table, 0, 0)) === '');
  T.undo();
  TB = doc().pages[P].shapes.find((s) => s.kind === 'table' && textOf(cellAt(s.table, 0, 0)).startsWith('ET-TABLE'));
  check('undo restores cell text', !!TB);
  // cell text formatting applies to the selected cells only
  T.select(P, TB);
  T.selectCells(1, 0);
  T.format({ italic: true });
  check('formatting the selected cells', cellAt(TB.table, 1, 0).paras[0].runs[0].italic && !cellAt(TB.table, 0, 0).paras[0].runs[0].italic);
  // resize the whole table by its handle
  const se = document.querySelector('.selbox .h.se'), sc = centre(se), wB = TB.w;
  drag(se, sc, { x: sc.x + 20, y: sc.y });
  check('resizing a table scales its columns', TB.w > wB + 5 && gridOK(TB) === '', { wB, w: TB.w });
  // tables of the publication itself
  let found = null;
  doc().pages.forEach((pg, i) => pg.shapes.forEach((s) => { if (!found && s.kind === 'table' && !s.from_master && i !== P && s.table.cells.some((c) => c.r1 > c.r0 || c.c1 > c.c0)) found = { i, s }; }));
  if (!found) doc().pages.forEach((pg, i) => pg.shapes.forEach((s) => { if (!found && s.kind === 'table' && !s.from_master && i !== P) found = { i, s }; }));
  if (found) {
    const { i, s } = found;
    T.goTo(i);
    await wait(500);
    T.select(i, s);
    const merged = s.table.cells.find((c) => c.r1 > c.r0 || c.c1 > c.c0) || s.table.cells[0];
    T.selectCells(merged.r0, merged.c0);
    const before = gridOK(s);
    T.insertRows(true);
    T.insertCols(false);
    check('insert row/column in a table of the publication', gridOK(s) === before, gridOK(s));
    T.selectCells(merged.r0, merged.c0 + 1);
    T.splitCells();
    T.selectCells(0, 0, Math.min(1, s.table.rows.length - 1), Math.min(1, s.table.cols.length - 1));
    T.mergeCells();
    check('split and merge in a table of the publication', gridOK(s) === before, gridOK(s));
    T.undo(); T.undo(); T.undo(); T.undo();
    T.goTo(P);
    await wait(400);
  } else log('note: the publication has no tables of its own');
});

let L, N;
await section('paragraphs', async () => {
  T.goTo(P);
  await wait(200);
  L = newTextBox('ET-LIST one', 300, 300, 200, 110);
  addParas(P, L, L.text, ['ET-LIST two', 'ET-LIST three']);
  check('three paragraphs', L.text.paras.length === 3, L.text.paras.length);
  T.select(P, L);
  T.setBullet('✓');
  check('bullets on every paragraph', L.text.paras.every((p) => p.bullet && p.bullet.text === '✓' && near(p.left, IND, 0.01) && near(p.first, -IND, 0.01)), L.text.paras.map((p) => [p.bullet, p.left, p.first]));
  const labels = () => [...el(P, L).querySelectorAll('.op-bullet')].map((b) => b.textContent);
  check('bullets drawn', labels().join() === '✓,✓,✓', labels());
  document.querySelector('[data-bullet="➢"]').click();
  check('bullet character from the menu', L.text.paras.every((p) => p.bullet.text === '➢' && near(p.left, IND, 0.01)));
  T.toggleBullets();
  check('bullets off', L.text.paras.every((p) => !p.bullet && near(p.left, 0, 0.01) && near(p.first, 0, 0.01)), L.text.paras.map((p) => [p.left, p.first]));
  T.setNumbering(2);
  check('numbering a. b. c.', labels().join() === 'a.,b.,c.', labels());
  T.setNumbering(0, 5);
  check('numbering starting at 5', labels().join() === '5.,6.,7.' && L.text.paras[0].bullet.start === 5 && L.text.paras[1].bullet.start == null, labels());
  T.clearList();
  T.indent(1);
  check('increase indent', L.text.paras.every((p) => near(p.left, IND, 0.01)));
  T.indent(1);
  T.indent(-1);
  check('decrease indent', L.text.paras.every((p) => near(p.left, IND, 0.01)));
  T.indent(-1);
  T.setSpacing(1.5);
  check('line spacing 1.5', L.text.paras.every((p) => p.spacing === 1.5 && !p.spacing_exact));
  T.setSpacing(18, true);
  check('exact line spacing', L.text.paras.every((p) => p.spacing === 18 && p.spacing_exact === true));
  document.querySelector('[data-spacing="1.15"]').click();
  check('line spacing from the menu', L.text.paras.every((p) => p.spacing === 1.15 && !p.spacing_exact));
  $('spbefore').value = '6';
  $('spbefore').dispatchEvent(new Event('change'));
  T.setParaSpace('after', 4);
  check('space before/after', L.text.paras.every((p) => p.before === 6 && p.after === 4));
  T.format({ align: 'justify' });
  check('justify', L.text.paras.every((p) => p.align === 'justify'));
  // only the paragraphs the text selection touches
  const flow = [...el(P, L).querySelectorAll('.op-flow')][0];
  T.startEdit(P, L, flow, null, { a: { p: 1, o: 2 }, b: { p: 1, o: 5 } });
  T.setBullet('◦');
  T.commitEdit();
  check('bullets on the selected paragraph only', !L.text.paras[0].bullet && L.text.paras[1].bullet && L.text.paras[1].bullet.text === '◦' && !L.text.paras[2].bullet);
  T.startEdit(P, L, [...el(P, L).querySelectorAll('.op-flow')][0], null, { a: { p: 0, o: 0 }, b: { p: 2, o: 3 } });
  T.setBullet('✓');
  T.commitEdit();
  check('bullets on a selection across paragraphs', L.text.paras.every((p) => p.bullet && p.bullet.text === '✓'));
  // a numbered list for the saved file
  N = newTextBox('ET-NUM first', 300, 430, 200, 60);
  addParas(P, N, N.text, ['ET-NUM second']);
  T.select(P, N);
  T.setNumbering(0, 5);
  check('numbered list', N.text.paras.every((p) => p.bullet && p.bullet.number === 0) && N.text.paras[0].bullet.start === 5);
});

await section('text box properties', async () => {
  T.select(P, L);
  T.setMargin(0, 1 * CM);
  $('mt').value = '0.5';
  $('mt').dispatchEvent(new Event('change'));
  check('inner margins', near(L.text.margins[0], CM, 0.01) && near(L.text.margins[1], 0.5 * CM, 0.01), L.text.margins);
  T.setVAlign('middle');
  check('vertical alignment', L.text.valign === 'middle');
  check('vertical alignment drawn', getComputedStyle(el(P, L).querySelector('.op-text')).justifyContent === 'center');
  $('ncols').value = '2';
  $('ncols').dispatchEvent(new Event('change'));
  check('columns', L.text.columns === 2 && L.text.column_gap > 0, [L.text.columns, L.text.column_gap]);
  T.setColumnGap(0.6 * CM);
  check('column spacing', near(L.text.column_gap, 0.6 * CM, 0.01));
});

let masterSeq = null, masterTextSeq = null;
await section('master page', async () => {
  T.goTo(P);
  await wait(300);
  const peers0 = doc().pages.filter((pg) => pg.shapes.some((s) => s.from_master)).length;
  const mItem = doc().pages[P].shapes.find((s) => s.from_master && s.text);
  if (mItem) {
    click(el(P, mItem));
    check('master items are locked in normal mode', !S().sel || !S().sel.shapes.includes(mItem));
  }
  T.setMasterMode(true);
  check('master mode on', S().masterMode && !$('masterbar').hidden && document.body.classList.contains('master-mode'));
  click(el(P, A));
  check('page items are locked in master mode', !S().sel || !S().sel.shapes.includes(A));
  if (mItem) {
    masterTextSeq = mItem.seq;
    click(el(P, mItem));
    check('master item can be picked in master mode', S().sel && S().sel.shape === mItem);
    typeInto(P, mItem, mItem.text, 'ET-MASTER ');
    const copies = doc().pages.map((pg) => pg.shapes.find((s) => s.seq === masterTextSeq)).filter(Boolean);
    check('master text edit reaches every page', copies.length === peers0 && copies.every((s) => textOf(s.text).startsWith('ET-MASTER ')), { copies: copies.length, peers0 });
    const it = doc().pages[P].shapes.find((s) => s.seq === masterTextSeq);
    T.select(P, it);
    const y0 = it.y;
    T.nudge(0, 2);
    const moved = doc().pages.map((pg) => pg.shapes.find((s) => s.seq === masterTextSeq)).filter(Boolean);
    check('moving a master item moves it on every page', moved.every((s) => near(s.y, y0 + 2, 0.01)));
    T.undo();
    const back = doc().pages.map((pg) => pg.shapes.find((s) => s.seq === masterTextSeq)).filter(Boolean);
    check('undo in master mode restores every page', back.every((s) => near(s.y, y0, 0.01)), back.map((s) => s.y));
  } else log('note: the publication has no master items');
  // add a shape to the master
  const peers = doc().pages.map((pg, i) => i).filter((i) => {
    const mine = new Set(doc().pages[P].shapes.filter((s) => s.from_master).map((s) => s.seq));
    const s = doc().pages[i].shapes.filter((x) => x.from_master).map((x) => x.seq);
    return mine.size ? s.some((x) => mine.has(x)) : s.length === 0;
  });
  T.addBasic(1);
  const ms = S().sel.shape;
  masterSeq = ms.seq;
  T.setGeom('x', 500); T.setGeom('y', 40); T.setGeom('w', 40); T.setGeom('h', 20);
  T.setFill('#3366cc');
  const everywhere = peers.map((i) => doc().pages[i].shapes.find((s) => s.seq === masterSeq));
  check('a shape added in master mode goes on every page using the master', everywhere.every((s) => s && s.from_master && near(s.x, 500) && s.fill && s.fill.color === '#3366cc'), { peers: peers.length, found: everywhere.filter(Boolean).length });
  const order = doc().pages[P].shapes;
  const lastMaster = order.reduce((j, s, i) => (s.from_master ? i : j), -1), firstOwn = order.findIndex((s) => !s.from_master);
  check('master items stay under the page\'s own items', firstOwn < 0 || lastMaster < firstOwn);
  $('mastershut').click();
  check('master mode off with the Close button', !S().masterMode && $('masterbar').hidden && !document.body.classList.contains('master-mode'));
  click(el(P, doc().pages[P].shapes.find((s) => s.seq === masterSeq)));
  check('the new master item is locked again', !S().sel || S().sel.shape.seq !== masterSeq);
  T.select(0, null);
});

await section('pages', async () => {
  const n0 = doc().pages.length;
  T.goTo(P);
  await wait(300);
  const src = doc().pages[P];
  T.duplicatePage();
  await wait(400);
  const cp = doc().pages[P + 1];
  check('duplicate page', doc().pages.length === n0 + 1 && S().current === P + 1 && cp.shapes.length === src.shapes.length);
  const ownSeqs = new Set(src.shapes.filter((s) => !s.from_master).map((s) => s.seq));
  check('duplicated page items get new ids, master items keep theirs', cp.shapes.filter((s) => !s.from_master).every((s) => !ownSeqs.has(s.seq)) && cp.shapes.filter((s) => s.from_master).every((s) => src.shapes.some((x) => x.seq === s.seq)));
  T.movePage(P + 1, P);
  check('move page up', doc().pages[P] === cp && doc().pages[P + 1] === src && doc().pages.every((pg, i) => pg.number === i + 1));
  await wait(300);
  $('pagedown').click();
  await wait(300);
  check('move page down button', doc().pages[P + 1] === cp && doc().pages[P] === src);
  // drag the thumbnail of page P+2 above page P+1
  await wait(400);
  const th = [...document.querySelectorAll('#thumbs .thumb')];
  const from = th[P + 1], to = th[P];
  const fc = centre(from), tr = rect(to);
  const tEl = $('thumbs');
  from.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: fc.x, clientY: fc.y, button: 0, pointerId: 2 }));
  tEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: fc.x, clientY: fc.y - 20, pointerId: 2 }));
  tEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: fc.x, clientY: tr.top + 6, pointerId: 2 }));
  tEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: fc.x, clientY: tr.top + 6, pointerId: 2 }));
  await wait(300);
  check('drag a page in the page list', doc().pages[P] === cp && doc().pages[P + 1] === src, doc().pages.indexOf(cp));
  T.undo();
  await wait(300);
  check('undo the page move', doc().pages[P + 1].shapes.length === cp.shapes.length && doc().pages.length === n0 + 1);
  // keep the duplicate (the saved file must have it); delete check
  T.goTo(P + 1);
  await wait(200);
  T.duplicatePage();
  await wait(200);
  T.deletePage();
  await wait(200);
  check('delete page', doc().pages.length === n0 + 1);
});

await section('pictures', async () => {
  let found = null;
  doc().pages.forEach((pg, i) => pg.shapes.forEach((s) => { if (!found && !s.from_master && s.kind === 'picture' && s.image != null && !s.rotation && !s.crop) found = { i, s }; }));
  if (!found) doc().pages.forEach((pg, i) => pg.shapes.forEach((s) => { if (!found && !s.from_master && s.kind === 'picture' && s.image != null) found = { i, s }; }));
  if (!found) { log('note: the publication has no pictures'); return; }
  const { i, s: pic } = found;
  T.goTo(i);
  await wait(500);
  T.select(i, pic);
  check('Picture tab appears', !$('t-picture').hidden);
  const nImg = doc().images.length;
  const other = nImg > 1 ? (pic.image + 1) % nImg : pic.image;
  const cx = pic.x + pic.w / 2, cy = pic.y + pic.h / 2;
  T.replacePicture();
  OpenPubApp.pictureAdded(other, 400, 200);
  check('change picture keeps its place and the new proportions', pic.image === other && near(pic.w / pic.h, 2, 0.01) && near(pic.x + pic.w / 2, cx) && near(pic.y + pic.h / 2, cy) && doc().pages[i].shapes.includes(pic), { image: pic.image, w: pic.w, h: pic.h });
  const o = { x: pic.x, y: pic.y, w: pic.w, h: pic.h };
  const flipped = !!pic.flip_h;
  T.setCropSide(0, 0.1);
  check('numeric crop (left 10%)', pic.crop && near(pic.crop[0], 0.1, 1e-6) && near(pic.w, o.w * 0.9) && near(flipped ? pic.x : pic.x - o.w * 0.1, o.x), { crop: pic.crop, x: pic.x, w: pic.w });
  $('crr').value = '20';
  $('crr').dispatchEvent(new Event('change'));
  check('crop field (right 20%)', near(pic.crop[2], 0.2, 1e-6) && near(pic.w, o.w * 0.7));
  T.cropTo([0, 0, 0, 0]);
  check('reset crop', !pic.crop && near(pic.w, o.w) && near(pic.x, o.x));
  T.setCropMode(true);
  await wait(50);
  check('crop mode shows crop handles and the whole picture', !!document.querySelector('.selbox.crop .h.e') && !!document.querySelector('.selbox.crop .ghost'));
  const f = kpx(i);
  const he = document.querySelector('.selbox.crop .h.e'), hc = centre(he);
  drag(he, hc, { x: hc.x - 30, y: hc.y });
  // a flipped picture shows its left edge on the right
  const vis = (c) => (pic.flip_h ? [c[2], c[1], c[0], c[3]] : c);
  check('crop by dragging a handle', pic.crop && near(vis(pic.crop)[2], 30 / f / o.w, 0.01) && near(pic.x, o.x) && near(pic.w, o.w - 30 / f), { crop: pic.crop, w: pic.w, flip: !!pic.flip_h });
  const hw = document.querySelector('.selbox.crop .h.w'), wc = centre(hw);
  drag(hw, wc, { x: wc.x - 40, y: wc.y });
  check('crop cannot go past the picture edge', near(vis(pic.crop)[0], 0, 1e-6) && near(pic.x, o.x), { crop: pic.crop, x: pic.x });
  key('Escape');
  check('Esc ends cropping', !S().cropMode);
  T.cropTo([0.1, 0, 0, 0]);
  T.goTo(P);
  await wait(300);
});

await section('undo / redo', async () => {
  T.select(P, A);
  const x = A.x;
  T.nudge(7, 0);
  T.undo();
  const a1 = doc().pages[P].shapes.find((s) => s.seq === A.seq);
  check('undo', near(a1.x, x, 0.01));
  T.redo();
  const a2 = doc().pages[P].shapes.find((s) => s.seq === A.seq);
  check('redo', near(a2.x, x + 7, 0.01));
  T.select(P, a2);
  T.nudge(-7, 0);
  A = a2;
});

// expected page count for the reopened file
window.dispatchEvent(new Event('blur'));
T.select(0, null);
T.goTo(P);
await wait(200);
T.handlePaste('ET-PAGES=' + doc().pages.length);
const pagesBox = S().sel.shape;
T.setGeom('x', 60);
T.setGeom('y', 700);
T.select(0, null);
log('expect: pages ' + doc().pages.length + ' master item ' + masterSeq + ' master text ' + masterTextSeq + ' marker ' + (pagesBox && pagesBox.seq));

T.send({ cmd: 'save', doc: OpenPubApp.docJson(), path: out + 'edit-' + name + '.opub' });
T.send({ cmd: 'docx', doc: OpenPubApp.docJson(), path: out + 'edit-' + name + '.docx' });
await wait(4000);
log('SUMMARY ' + okN + ' OK, ' + failN + ' FAIL');
window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
