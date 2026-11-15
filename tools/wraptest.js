// Automated check that text flowing on both sides of a shape survives editing, run inside a debug
// build on a publication whose current page has such a frame (samples/probe/probe-wrap.pub page 3):
//   openpub.exe samples/probe/probe-wrap.pub --eval=tools/wraptest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');

(async () => {
  const page = 2;
  T.goTo(page);
  await wait(1200);
  const sheet = T.sheets()[page].el;
  const flow = [...sheet.querySelectorAll('.op-flow')].find((f) => f.querySelector('.op-gap'));
  check('a frame on this page has text on both sides of a shape', !!flow);
  if (!flow) { log(`SUMMARY ${okN} OK, ${failN} FAIL`); window.ipc.postMessage(JSON.stringify({ cmd: 'quit' })); return; }
  const shape = flow.closest('.op-shape').opShape;
  const before = textOf(shape.text), runsBefore = JSON.stringify(shape.text.paras);
  const gaps = flow.querySelectorAll('.op-gap').length;
  // each line beside the shape has text left and right of it
  const k = sheet.getBoundingClientRect().width / T.doc().width;
  const fr = flow.getBoundingClientRect();
  const sides = [...flow.querySelectorAll('.op-gap')].map((g) => {
    const r = g.getClientRects()[0];
    return r ? [(r.left - fr.left) / k, (r.right - fr.left) / k] : null;
  }).filter(Boolean);
  check('the spacers span the shape', gaps >= 5 && sides.every(([a, b]) => b - a > 20), sides.slice(0, 3));

  // open it for editing and close it again: nothing changes
  const undo0 = T.state().undo;
  T.select(page, shape);
  T.startEdit(page, shape, flow);
  await wait(300);
  T.commitEdit();
  await wait(400);
  check('opening and closing the text changes nothing', textOf(shape.text) === before && JSON.stringify(shape.text.paras) === runsBefore && T.state().undo === undo0, [textOf(shape.text) === before, T.state().undo - undo0]);

  // type at the start: the text is read back without the spacers, and laid out again around the shape
  const flow2 = [...T.sheets()[page].el.querySelectorAll('.op-flow')].find((f) => f.opOwner === shape.text);
  T.startEdit(page, shape, flow2, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
  await wait(200);
  document.execCommand('insertText', false, 'EDITED ');
  await wait(200);
  T.commitEdit();
  await wait(500);
  check('typed text is read back cleanly', textOf(shape.text) === 'EDITED ' + before, textOf(shape.text).slice(0, 40));
  const flow3 = [...T.sheets()[page].el.querySelectorAll('.op-flow')].find((f) => f.opOwner === shape.text);
  check('and still flows on both sides', flow3 && flow3.querySelectorAll('.op-gap').length >= 5);
  T.undo();
  await wait(400);
  const again = T.doc().pages[page].shapes.find((s) => s.seq === shape.seq);
  check('Undo restores it', textOf(again.text) === before);

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
