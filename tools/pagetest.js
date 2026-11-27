// Automated check of the shapes gallery, align and flip, and page setup (size, orientation,
// background, border), run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/pagetest.js
// Works on any publication. Prints OK / FAIL lines and a SUMMARY line. Set window.PAGETEST_STAY =
// 'gallery' | 'page' to stop there (for screenshots).
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const near = (a, b) => Math.abs(a - b) < 0.6;

(async () => {
  const doc = () => T.doc();
  const page = T.state().current;
  const shapes = () => doc().pages[page].shapes;
  const last = () => shapes()[shapes().length - 1];

  // ---- gallery
  T.showTab('insert');
  $('shapesbtn').click();
  const cells = [...$('shapepop').querySelectorAll('.cells button')];
  check('the gallery opens with many shapes', !$('shapepop').hidden && cells.length >= 60, cells.length);
  check('each has a drawing and a name', cells.every((b) => b.querySelector('svg path') && b.title));
  if (window.PAGETEST_STAY === 'gallery') return;
  const n0 = shapes().length;
  cells.find((b) => b.title === '5-point star').click();
  await wait(100);
  check('choosing one picks it up to draw, and closes the gallery', T.tool() && T.tool().type === 12 && $('shapepop').hidden);
  // a click on the page (in view) puts it there
  const sh = T.sheets()[page].el, vr = document.getElementById('view').getBoundingClientRect(), sr = sh.getBoundingClientRect();
  const cx = Math.max(sr.left + 40, vr.left + vr.width / 2), cy = Math.max(sr.top + 40, vr.top + vr.height / 2);
  const ev = (type, target) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: cx, clientY: cy }));
  ev('pointerdown', sh);
  ev('pointerup', document.getElementById('pages'));
  await wait(300);
  check('a click on the page adds that shape, selected', shapes().length === n0 + 1 && last().shape_type === 12 && T.state().sel.shape === last(), last().shape_type);
  const star = last();
  const drawn = T.shapeEl(page, star);
  check('it is drawn as a star (not a box)', drawn && /[LlCc]/.test(drawn.querySelector('svg path').getAttribute('d')) && drawn.querySelector('svg path').getAttribute('d').split(/[Ll ]/).length > 8);

  // ---- align and flip
  T.alignSel('center');
  await wait(200);
  check('one object centres on the page', near(last().x + last().w / 2, doc().width / 2), [last().x, last().w, doc().width]);
  T.alignSel('bottom');
  await wait(200);
  check('and aligns to the bottom edge', near(last().y + last().h, doc().height));
  T.addBasic(1);
  await wait(300);
  const rect = last(), starNow = shapes()[shapes().length - 2];
  T.nudge(-60, 35); // not lined up with the star
  await wait(200);
  T.select(page, starNow);
  T.select(page, last(), 'toggle');
  check('two objects selected', T.state().sel.shapes.length === 2);
  const xBefore = [starNow.x, last().x];
  $('alnl').click();
  await wait(200);
  const [a, b] = [shapes()[shapes().length - 2], shapes()[shapes().length - 1]];
  check('several objects align with each other', near(a.x, b.x) && !near(xBefore[0], xBefore[1]), [xBefore, a.x, b.x]);
  $('alnt').click();
  await wait(200);
  check('top edges too', near(shapes()[shapes().length - 2].y, shapes()[shapes().length - 1].y));
  T.select(page, last());
  $('fliph').click();
  await wait(200);
  check('Flip left to right', last().flip_h === true);
  $('fliph').click();
  await wait(200);
  check('again restores it', !last().flip_h);
  $('flipv').click();
  await wait(200);
  check('Flip top to bottom', last().flip_v === true);

  // ---- page setup
  T.showTab('page');
  const w0 = doc().width, h0 = doc().height;
  const portrait = h0 >= w0;
  check('the Page tab shows the size', near(parseFloat($('pgw').value) * 72 / 2.54, w0) && $(portrait ? 'pgport' : 'pgland').classList.contains('on'), [$('pgw').value, w0]);
  if (window.PAGETEST_STAY === 'page') return;
  $(portrait ? 'pgland' : 'pgport').click();
  await wait(700);
  check('orientation swaps width and height', near(doc().width, h0) && near(doc().height, w0), [doc().width, doc().height]);
  check('and the page is redrawn that shape', near(T.sheets()[page].el.getBoundingClientRect().width / T.sheets()[page].el.getBoundingClientRect().height, h0 / w0 * 1) || Math.abs(T.sheets()[page].el.getBoundingClientRect().width / T.sheets()[page].el.getBoundingClientRect().height - h0 / w0) < 0.02);
  T.undo();
  await wait(700);
  check('Undo restores the page size', near(doc().width, w0) && near(doc().height, h0), [doc().width, doc().height]);
  $('pgsize').value = 'a5';
  $('pgsize').dispatchEvent(new Event('change'));
  await wait(700);
  const a5 = [148 * 72 / 25.4, 210 * 72 / 25.4];
  check('choosing A5 sets it, keeping the orientation', near(Math.min(doc().width, doc().height), a5[0]) && near(Math.max(doc().width, doc().height), a5[1]) && (doc().height >= doc().width) === portrait, [doc().width, doc().height]);
  T.undo();
  await wait(700);
  $('pgw').value = '25';
  $('pgw').dispatchEvent(new Event('change'));
  await wait(700);
  check('a custom width in cm', near(doc().width, 25 * 72 / 2.54) && $('pgsize').value === 'custom', [doc().width, $('pgsize').value]);
  T.undo();
  await wait(700);

  T.setPageBackground('#ffeeaa');
  await wait(300);
  const bg = T.sheets()[page].el.querySelector('.op-pagebg');
  check('a page background colour is stored and drawn', doc().pages[page].background === '#ffeeaa' && bg && /255, 238, 170/.test(getComputedStyle(bg).backgroundColor));
  check('behind the page items', bg && bg === bg.parentElement.firstElementChild);
  $('pgbgall').click();
  await wait(300);
  check('Apply to all pages', doc().pages.every((p) => p.background === '#ffeeaa'));
  T.undo();
  await wait(400);
  $('pgbgnone').click();
  await wait(300);
  check('None removes it', !doc().pages[page].background && !T.sheets()[page].el.querySelector('.op-pagebg'));

  const n1 = shapes().length;
  $('pgborder').click();
  await wait(300);
  const br = last();
  check('Page border adds an unfilled rectangle inside the edge', shapes().length === n1 + 1 && br.shape_type === 1 && !br.fill && br.line && br.x > 0 && near(br.x + br.w / 2, doc().width / 2));

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
