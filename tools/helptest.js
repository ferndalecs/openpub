// Automated checks of the help page, the table grid, the ready-made designs, the page sizes and
// the tooltips (0.3.4). Run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/helptest.js
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
const key = (k, more) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, more || {})));

(async () => {
  try {
    // ---- help
    key('F1');
    await wait(200);
    check('F1 opens the help page', !$('file').hidden && !$('fp-help').hidden);
    check('...with how-to notes and the keyboard shortcuts', document.querySelectorAll('#fp-help .howto > div').length >= 10 && document.querySelectorAll('#fp-help .keys tr').length >= 10);
    key('Escape');
    await wait(200);
    check('Esc goes back to the publication', $('file').hidden);
    $('helpbtn').click();
    await wait(200);
    check('the ? button opens it too', !$('file').hidden && !$('fp-help').hidden);
    key('Escape');
    await wait(200);

    // ---- every button says what it does
    const silent = [...document.querySelectorAll('#bar button, #file button, #findbar button')].filter((b) => !b.title && b.getAttribute('role') !== 'tab' && !b.closest('.tblgrid') && !b.closest('.rows'));
    check('every button in the ribbon and the File screen has a tooltip', silent.length === 0, silent.map((b) => b.id || b.textContent.trim()).slice(0, 12));

    // ---- a table by pointing at its size
    const page = T.state().current;
    const shapes = () => T.doc().pages[page].shapes;
    T.showTab('insert');
    $('addtable').click();
    await wait(100);
    const cells = [...$('tblgrid').querySelectorAll('button')];
    check('the table menu shows a grid to point at', !$('tblpop').hidden && cells.length === 80, cells.length);
    const target = cells.find((b) => b.opR === 2 && b.opC === 3);
    target.dispatchEvent(new MouseEvent('mouseenter'));
    check('pointing shows the size', $('tblgridlabel').textContent.startsWith('3 × 4') && cells.filter((b) => b.classList.contains('on')).length === 12, $('tblgridlabel').textContent);
    const n0 = shapes().length;
    target.click();
    await wait(300);
    const t = shapes()[shapes().length - 1];
    check('clicking inserts a table of that size', shapes().length === n0 + 1 && t.kind === 'table' && t.table.rows.length === 3 && t.table.cols.length === 4, t && t.table && [t.table.rows.length, t.table.cols.length]);

    // ---- page sizes
    T.showTab('page');
    $('pgsize').value = 'a6';
    $('pgsize').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);
    const mm = (v) => Math.round(v * 25.4 / 72);
    check('A6 postcard is one of the page sizes', [mm(T.doc().width), mm(T.doc().height)].sort().join() === '105,148', [mm(T.doc().width), mm(T.doc().height)]);

    // ---- every design opens with all its text showing
    T.send({ cmd: 'testAnswer', value: true });
    // (each opened as a person would: from its card on File > New, at its own page size)
    for (const id of ['Event flyer', 'Newsletter', 'Certificate', 'Notice or poster', 'Folded leaflet', 'Greeting card', 'Project cover']) {
      key('n', { ctrlKey: true });
      await wait(200);
      const card = [...document.querySelectorAll('#tplcards .card')].find((c) => c.querySelector('b').textContent === id);
      if (!card) { check(`the "${id}" design is offered`, false); continue; }
      card.click();
      await wait(1600);
      const pages = T.doc().pages.length;
      let over = 0;
      for (let i = 0; i < pages; i++) {
        T.goTo(i);
        await wait(300);
        over += T.sheets()[i].el.querySelectorAll('.ovf').length;
      }
      const shapesN = T.doc().pages.reduce((n, p) => n + p.shapes.length, 0);
      check(`the "${id}" design opens (${pages} page${pages > 1 ? 's' : ''}) with all its text showing`, shapesN > 3 && over === 0, { pages, shapesN, over });
    }
    const designs = [...document.querySelectorAll('#tplcards .card b')].map((b) => b.textContent);
    T.send({ cmd: 'dirty', value: false });
    key('n', { ctrlKey: true });
    await wait(300);
    const names = [...document.querySelectorAll('#tplcards .card b')].map((b) => b.textContent);
    check('New offers the new designs', ['Folded leaflet', 'Greeting card', 'Project cover'].every((n) => names.includes(n)), names.concat(designs).slice(0, 10));
    const sizes = [...document.querySelectorAll('#newcards .card b')].map((b) => b.textContent);
    check('...and the new page sizes', ['A2 poster', 'A6 postcard', 'DL leaflet', 'Business card'].every((n) => sizes.includes(n)), sizes);
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
