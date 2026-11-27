// Automated checks that unsaved work isn't lost and of the editing fixes made in 0.3.0, run inside
// a debug build:
//   openpub.exe <file.pub> --eval=tools/safetytest.js
// Works on any publication (it adds its own text boxes). Prints OK / FAIL lines and a SUMMARY line.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const rustDirty = async () => (await (await fetch('state.json?v=' + Date.now())).json()).dirty;
const flowOf = (page, shape) => [...T.shapeEl(page, shape).querySelectorAll('.op-flow')].find((f) => f.opOwner === shape.text);
const lastShape = (page) => T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1];
const typeInto = async (page, shape, text, at) => {
  T.startEdit(page, shape, flowOf(page, shape), null, at || { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
  await wait(100);
  document.execCommand('insertText', false, text);
  await wait(150);
};
/** A text box on the current page holding these paragraphs (lists of runs). */
const makeBox = async (paras) => {
  const page = T.state().current;
  T.addText();
  await wait(250);
  T.commitEdit();
  const shape = lastShape(page);
  const base = shape.text.paras[0].runs[0];
  shape.text.paras = paras.map((runs) => Object.assign({}, shape.text.paras[0], { runs: runs.map((r) => Object.assign({}, base, typeof r === 'string' ? { text: r } : r)) }));
  shape.h = 120;
  shape.w = 300;
  T.select(page, shape);
  T.format({ italic: false }); // redraws the page
  await wait(250);
  return { page, shape };
};

(async () => {
  try {
    // ---- typing counts as an unsaved change at once
    let { page, shape } = await makeBox([['Hello world']]);
    T.clean(); // as if the document had just been saved
    await wait(100);
    await typeInto(page, shape, 'abc ');
    check('typing marks the document unsaved before it is committed', T.state().editing && T.state().dirty, T.state());
    await wait(150);
    check('...and the window knows (it asks before closing)', await rustDirty());
    T.commitEdit();
    await wait(200);
    check('the typing is kept', textOf(shape.text).startsWith('abc Hello'), textOf(shape.text));

    // ---- Undo while typing undoes the typing only
    const before = T.doc().pages[page].shapes.length;
    T.addBasic('rect');
    await wait(200);
    const n1 = T.doc().pages[page].shapes.length;
    shape = T.doc().pages[page].shapes.find((s) => s.text && textOf(s.text).startsWith('abc Hello'));
    await typeInto(page, shape, 'XYZ');
    T.undo();
    await wait(250);
    shape = T.doc().pages[page].shapes.find((s) => s.text && textOf(s.text).includes('Hello'));
    check('Undo while typing takes back the typing', shape && !textOf(shape.text).includes('XYZ'), shape && textOf(shape.text));
    check('...and not the step before it', T.doc().pages[page].shapes.length === n1, [before, n1, T.doc().pages[page].shapes.length]);
    T.redo();
    await wait(250);
    shape = T.doc().pages[page].shapes.find((s) => s.text && textOf(s.text).includes('Hello'));
    check('Redo brings the typing back', shape && textOf(shape.text).includes('XYZ'), shape && textOf(shape.text));

    // ---- the page can't be reloaded (that would lose the changes)
    window.__alive = 1;
    location.reload();
    await wait(1500);
    check('the page refuses to reload', window.__alive === 1);

    // ---- a file that fails to open leaves the unsaved changes marked as unsaved
    T.send({ cmd: 'testAnswer', value: true });
    T.send({ cmd: 'openPath', path: OPENPUB_OUT + 'safetytest-missing.pub' });
    await wait(2500);
    check('after a failed Open the document is still there', T.doc().pages[page].shapes.some((s) => s.text && textOf(s.text).includes('XYZ')));
    check('...and still counts as unsaved', (await rustDirty()) && T.state().dirty);

    // ---- a design that is declined doesn't come back later
    T.send({ cmd: 'testAnswer', value: false });
    T.send({ cmd: 'new', width: 595.276, height: 841.89, template: 'flyer' });
    await wait(1200);
    check('declining "lose the changes?" keeps the document', T.doc().pages[page].shapes.some((s) => s.text && textOf(s.text).includes('XYZ')));
    T.send({ cmd: 'testAnswer', value: true });
    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(2000);
    check('the next blank publication is blank', T.doc().pages.length === 1 && T.doc().pages[0].shapes.length === 0, T.doc().pages.map((p) => p.shapes.length));
    check('...and is not marked unsaved', !T.state().dirty && !(await rustDirty()));
    T.send({ cmd: 'new', width: 595.276, height: 841.89, template: 'flyer' });
    await wait(2000);
    check('choosing a design still works', T.doc().pages[0].shapes.length > 0);
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
