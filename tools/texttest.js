// Automated checks of text editing on the page (0.3.1): the font and size lists, WordArt words
// typed on the page, typing into a selected box, spelling, and text that doesn't fit its box.
// Run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/texttest.js
// Works on any publication (it adds its own boxes). Prints OK / FAIL lines and a SUMMARY line.
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
const key = (target, k, more) => target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, more || {})));
const LONG = 'Our class trip to the science museum was the best day of the year. We saw rockets, robots and a real dinosaur skeleton. ';

(async () => {
  try {
    const page = T.state().current;
    const shapes = () => T.doc().pages[page].shapes;
    const last = () => shapes()[shapes().length - 1];

    // ---- the fonts installed on this computer
    const fonts = await (await fetch('fonts.json')).json();
    check('the program lists the fonts on this computer', Array.isArray(fonts) && fonts.length > 20 && fonts.includes('Arial'), fonts.length);

    // ---- a box to work on
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, 'Hello there');
    T.commitEdit();
    await wait(200);
    const box = last();
    T.select(page, box);
    await wait(100);

    // ---- the font list: type part of a name, pick it
    const font = $('font');
    font.focus();
    await wait(300);
    check('clicking the font box opens the list', !$('pickpop').hidden && T.pickRows().length > 20, T.pickRows().length);
    font.value = 'comic';
    font.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(100);
    check('typing part of a name narrows the list', T.pickRows().length >= 1 && T.pickRows().every((n) => n.toLowerCase().includes('comic')), T.pickRows());
    const undo0 = T.state().undo;
    key(font, 'Enter');
    await wait(300);
    check('Enter uses the font picked from the list', box.text.paras[0].runs.every((r) => r.font === 'Comic Sans MS'), box.text.paras[0].runs.map((r) => r.font));
    check('...as one undo step, and the list closes', T.state().undo === undo0 + 1 && $('pickpop').hidden, [T.state().undo - undo0, $('pickpop').hidden]);
    const row = [...$('pickpop').querySelectorAll('.pr')][0];
    T.openPick(font, '');
    await wait(400);
    const drawn = [...$('pickpop').querySelectorAll('.pr')].filter((d) => d.style.fontFamily).length;
    check('fonts in view are shown in their own lettering', drawn > 3, drawn);
    T.closePick();
    font.blur();

    // ---- the size list
    T.select(page, box);
    const size = $('size');
    size.focus();
    await wait(200);
    check('the size list offers common sizes', T.pickRows().includes('12') && T.pickRows().includes('72'), T.pickRows());
    size.value = '14,5';
    key(size, 'Enter');
    await wait(300);
    check('a size typed with a comma is used', box.text.paras[0].runs.every((r) => r.size === 14.5), box.text.paras[0].runs.map((r) => r.size));

    // ---- typing with a box selected types into it
    T.select(page, box);
    await wait(100);
    key(document.getElementById('view'), 'X');
    await wait(200);
    check('a letter typed with a box selected starts typing in it', T.state().editing);
    T.commitEdit();
    await wait(200);
    check('...at the end of its text', textOf(box.text) === 'Hello thereX', textOf(box.text));

    // ---- spelling
    const flow = [...T.shapeEl(page, box).querySelectorAll('.op-flow')][0];
    T.startEdit(page, box, flow);
    await wait(100);
    check('spelling is checked while typing', flow.spellcheck === true);
    T.commitEdit();

    // ---- an empty text box says how to type in it
    T.addText();
    await wait(200);
    T.commitEdit();
    await wait(200);
    const empty = last();
    const ef = T.shapeEl(page, empty).querySelector('.op-flow');
    check('an empty text box shows "Double-click to type"', ef.classList.contains('op-blank') && getComputedStyle(ef, '::after').content.includes('Double-click'), getComputedStyle(ef, '::after').content);
    T.select(page, empty);
    T.removeSelected();
    await wait(200);

    // ---- WordArt: the words are typed on the page
    T.showTab('insert');
    $('addwa').click();
    await wait(400);
    let ta = document.querySelector('.waedit');
    const wa = last();
    check('Insert WordArt opens a box on the page to type the words', !!ta && document.activeElement === ta && ta.value === 'Your text');
    const u1 = T.state().undo;
    ta.value = 'Sports\nDay';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    const svgText = () => [...T.shapeEl(page, wa).querySelectorAll('svg text')].map((t) => t.textContent).join('|');
    check('the WordArt follows the typing', wa.wordart.text === 'Sports\nDay' && svgText() === 'Sports|Day', svgText());
    key(ta, 'Escape');
    await wait(300);
    check('Esc finishes: the box goes', !document.querySelector('.waedit') && wa.wordart.text === 'Sports\nDay');
    check('...and the change is one undo step', T.state().undo === u1 + 1, T.state().undo - u1);
    T.undo();
    await wait(300);
    const wa2 = last();
    check('Undo brings the old words back', wa2.wordart && wa2.wordart.text === 'Your text', wa2.wordart && wa2.wordart.text);
    // double-click
    const r = T.shapeEl(page, wa2).getBoundingClientRect();
    T.shapeEl(page, wa2).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await wait(300);
    ta = document.querySelector('.waedit');
    check('double-clicking WordArt opens its words', !!ta && ta.value === 'Your text');
    ta.blur();
    await wait(300);
    check('clicking away finishes', !document.querySelector('.waedit'));
    // typing with WordArt selected replaces its words
    T.select(page, wa2);
    key(document.getElementById('view'), 'H');
    await wait(300);
    ta = document.querySelector('.waedit');
    check('a letter typed with WordArt selected starts its words afresh', !!ta && ta.value === 'H' && wa2.wordart.text === 'H', ta && ta.value);
    key(ta, 'Escape');
    await wait(300);
    check('the WordArt ribbon has an Edit text button', !$('waedit').disabled);

    // ---- text that doesn't fit
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, LONG.repeat(3));
    T.commitEdit();
    await wait(200);
    const over = last();
    T.select(page, over);
    T.setGeom('h', 40);
    await wait(300);
    const sheetEl = T.sheets()[page].el;
    check('a box whose text doesn\'t fit gets a red marker', T.overflowing(page, over) && sheetEl.querySelectorAll('.ovf').length >= 1);
    check('...and the status bar says so', $('selinfo').textContent.includes("doesn't fit"), $('selinfo').textContent);
    check('...and the fit buttons are on', !$('fitbox').disabled && !$('fittext').disabled);
    const u2 = T.state().undo;
    T.fitBoxToText();
    await wait(300);
    check('Make box fit text makes it tall enough', !T.overflowing(page, over) && over.h > 60, over.h);
    check('...in one undo step', T.state().undo === u2 + 1);
    T.undo();
    await wait(300);
    const o2 = last();
    check('Undo puts the size back', Math.abs(o2.h - 40) < 0.01 && T.overflowing(page, o2), o2.h);
    T.select(page, o2);
    T.shrinkTextToFit();
    await wait(300);
    const sizes = o2.text.paras.flatMap((p) => p.runs.map((r) => r.size));
    check('Shrink text to fit makes it fit', !T.overflowing(page, o2), sizes);
    check('...in half-point steps, not below 6 pt', sizes.every((s) => s >= 6 && Math.abs(s * 2 - Math.round(s * 2)) < 1e-9), sizes);
    check('the marker goes once the text fits', !sheetEl.querySelector('.ovf'));
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
