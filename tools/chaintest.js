// Linking text boxes (0.3.26): Text Box > Link to text box, then a click on an empty text box (or
// an empty part of a page, for a new box) carries the text on into it; Break link stops it; the
// arrows go from box to box. Run inside a debug build on a publication of two pages or more:
//   openpub.exe samples/Worksheet_8.pub --eval=tools/chaintest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const LONG = 'Our class trip to the science museum was the best day of the year. We saw rockets, robots and a real dinosaur skeleton. ';
const shownText = (page, sh) => { const el = T.shapeEl(page, sh); return el ? el.textContent.replace(/[­⁠]/g, '') : ''; };
(async () => {
  try {
    check('the publication has two pages', T.doc().pages.length >= 2);
    T.goTo(0);
    await wait(300);
    // a box on page 1 with more text than fits
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, LONG.repeat(4) + 'THE END');
    T.commitEdit();
    await wait(200);
    const shapes0 = T.doc().pages[0].shapes;
    const src = shapes0[shapes0.length - 1];
    T.select(0, src);
    T.setGeom('h', 60);
    await wait(300);
    check('the box\'s text doesn\'t all fit', T.overflowing(0, src));
    check('Link to text box is on; Break link and the arrows are off', !$('linkbox').disabled && $('unlinkbox').disabled && $('nextbox').disabled && $('prevbox').disabled);

    // link on to a new box on page 2
    T.armLink();
    check('linking: a hint says what to do', document.body.classList.contains('linking') && !$('toolhint').hidden && /empty text box/.test($('toolhint').textContent));
    const n1 = T.doc().pages[1].shapes.length;
    const u = T.state().undo;
    let why = T.linkTo(1, null, { x: 60, y: 200 });
    await wait(400);
    const tgt = T.doc().pages[1].shapes[T.doc().pages[1].shapes.length - 1];
    check('a click on an empty part of page 2 makes a new box there', why === '' && T.doc().pages[1].shapes.length === n1 + 1 && tgt.kind === 'text' && Math.abs(tgt.x - 60) < 1, why);
    check('...as wide as the first', Math.abs(tgt.w - src.w) < 0.01);
    check('...linked: the same story, next in the chain, no text of its own', src.text.story > 0 && tgt.text.story === src.text.story && tgt.text.chain === 1 && tgt.text.paras.length === 0 && !src.text.chain, [src.text.story, tgt.text]);
    check('...and the hint is gone', !document.body.classList.contains('linking') && $('toolhint').hidden);
    check('the text carries on in the new box', /dinosaur|END/.test(shownText(1, tgt)), shownText(1, tgt).slice(0, 80));
    check('...the first box no longer says it overflows', !T.overflowing(0, src));
    check('one undo step', T.state().undo === u + 1);
    check('the new box is selected: the back arrow is on, Break link and the next arrow off', T.state().sel.shape === tgt && !$('prevbox').disabled && $('nextbox').disabled && $('unlinkbox').disabled);
    T.stepLinked(-1);
    await wait(200);
    check('the back arrow goes to the first box', T.state().sel.shape === src && T.state().sel.page === 0);
    check('...where Break link and the next arrow are on, and Link off (it already carries on)', !$('unlinkbox').disabled && !$('nextbox').disabled && $('linkbox').disabled);

    // undo and redo
    T.undo();
    await wait(300);
    const d0 = T.doc().pages[0].shapes, s0 = d0[d0.length - 1];
    check('Undo takes the link and the new box away', T.doc().pages[1].shapes.length === n1 && !T.chainOf(s0));
    T.redo();
    await wait(300);
    const srcR = T.doc().pages[0].shapes[T.doc().pages[0].shapes.length - 1];
    const tgtR = T.doc().pages[1].shapes[T.doc().pages[1].shapes.length - 1];
    check('Redo puts them back', (T.chainOf(srcR) || []).length === 2 && tgtR.text.chain === 1);

    // refusals: a box with text in it, the box itself, linking on from the middle
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, 'Already has words');
    T.commitEdit();
    await wait(200);
    const full = T.doc().pages[0].shapes[T.doc().pages[0].shapes.length - 1];
    T.select(1, tgtR);
    T.armLink();
    const before = JSON.stringify(T.doc().pages);
    why = T.linkTo(0, full, { x: 0, y: 0 });
    check('a box that already has text is refused, with a reason', /already has text/.test(why) && JSON.stringify(T.doc().pages) === before, why);
    T.select(0, srcR);
    check('a box that already carries on can\'t link again', !T.linkSource());

    // a third box: an empty one already on page 1
    T.addText();
    await wait(200);
    T.commitEdit();
    const third = T.doc().pages[0].shapes[T.doc().pages[0].shapes.length - 1];
    T.select(1, tgtR);
    T.armLink();
    why = T.linkTo(0, third, { x: 0, y: 0 });
    await wait(300);
    const chain = T.chainOf(srcR) || [];
    check('an empty box joins the end of the chain', why === '' && chain.length === 3 && chain[2].shape === third && third.text.chain === 2, why);

    // break the link after the first box: the others are empty boxes of their own again
    T.select(0, srcR);
    T.breakLink();
    await wait(400);
    check('Break link: no chain left', !T.chainOf(srcR) && !srcR.text.chain);
    check('...the other boxes are empty boxes with stories of their own', [tgtR, third].every((s) => !s.text.chain && s.text.story !== srcR.text.story && s.text.paras.length === 1) && tgtR.text.story !== third.text.story);
    check('...and the text is back in the first box, which overflows again', T.overflowing(0, srcR) && srcR.text.paras.map((p) => p.runs.map((r) => r.text).join('')).join('').includes('THE END'));

    // Esc puts the linking tool down
    T.select(0, srcR);
    T.armLink();
    $('view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(100);
    check('Esc cancels linking', !document.body.classList.contains('linking'));
  } catch (e) {
    check('no error', false, String(e && e.stack || e));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  T.send({ cmd: 'quit' });
})();
