// Wrap text (0.3.28): Shape Format > Wrap text chooses how text flows around an object - square,
// tight, top and bottom, in front of text (no wrapping, on top) or behind text (no wrapping,
// underneath). Run inside a debug build on Worksheet 8 (a page of text):
//   openpub.exe samples/Worksheet_8.pub --eval=tools/wrapuitest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
(async () => {
  try {
    T.goTo(0);
    await wait(300);
    const list = () => T.doc().pages[0].shapes;
    const all = (s) => (s.text ? s.text.paras.map((p) => p.runs.map((r) => r.text || '').join('')).join(' ') : '');
    const frame = list().find((s) => /Last session/.test(all(s)));
    check('the page has a box of text', !!frame);
    const pushed = () => { const el = T.shapeEl(0, frame); return el ? el.querySelectorAll('.op-wrap').length : 0; };
    const first = () => { const el = T.shapeEl(0, frame); const f = el && el.querySelector('.op-flow span'); return f ? f.getBoundingClientRect().left : 0; };
    check('...with nothing in its way to begin with', pushed() === 0);

    // an ellipse over the left of the text
    T.addBasic(3);
    await wait(200);
    const oval = list()[list().length - 1];
    T.select(0, oval);
    T.setGeom('x', frame.x + 4);
    T.setGeom('y', frame.y + 4);
    await wait(300);
    check('a new object pushes the text aside (Square, as in Publisher)', pushed() > 0 && T.wrapModeOf(0, oval) === 'square');
    T.showTab('shape');
    $('wrapbtn').click();
    await wait(100);
    check('Wrap text lists the five ways, Square marked', !$('wrappop').hidden && $('wrappop').querySelectorAll('[data-wrap]').length === 5 && $('wrappop').querySelector('[data-wrap="square"]').classList.contains('on'));

    const u = T.state().undo;
    $('wrappop').querySelector('[data-wrap="front"]').click();
    await wait(300);
    check('In front of text: the text no longer moves aside', pushed() === 0 && oval.wrap === 'none' && T.wrapModeOf(0, oval) === 'front', [pushed(), oval.wrap]);
    check('...the object is on top', list()[list().length - 1] === oval);
    check('...one undo step', T.state().undo === u + 1);

    T.setWrap('behind');
    await wait(300);
    check('Behind text: no wrapping, and the object is under the text', pushed() === 0 && list().indexOf(oval) < list().indexOf(frame) && T.wrapModeOf(0, oval) === 'behind',
      [pushed(), list().indexOf(oval), list().indexOf(frame), T.wrapModeOf(0, oval), oval.wrap, list().length, !!T.state().sel, list().slice(0, 4).map((s) => [s.kind, !!s.from_master, !!s.text])]);
    $('wrapbtn').click(); await wait(50);
    check('...and the menu shows it', $('wrappop').querySelector('[data-wrap="behind"]').classList.contains('on') && !$('wrappop').querySelector('[data-wrap="front"]').classList.contains('on'));
    $('wrapbtn').click();

    // back on top, wrapping again
    T.reorder(true);
    check('Bring to front still brings it to the front', list()[list().length - 1] === oval);
    T.reorder(false);
    check('...and Send to back to the back', list()[0] === oval);
    T.reorder(true);
    T.setWrap('topbottom');
    await wait(300);
    check('Top and bottom: the text is pushed (nothing beside the object)', pushed() > 0 && oval.wrap === 'topbottom');
    T.setWrap('tight');
    await wait(300);
    check('Tight: the text follows the outline', pushed() > 0 && oval.wrap === 'tight');
    T.setWrap('square');
    await wait(300);
    check('Square again', pushed() > 0 && oval.wrap === 'square');

    T.undo(); await wait(200);
    T.undo(); await wait(200);
    const o2 = list().find((s) => s.seq === oval.seq);
    check('Undo goes back a step at a time', o2 && o2.wrap === 'topbottom', o2 && o2.wrap);
    T.setWrap('bogus');
    check('an unknown way is ignored', list().find((s) => s.seq === oval.seq).wrap === 'topbottom');
  } catch (e) {
    check('no error', false, String(e && e.stack || e));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  T.send({ cmd: 'quit' });
})();
