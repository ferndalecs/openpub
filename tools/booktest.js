// Automated checks of patterned fills and booklet printing (0.3.5). Run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/booktest.js
// Writes out/booklet.pdf (checked afterwards: 4 sides of A4 landscape). Prints OK / FAIL lines
// and a SUMMARY line.
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
    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(1500);

    // ---- patterns
    T.addBasic(1);
    await wait(200);
    const r = T.state().sel.shape;
    $('pattern').value = '8040201008040201';
    $('pattern').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    check('a shape can be filled with a pattern', r.fill && r.fill.pattern === '8040201008040201' && r.fill.back === '#ffffff', r.fill);
    const svgPattern = T.shapeEl(0, r).querySelector('pattern');
    check('...drawn as a repeating pattern', !!svgPattern && svgPattern.querySelectorAll('rect').length === 9, svgPattern && svgPattern.querySelectorAll('rect').length);
    T.setFill('#e53935');
    await wait(200);
    check('changing the fill colour keeps the pattern', r.fill.color === '#e53935' && r.fill.pattern === '8040201008040201');
    $('graddir').value = '90';
    $('graddir').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    check('a gradient replaces the pattern', r.fill.color2 && !r.fill.pattern, r.fill);
    $('pattern').value = '';
    $('pattern').dispatchEvent(new Event('change', { bubbles: true }));

    // ---- a 6-page publication as a booklet
    for (let i = 1; i < 6; i++) { T.addPage(); await wait(150); }
    check('six pages', T.doc().pages.length === 6, T.doc().pages.length);
    const plan = T.bookletPlan();
    check('6 pages make 2 sheets (8 pages, 2 of them blank)', plan.n === 8 && plan.sides.length === 4);
    check('...in the order for folding: 8|1, 2|7, 6|3, 4|5', JSON.stringify(plan.sides.map((s) => s.map((i) => i + 1))) === '[[8,1],[2,7],[6,3],[4,5]]', plan.sides);
    check('A4 pages go on A4 paper, printed smaller', Math.abs(plan.paper[0] - 841.89) < 1 && Math.abs(plan.paper[1] - 595.28) < 1 && Math.abs(plan.k - 0.7071) < 0.001, plan);
    await T.prepareBooklet();
    const sides = [...document.querySelectorAll('#printbook-out .bside')];
    // (pages 7 and 8 are the blanks)
    check('the booklet is laid out side by side, ready to print', sides.length === 4 && sides[0].dataset.pages === '8,1' && sides[0].querySelectorAll('.op-page').length === 1 && sides[1].querySelectorAll('.op-page').length === 1 && sides[2].querySelectorAll('.op-page').length === 2, sides.map((s) => s.dataset.pages + ':' + s.querySelectorAll('.op-page').length));
    T.printRestore();
    check('...and taken away afterwards', !document.getElementById('printbook-out') && !document.body.classList.contains('bookprint'));

    // ---- a PDF booklet
    OpenPubApp.test.exportBookletPdf.path = OPENPUB_OUT + 'booklet.pdf';
    T.exportBookletPdf();
    await wait(4000);
    check('a PDF booklet is written (checked by the runner)', !document.getElementById('printbook-out'));
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
