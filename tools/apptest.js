// Automated check of the editor, run inside the app (debug builds):
//   openpub.exe file.pub --eval=tools/apptest.js
// Results are printed by the app as "[page] ..." lines.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = window.OPENPUB_OUT; // <current directory>/out/, set by the app
const doc = T.doc();
log('pages ' + doc.pages.length);

// 1. edit text in the first text box of page 3
T.goTo(2);
await wait(600);
const page = 2;
const shape = doc.pages[page].shapes.find((s) => s.kind === 'text' && !s.from_master);
const before = shape.text.paras[0].runs.map((r) => r.text).join('');
T.select(page, shape);
let flow = T.shapeEl(page, shape).querySelector('.op-flow');
T.startEdit(page, shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
document.execCommand('insertText', false, 'EDITED ');
T.commitEdit();
const after = shape.text.paras[0].runs.map((r) => r.text).join('');
log('text edit: ' + JSON.stringify(before.slice(0, 20)) + ' -> ' + JSON.stringify(after.slice(0, 27)) + ' paras ' + shape.text.paras.length + ' ' + (after === 'EDITED ' + before ? 'OK' : 'FAIL'));

// 2. format part of it: make "EDITED" red and italic
T.select(page, shape);
flow = T.shapeEl(page, shape).querySelector('.op-flow');
T.startEdit(page, shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 6 } });
await wait(50);
T.format({ color: '#cc0000' });
T.format({ italic: true });
T.commitEdit();
const r0 = shape.text.paras[0].runs[0];
log('range format: first run ' + JSON.stringify({ text: r0.text, color: r0.color, italic: r0.italic }) + ' ' + (r0.text === 'EDITED' && r0.color === '#cc0000' && r0.italic ? 'OK' : 'FAIL'));

// 3. new paragraph by typing Enter-equivalent
flow = T.shapeEl(page, shape).querySelector('.op-flow');
const nParas = shape.text.paras.length;
T.startEdit(page, shape, flow, null, { a: { p: 0, o: 6 }, b: { p: 0, o: 6 } });
document.execCommand('insertParagraph');
T.commitEdit();
log('split paragraph: ' + nParas + ' -> ' + shape.text.paras.length + ' ' + (shape.text.paras.length === nParas + 1 ? 'OK' : 'FAIL'));
T.undo();
log('undo: paras ' + T.doc().pages[page].shapes.find((s) => s.seq === shape.seq).text.paras.length);

// 4. drag a shape with the mouse
const pic = T.doc().pages[page].shapes.find((s) => !s.from_master);
const el = T.shapeEl(page, pic);
const rc = el.getBoundingClientRect();
const x0 = pic.x, y0 = pic.y;
const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
ev('pointerdown', rc.left + 10, rc.top + 10);
ev('pointermove', rc.left + 40, rc.top + 30);
ev('pointermove', rc.left + 70, rc.top + 50);
ev('pointerup', rc.left + 70, rc.top + 50);
log('drag: moved by ' + (pic.x - x0).toFixed(1) + ',' + (pic.y - y0).toFixed(1) + ' pt ' + (pic.x > x0 && pic.y > y0 ? 'OK' : 'FAIL'));
T.undo();

// 5. edit a table cell on page 9
T.goTo(8);
await wait(800);
const tbl = T.doc().pages[8].shapes.find((s) => s.kind === 'table');
const cellFlow = [...T.shapeEl(8, tbl).querySelectorAll('.op-flow')][4];
T.select(8, tbl);
T.startEdit(8, tbl, cellFlow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
document.execCommand('insertText', false, 'Baking tray');
T.commitEdit();
log('table cell: ' + JSON.stringify(tbl.table.cells[4].paras[0].runs.map((r) => r.text).join('')) + ' ' + (tbl.table.cells[4].paras[0].runs.map((r) => r.text).join('').startsWith('Baking tray') ? 'OK' : 'FAIL'));

// 6. insert things on page 13 (nearly empty)
T.goTo(12);
await wait(500);
T.addText();
document.execCommand('insertText', false, 'A new text box added in OpenPub');
T.commitEdit();
T.format({ size: 20 });
T.format({ bold: true });
T.addBasic(3);
log('insert: page 13 has ' + T.doc().pages[12].shapes.filter((s) => !s.from_master).length + ' own shapes; state ' + JSON.stringify(T.state().undo));

// 7. save, reopen later, export
T.send({ cmd: 'save', doc: OpenPubApp.docJson(), path: out + 'test.opub' });
T.send({ cmd: 'docx', doc: OpenPubApp.docJson(), path: out + 'test.docx' });
await wait(4000);
T.exportPdf.path = out + 'test.pdf';
T.exportPdf();
await wait(12000);
log('done');
T.goTo(12);
