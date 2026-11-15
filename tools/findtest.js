// Automated check of Find & Replace and the text buttons (strikethrough, superscript, subscript,
// larger/smaller), run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/findtest.js
// Works on any publication (it adds its own text box). Prints OK / FAIL lines and a SUMMARY line.
// Set window.FINDTEST_STAY = true to stop with the find box open on a match (for screenshots).
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const W = 'zqxalpha'; // a word no publication contains

(async () => {
  const page = T.state().current;
  T.addText();
  await wait(300);
  T.commitEdit();
  const shape = T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1];
  const base = shape.text.paras[0].runs[0];
  const run = (text, more) => Object.assign({}, base, { text }, more || {});
  const para = (runs) => Object.assign({}, shape.text.paras[0], { runs });
  shape.text.paras = [
    para([run(`Zqxalpha beta ${W}`)]),
    para([run('gam', { bold: true }), run(`ma ${W.toUpperCase()} end`)]),
  ];
  shape.h = 90;
  T.select(page, shape);
  T.format({ italic: false }); // redraws the page
  await wait(300);
  const mine = (list) => list.filter((m) => m.shape === shape);

  check('finds every match, ignoring case', mine(T.findMatches(W, false)).length === 3, mine(T.findMatches(W, false)).length);
  check('Match case narrows it', mine(T.findMatches(W, true)).length === 1);
  check('a match can span two formats', mine(T.findMatches('gamma', false)).length === 1);

  // the find box
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  check('Ctrl+F opens the find box', !$('findbar').hidden && document.activeElement === $('findq'));
  $('findq').value = W;
  $('findq').dispatchEvent(new Event('input'));
  $('findnext').click();
  await wait(300);
  check('Find Next marks a match and selects its text box', CSS.highlights.has('op-find') && T.state().sel && T.state().sel.shape === shape, $('findmsg').textContent);
  check('and says which one', /^1 of 3/.test($('findmsg').textContent), $('findmsg').textContent);
  const marked = [...CSS.highlights.get('op-find')][0];
  check('the marked text is the match', marked && marked.toString().replace(/­/g, '').toLowerCase() === W, marked && marked.toString());
  if (window.FINDTEST_STAY) return;
  $('findnext').click();
  await wait(200);
  check('Find Next moves on', /^2 of 3/.test($('findmsg').textContent), $('findmsg').textContent);

  // replace one (the second match), keeping the rest
  $('findr').value = 'OMEGA';
  const undoBefore = T.state().undo;
  $('replone').click();
  await wait(300);
  check('Replace changes that match only', textOf(shape.text) === `Zqxalpha beta OMEGA\ngamma ${W.toUpperCase()} end`, textOf(shape.text));
  check('and moves to the next match', /of 2/.test($('findmsg').textContent) && CSS.highlights.has('op-find'), $('findmsg').textContent);
  check('one undo step per replacement', T.state().undo === undoBefore + 1);

  // replace all, then undo it in one step
  $('replall').click();
  await wait(300);
  check('Replace All changes the rest', textOf(shape.text) === 'OMEGA beta OMEGA\ngamma OMEGA end', textOf(shape.text));
  check('and reports the count', /Replaced 2 matches/.test($('findmsg').textContent), $('findmsg').textContent);
  T.undo();
  await wait(300);
  const again = T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1];
  check('one Undo brings them all back', textOf(again.text) === `Zqxalpha beta OMEGA\ngamma ${W.toUpperCase()} end`, textOf(again.text));

  // across two formats: the new text takes the first one's
  $('findq').value = 'gamma';
  $('findq').dispatchEvent(new Event('input'));
  $('findr').value = 'G';
  $('findnext').click();
  await wait(200);
  $('replone').click();
  await wait(300);
  const sh = T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1];
  const r0 = sh.text.paras[1].runs[0];
  check('replacing across formats keeps the first format', r0.text === 'G' && r0.bold === true && textOf(sh.text).endsWith(`G ${W.toUpperCase()} end`), sh.text.paras[1].runs.map((r) => [r.text, !!r.bold]));
  $('findq').value = 'nothing-like-this-anywhere';
  $('findq').dispatchEvent(new Event('input'));
  $('findnext').click();
  check('no match is reported', $('findmsg').textContent === 'No matches');
  $('findclose').click();
  check('closing clears the mark', $('findbar').hidden && !CSS.highlights.has('op-find'));

  // text buttons
  T.select(page, sh);
  await wait(100);
  const runs = () => T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1].text.paras.flatMap((p) => p.runs);
  $('strike').click();
  await wait(200);
  const el = T.shapeEl(page, T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1]);
  check('Strikethrough strikes the text', runs().every((r) => r.strike) && [...el.querySelectorAll('.op-para span')].some((s) => /line-through/.test(s.style.textDecoration)));
  check('and its button shows as on', $('strike').classList.contains('on'));
  $('strike').click();
  await wait(200);
  check('again removes it', runs().every((r) => !r.strike));
  const size0 = runs()[0].size;
  $('grow').click();
  await wait(200);
  check('Larger steps the size up', runs()[0].size > size0, [size0, runs()[0].size]);
  $('shrink').click();
  await wait(200);
  check('Smaller steps it back', runs()[0].size === size0, [size0, runs()[0].size]);
  $('super').click();
  await wait(200);
  check('Superscript', runs().every((r) => r.script === 1) && $('super').classList.contains('on'));
  $('sub').click();
  await wait(200);
  check('Subscript replaces it', runs().every((r) => r.script === 2) && !$('super').classList.contains('on'));
  $('sub').click();
  await wait(200);
  check('and again turns it off', runs().every((r) => !r.script));

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
