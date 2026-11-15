// Checks that the edits made by tools/edittest.js survived saving and reopening:
//   openpub.exe out/edit-<name>.opub --eval=tools/edittest-verify.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CM = 72 / 2.54;
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (detail !== undefined && !cond ? ' -- ' + JSON.stringify(detail) : ''));
};
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const doc = T.doc();
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const all = [];
doc.pages.forEach((pg, i) => {
  const walk = (s, parent) => { all.push({ s, page: i, parent }); (s.children || []).forEach((c) => walk(c, s)); };
  pg.shapes.forEach((s) => walk(s, null));
});
const byText = (t) => all.find((x) => x.s.text && textOf(x.s.text).startsWith(t));
log('verify ' + doc.name + ': ' + doc.pages.length + ' pages');

try {
  const pagesBox = byText('ET-PAGES=');
  check('page count', pagesBox && doc.pages.length === parseInt(textOf(pagesBox.s.text).slice(9), 10), pagesBox && textOf(pagesBox.s.text));
  check('page numbers in order', doc.pages.every((p, i) => p.number === i + 1));

  const rot = byText('ET-ROT');
  check('rotation', rot && rot.s.rotation === 30, rot && rot.s.rotation);
  check('fill transparency and dash', rot && rot.s.fill && near(rot.s.fill.opacity, 0.6, 0.001) && rot.s.line && rot.s.line.dash === 8, rot && [rot.s.fill, rot.s.line]);

  const g1 = byText('ET-G1'), g2 = byText('ET-G2');
  check('group', g1 && g2 && g1.parent && g1.parent === g2.parent && g1.parent.kind === 'group' && g1.parent.children.length === 2);

  const tbl = all.find((x) => x.s.kind === 'table' && x.s.table.cells.some((c) => textOf(c).startsWith('ET-TABLE')));
  check('table', !!tbl);
  if (tbl) {
    const t = tbl.s.table;
    const seen = new Set();
    let bad = '';
    for (const c of t.cells) for (let r = c.r0; r <= c.r1; r++) for (let q = c.c0; q <= c.c1; q++) { if (seen.has(r + ',' + q)) bad = 'overlap'; seen.add(r + ',' + q); }
    if (seen.size !== t.rows.length * t.cols.length) bad = 'holes';
    check('table grid is whole', !bad && near(tbl.s.w, t.cols.reduce((a, b) => a + b, 0), 0.01) && near(tbl.s.h, t.rows.reduce((a, b) => a + b, 0), 0.01), bad);
    check('table size', t.rows.length === 4 && t.cols.length === 4, [t.rows.length, t.cols.length]);
    check('merged cell', t.cells.some((c) => c.r0 === 3 && c.c0 === 0 && c.c1 === 1));
    check('cell fill', t.cells.filter((c) => c.r0 === 0 && c.fill && c.fill.color === '#ffee00').length >= 3);
    check('cell alignment', t.cells.some((c) => c.valign === 'middle'));
    check('cell borders', t.cells.some((c) => c.borders.some((b) => b && b.color === '#ff0000' && b.width === 2.25)));
  }

  const list = byText('ET-LIST');
  check('bullets', list && list.s.text.paras.every((p) => p.bullet && p.bullet.text === '✓' && near(p.left, CM, 0.01) && near(p.first, -CM, 0.01)), list && list.s.text.paras.map((p) => p.bullet));
  check('paragraph spacing and alignment', list && list.s.text.paras.every((p) => p.spacing === 1.15 && p.before === 6 && p.after === 4 && p.align === 'justify'));
  check('text box margins, alignment, columns', list && near(list.s.text.margins[0], CM, 0.01) && list.s.text.valign === 'middle' && list.s.text.columns === 2 && near(list.s.text.column_gap, 0.6 * CM, 0.01), list && [list.s.text.margins, list.s.text.valign, list.s.text.columns, list.s.text.column_gap]);
  const numl = byText('ET-NUM');
  check('numbering', numl && numl.s.text.paras.every((p) => p.bullet && p.bullet.number === 0) && numl.s.text.paras[0].bullet.start === 5);
  await wait(200);
  if (numl) {
    T.goTo(numl.page);
    await wait(800);
    const labels = [...T.shapeEl(numl.page, numl.s).querySelectorAll('.op-bullet')].map((b) => b.textContent);
    check('numbering drawn', labels.join() === '5.,6.', labels);
  }

  const pics = all.filter((x) => x.s.crop && near(x.s.crop[0], 0.1, 1e-6));
  check('cropped picture', pics.length >= 1 || !all.some((x) => x.s.kind === 'picture' && !x.s.from_master));

  // master page: the item added in master mode is on every page with the same master
  const masterAdded = all.filter((x) => x.s.from_master && x.s.fill && x.s.fill.color === '#3366cc' && near(x.s.x, 500));
  const seq = masterAdded[0] && masterAdded[0].s.seq;
  const pagesWith = new Set(masterAdded.filter((x) => x.s.seq === seq).map((x) => x.page));
  check('master item on every page', masterAdded.length > 0 && pagesWith.size === doc.pages.length, { pages: pagesWith.size, of: doc.pages.length });
  const mt = all.filter((x) => x.s.from_master && x.s.text && textOf(x.s.text).startsWith('ET-MASTER'));
  if (mt.length) check('master text on every page', new Set(mt.map((x) => x.page)).size === doc.pages.length, mt.length);
  check('fresh ids are unique', (() => {
    const seen = new Map();
    for (const x of all) {
      if (x.s.from_master) continue;
      const k = x.s.seq;
      if (seen.has(k) && seen.get(k) === x.page) return false;
      seen.set(k, x.page);
    }
    return true;
  })());
} catch (e) {
  failN++;
  log('FAIL threw ' + e + ' ' + e.stack);
}
log('SUMMARY ' + okN + ' OK, ' + failN + ' FAIL');
window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
