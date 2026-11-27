// Automated checks of picture borders added in the editor and 3-D WordArt (0.3.6). Run inside a
// debug build on the shapes test file (its first page has 3-D WordArt):
//   openpub.exe samples/probe/probe-shapes.pub --eval=tools/bordertest.js
// Prints OK / FAIL lines and a SUMMARY line.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};

(async () => {
  try {
    // ---- 3-D WordArt from the file
    T.goTo(0);
    await wait(800);
    const wa = T.doc().pages[0].shapes.filter((s) => s.wordart);
    const deep = wa.filter((s) => s.wordart.extrude);
    check('3-D WordArt is read with its depth', deep.length >= 6 && deep.every((s) => isFinite(s.wordart.extrude.dx) && isFinite(s.wordart.extrude.dy)), deep.length);
    const w27 = deep.find((s) => s.wordart.text === 'WordArt 27');
    check('...the depth goes the way the WordArt is turned (WordArt 27: down and to the left)', w27 && w27.wordart.extrude.dx < 0 && w27.wordart.extrude.dy > 0, w27 && w27.wordart.extrude);
    const layers = w27 && T.shapeEl(0, w27).querySelectorAll('svg > g').length;
    check('...and drawn with its sides behind the letters', layers >= 2, layers);
    check('flat WordArt stays flat', wa.filter((s) => !s.wordart.extrude).length >= 10);

    // ---- picture borders
    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(1500);
    T.addBasic(1);
    await wait(200);
    const r = T.state().sel.shape;
    T.setGeom('w', 200);
    T.setGeom('h', 120);
    T.showTab('shape');
    await wait(100);
    check('a shape can be given a picture border', !$('borderart').disabled && $('bordersize').disabled);
    const u0 = T.state().undo;
    $('borderart').value = 'stars';
    $('borderart').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1500);
    check('choosing Stars puts a border of stars round it', r.border_art && r.border_art.tiles.length === 8 && r.border_art.tiles.every((t) => t === r.border_art.tiles[0]) && !r.line, r.border_art);
    const imgs = T.shapeEl(0, r).querySelectorAll('.op-borderart img');
    const resp = imgs.length ? await fetch(imgs[0].src) : null;
    check('...drawn as pictures all round', imgs.length > 20 && resp && resp.ok, [imgs.length, resp && resp.status]);
    check('...in one undo step', T.state().undo === u0 + 1, T.state().undo - u0);
    $('bordersize').value = '24';
    $('bordersize').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    check('its size can be changed', r.border_art.size === 24 && T.shapeEl(0, r).querySelectorAll('.op-borderart img').length < imgs.length, [r.border_art.size, T.shapeEl(0, r).querySelectorAll('.op-borderart img').length]);
    // a second shape with the same border uses the same picture
    T.addBasic(3);
    await wait(200);
    const e = T.state().sel.shape;
    $('borderart').value = 'stars';
    $('borderart').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(800);
    check('the same border on another shape reuses its picture', e.border_art && e.border_art.tiles[0] === r.border_art.tiles[0]);
    $('borderart').value = 'hearts';
    $('borderart').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1200);
    check('a different design changes it', e.border_art.tiles[0] !== r.border_art.tiles[0]);
    $('borderart').value = '';
    $('borderart').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    check('No picture border takes it off', !e.border_art && !T.shapeEl(0, e).querySelector('.op-borderart img'));
    // kept by saving
    const json = JSON.parse(OpenPubApp.docJson());
    check('the border is saved with the publication', json.pages[0].shapes.some((s) => s.border_art && s.border_art.size === 24));
  } catch (err) {
    check('no error', false, String(err) + ' ' + err.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
