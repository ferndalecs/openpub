// Symbols, Welsh letters and page numbers (0.3.27): Insert > Symbol puts a symbol where the cursor
// is (page text or WordArt words); Word's accent keys work while typing (Ctrl+Shift+6 then w: ŵ);
// Insert > Page number at the cursor, or in a box at the foot of the page. Run inside a debug build:
//   openpub.exe samples/Worksheet_8.pub --eval=tools/symtest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const textOf = (sh) => sh.text.paras.map((p) => p.runs.map((r) => (r.field ? '[' + r.field + ']' : r.text)).join('')).join('\n');
const key = (target, k, code, more) => target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, code, bubbles: true, cancelable: true }, more || {})));
const END = { a: { p: 1e6, o: 1e9 }, b: { p: 1e6, o: 1e9 } };
(async () => {
  try {
    T.goTo(0);
    await wait(300);
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, 'Bore da');
    T.commitEdit();
    await wait(200);
    const shapes = T.doc().pages[0].shapes;
    const box = shapes[shapes.length - 1];
    const flowOf = (sh) => T.shapeEl(0, sh).querySelector('.op-flow');
    const edit = async (sh) => { T.select(0, sh); T.startEdit(0, sh, flowOf(sh), null, END); await wait(100); };

    // the symbols list
    check('Insert has Symbol and Page number', !!$('addsym') && !!$('addpagenum') && $('addsym').closest('#p-insert') && $('addpagenum').closest('#p-insert'));
    await edit(box);
    T.showTab('insert');
    $('addsym').click();
    await wait(100);
    const pop = $('sympop');
    // (after any recently used ones: remembered from earlier runs)
    const heads = [...pop.querySelectorAll('h3')].map((h) => h.textContent).filter((h) => h !== 'Recently used');
    check('Symbol opens a list with the Welsh letters first', !pop.hidden && heads[0] === 'Welsh letters' && [...pop.querySelectorAll('button')].some((b) => b.textContent === 'ŵ'), heads);
    check('...while the text stays being typed in', T.state().editing);
    const w = [...pop.querySelectorAll('button')].find((b) => b.textContent === 'ŵ');
    w.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    w.click();
    await wait(100);
    check('...a click puts the letter in, and the list stays open for another', !pop.hidden && T.state().editing);
    const pound = [...pop.querySelectorAll('button')].find((b) => b.textContent === '£');
    pound.click();
    T.commitEdit();
    await wait(200);
    check('...at the cursor', textOf(box) === 'Bore daŵ£', textOf(box));
    $('addsym').click(); // (closes)
    $('addsym').click(); // (opens again: rebuilt)
    await wait(100);
    check('...and they are listed as recently used', $('sympop').querySelector('h3').textContent === 'Recently used' && $('sympop').querySelector('.cells').textContent.startsWith('£ŵ'), $('sympop').querySelector('.cells').textContent);
    $('addsym').click();

    // Word's accent keys
    await edit(box);
    const f = flowOf(box);
    key(f, '^', 'Digit6', { ctrlKey: true, shiftKey: true }); key(f, 'w', 'KeyW');
    key(f, '^', 'Digit6', { ctrlKey: true, shiftKey: true }); key(f, 'Y', 'KeyY', { shiftKey: true });
    key(f, '\'', 'Quote', { ctrlKey: true }); key(f, 'e', 'KeyE');
    key(f, '`', 'Backquote', { ctrlKey: true }); key(f, 'a', 'KeyA');
    key(f, ':', 'Semicolon', { ctrlKey: true, shiftKey: true }); key(f, 'i', 'KeyI');
    key(f, '^', 'Digit6', { ctrlKey: true, shiftKey: true }); key(f, 'q', 'KeyQ');
    T.commitEdit();
    await wait(200);
    check('Ctrl+Shift+6 then w gives ŵ, then Y gives Ŷ; Ctrl+\' é, Ctrl+` à, Ctrl+Shift+; ï; a letter with no accent stays as it is', textOf(box) === 'Bore daŵ£ŵŶéàïq', textOf(box));

    // a selected box that isn't being typed in: at the end of its text
    T.select(0, box);
    await wait(50);
    T.insertSymbol('★');
    T.commitEdit();
    await wait(200);
    check('with a box selected, at the end of its text', textOf(box).endsWith('★'), textOf(box));
    T.select(0, null);
    check('with nothing selected, it says where to click first', T.insertSymbol('x') === false && /Click in some text first/.test($('notes').textContent));

    // WordArt words
    T.addWordArt();
    await wait(300);
    check('WordArt words are being typed', T.waEditing());
    const ta = document.querySelector('.waedit');
    ta.value = 'Croeso';
    ta.setSelectionRange(6, 6);
    ta.dispatchEvent(new Event('input'));
    T.insertSymbol('ŷ');
    key(ta, '^', 'Digit6', { ctrlKey: true, shiftKey: true }); key(ta, 'a', 'KeyA');
    T.endWordArt();
    await wait(200);
    const wa = T.doc().pages[0].shapes[T.doc().pages[0].shapes.length - 1];
    check('...a symbol and an accent key go into WordArt words too', wa.wordart && wa.wordart.text === 'Croesoŷâ', wa.wordart && wa.wordart.text);

    // page numbers
    await edit(box);
    T.insertPageNumber();
    T.commitEdit();
    await wait(200);
    check('Page number while typing: a page-number field at the cursor', textOf(box).endsWith('[page]'), textOf(box));
    check('...shown as the page\'s number', /1$/.test(T.shapeEl(0, box).textContent.trim()), T.shapeEl(0, box).textContent.slice(-10));
    T.select(0, null);
    const n = T.doc().pages[0].shapes.length, u = T.state().undo;
    T.insertPageNumber();
    await wait(300);
    const pn = T.doc().pages[0].shapes[T.doc().pages[0].shapes.length - 1];
    check('...with nothing being typed: a box at the foot of the page, centred', T.doc().pages[0].shapes.length === n + 1 && pn.text.paras[0].align === 'center' && pn.text.paras[0].runs[0].field === 'page' && pn.y > T.doc().height * 0.9);
    check('...one undo step', T.state().undo === u + 1);
    check('...and a tip about numbering every page', /master page/.test($('notes').textContent));
  } catch (e) {
    check('no error', false, String(e && e.stack || e));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  T.send({ cmd: 'quit' });
})();
