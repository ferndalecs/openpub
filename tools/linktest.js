// Automated checks of text positions (tabs, line breaks) and of linked text boxes - typing,
// formatting, Find & Replace and copying - run inside a debug build on the linked-box test file:
//   openpub.exe samples/probe/probe-linked.pub --eval=tools/linktest.js
// (story 84 runs from page 1's first box through page 1's second box to page 2.)
// Prints OK / FAIL lines and a SUMMARY line.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const textOf = (paras) => paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const bySeq = (seq) => {
  for (let i = 0; i < T.doc().pages.length; i++) {
    const s = T.doc().pages[i].shapes.find((x) => x.seq === seq);
    if (s) return { page: i, shape: s };
  }
  return null;
};
const viewFlow = (page, shape) => [...T.shapeEl(page, shape).querySelectorAll('.op-flow')].find((f) => f.opOwner && f.opOwner._commit);
const story = () => bySeq(305).shape.text.paras;

(async () => {
  try {
    // ---- text positions after a tab and a line break (formatting lands on the right letters)
    T.goTo(0);
    await wait(500);
    T.addText();
    await wait(250);
    T.commitEdit();
    const page0 = T.doc().pages[0];
    const box = page0.shapes[page0.shapes.length - 1];
    const base = box.text.paras[0].runs[0];
    box.text.paras = [Object.assign({}, box.text.paras[0], { runs: [Object.assign({}, base, { text: 'a\tbc\nde fgh' })] })];
    box.w = 300;
    T.select(0, box);
    T.format({ italic: false });
    await wait(250);
    // select "fgh" (offsets 8..11: a, tab, b, c, line break, d, e, space)
    let flow = [...T.shapeEl(0, box).querySelectorAll('.op-flow')][0];
    T.startEdit(0, box, flow, null, { a: { p: 0, o: 8 }, b: { p: 0, o: 11 } });
    await wait(100);
    check('a selection after a tab and a line break covers the right letters', String(window.getSelection()) === 'fgh', String(window.getSelection()));
    T.format({ bold: true });
    await wait(200);
    T.format({ italic: true }); // a second button on the same selection
    await wait(200);
    T.commitEdit();
    const runs = box.text.paras[0].runs;
    const bold = runs.filter((r) => r.bold).map((r) => r.text).join('');
    const ital = runs.filter((r) => r.italic).map((r) => r.text).join('');
    check('Bold then Italic both land on the selected word', bold === 'fgh' && ital === 'fgh', runs.map((r) => [r.text, !!r.bold, !!r.italic]));

    // ---- typing in the part of a story shown on page 2
    const before = textOf(story());
    const p2 = bySeq(307);
    T.goTo(p2.page);
    await wait(600);
    flow = viewFlow(p2.page, p2.shape);
    check('page 2 shows part of the story', !!flow && flow.textContent.length > 5);
    T.startEdit(p2.page, p2.shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
    await wait(100);
    document.execCommand('insertText', false, 'QQQ ');
    await wait(100);
    T.commitEdit();
    await wait(300);
    check('the typing on page 2 goes into the story', textOf(story()).includes('QQQ '), textOf(story()).slice(-120));
    T.undo();
    await wait(400);
    check('Undo takes it out of the story again', textOf(story()) === before, textOf(story()).length - before.length);
    T.redo();
    await wait(400);

    // ---- formatting a selection in the second box on page 1
    T.goTo(0);
    await wait(500);
    const second = bySeq(306);
    flow = viewFlow(second.page, second.shape);
    T.startEdit(second.page, second.shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 4 } });
    await wait(100);
    const word = String(window.getSelection());
    T.format({ bold: true });
    await wait(300);
    const boldRuns = story().flatMap((p) => p.runs).filter((r) => r.bold).map((r) => r.text).join('');
    check('Bold on text in a linked box changes the story', boldRuns.length > 0 && word.startsWith(boldRuns.slice(0, 2)), [word, boldRuns]);
    check('...and typing carries on in that box', T.state().editing);
    T.commitEdit();
    T.undo();
    await wait(300);
    check('...and Undo takes the bold off', !story().flatMap((p) => p.runs).some((r) => r.bold));

    // ---- Find shows a match in the part of the story on page 2
    T.goTo(0);
    await wait(300);
    const m = T.findMatches('QQQ', true);
    check('Find finds text in the story', m.length === 1, m.length);
    if (m.length) {
      T.showFind(false);
      document.getElementById('findq').value = 'QQQ';
      T.findNext();
      await wait(500);
      check('...and goes to page 2, where it is shown', T.state().current === p2.page && T.state().sel && T.state().sel.shape.seq === 307, [T.state().current, T.state().sel && T.state().sel.shape.seq]);
      const hl = CSS.highlights && CSS.highlights.get('op-find');
      const r = hl && [...hl][0];
      check('...with the text marked', !!r && String(r) === 'QQQ', r && String(r));
      T.hideFind();
    }

    // ---- copies of linked boxes don't join the story
    const storyBefore = textOf(story());
    T.goTo(0);
    await wait(300);
    T.select(0, bySeq(306).shape);
    T.duplicate();
    await wait(400);
    check('a copy of a linked box leaves the story as it was', textOf(story()) === storyBefore);
    const copy = T.state().sel.shape;
    check('...and holds the text its original showed', copy.text.paras.length > 0 && !copy.text.chain && copy.text.story !== 84, [copy.text.paras.length, copy.text.chain, copy.text.story]);
    T.undo();
    await wait(300);
    T.goTo(0);
    await wait(300);
    T.duplicatePage();
    await wait(800);
    const chains = OpenPub.storyChains(T.doc());
    const orig = chains.get(84);
    check('after Duplicate page the story still runs through its own 3 boxes', orig && orig.length === 3 && orig.map((f) => f.shape.seq).join() === '305,306,307', orig && orig.map((f) => [f.page, f.shape.seq]));
    const copies = [...chains.entries()].filter(([id]) => id !== 84 && id !== 88);
    check('...and the copied boxes form chains of their own', copies.length === 2 && copies.every(([, fr]) => fr.every((f) => f.page === 1)), copies.map(([id, fr]) => [id, fr.map((f) => f.page)]));
    T.undo();
    await wait(400);
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
