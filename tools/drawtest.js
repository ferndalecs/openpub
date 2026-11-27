// Automated checks of drawing with the mouse, snapping guides, the right-click menu, colour
// swatches, arrowheads, and pictures added by pasting or dropping (0.3.3). Run inside a debug
// build from the openpub folder:
//   openpub.exe <file.pub> --eval=tools/drawtest.js
// It starts a blank publication of its own. Prints OK / FAIL lines and a SUMMARY line.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.6);
const shapes = () => T.doc().pages[0].shapes;
const last = () => shapes()[shapes().length - 1];
const sheet = () => T.sheets()[0].el;
/** Screen point of a point on page 1 (in points). */
const at = (x, y) => {
  const r = sheet().getBoundingClientRect(), k = r.width / T.doc().width;
  return { clientX: r.left + x * k, clientY: r.top + y * k };
};
const ptr = (type, target, p, more) => target.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true }, p, more || {})));
const pages = () => document.getElementById('pages');
/** A drag on page 1 from one point to another (in points), with the mouse. */
async function dragOnPage(target, a, b, more) {
  ptr('pointerdown', target, at(a[0], a[1]), more);
  for (let i = 1; i <= 4; i++) {
    ptr('pointermove', pages(), at(a[0] + (b[0] - a[0]) * i / 4, a[1] + (b[1] - a[1]) * i / 4), more);
    await wait(20);
  }
  const guides = sheet().querySelectorAll('.snapline').length;
  ptr('pointerup', pages(), at(b[0], b[1]), more);
  await wait(250);
  return guides;
}

(async () => {
  try {
    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(1800);
    check('a blank publication to draw on', shapes().length === 0);

    // ---- drawing with the mouse
    $('addrect').click();
    check('choosing Rectangle picks up a drawing tool and says what to do', T.tool() && T.tool().type === 1 && !$('toolhint').hidden && document.body.classList.contains('drawing'));
    const u0 = T.state().undo;
    await dragOnPage(sheet(), [100, 100], [300, 220], { altKey: true });
    const r = last();
    check('dragging on the page draws it at that size', r && r.shape_type === 1 && near(r.x, 100) && near(r.y, 100) && near(r.w, 200) && near(r.h, 120), r && [r.x, r.y, r.w, r.h]);
    check('...as one undo step, and the tool is put down', T.state().undo === u0 + 1 && !T.tool() && $('toolhint').hidden, [T.state().undo - u0, T.tool()]);
    $('addtext').click();
    await dragOnPage(sheet(), [300, 500], [300, 500], { altKey: true });
    const tb = last();
    check('a click with the text tool puts a text box of the usual size there, ready to type', tb.kind === 'text' && near(tb.w, 220) && near(tb.x + tb.w / 2, 300) && near(tb.y + tb.h / 2, 500) && T.state().editing, tb && [tb.x, tb.y, tb.w, tb.h]);
    T.commitEdit();
    T.armTool('shape', 3, 'an ellipse');
    document.getElementById('view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Esc puts the tool down without adding anything', !T.tool() && last() === tb);
    $('addline').click();
    await dragOnPage(sheet(), [400, 300], [250, 200], { altKey: true });
    const ln = last();
    check('a line drawn up and to the left goes from where the drag started', ln.kind === 'line' && ln.flip_h && ln.flip_v && near(ln.x, 250) && near(ln.w, 150) && near(ln.h, 100), ln && [ln.x, ln.y, ln.w, ln.h, ln.flip_h, ln.flip_v]);
    $('addline').click();
    await dragOnPage(sheet(), [100, 700], [260, 712], { altKey: true, shiftKey: true });
    const flat = last();
    check('Shift keeps a line level (45° steps)', flat.kind === 'line' && near(flat.h, 0, 0.01) && flat.w > 150, flat && [flat.w, flat.h]);

    // ---- arrowheads
    T.select(0, flat);
    $('arrows').value = 'end';
    $('arrows').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    check('a line can be given an arrowhead', flat.line.end_arrow === 1 && !flat.line.start_arrow && !$('arrows').disabled);
    T.select(0, r);
    check('...and the arrow list is off for shapes that aren\'t lines', $('arrows').disabled);

    // ---- snapping while moving
    T.select(0, r);
    await wait(100);
    const el = T.shapeEl(0, r);
    const k = sheet().getBoundingClientRect().width / T.doc().width;
    // drag its left edge to 3 screen pixels from the 1.27 cm margin (36 pt)
    const dx = 36 + 3 / k - r.x;
    const g = await dragOnPage(el, [r.x + 20, r.y + 20], [r.x + 20 + dx, r.y + 20 + 0.5]);
    check('moving a shape near the page margin lines it up exactly', near(r.x, 36, 0.01), r.x);
    check('...with a guide shown while moving, gone afterwards', g >= 1 && !sheet().querySelector('.snapline'), g);
    const x1 = r.x;
    // (5 screen pixels: enough to count as a drag, close enough to the margin to snap without Alt)
    await dragOnPage(T.shapeEl(0, r), [r.x + 20, r.y + 20], [r.x + 20 + 5 / k, r.y + 20], { altKey: true });
    check('Alt places it freely', near(r.x, x1 + 5 / k, 0.05) && !near(r.x, 36, 0.01), r.x);
    // sizing: the right edge snaps to the page centre
    T.select(0, r);
    await wait(100);
    const he = document.querySelector('.selbox .h.e');
    const cx = T.doc().width / 2;
    await dragOnPage(he, [r.x + r.w, r.y + r.h / 2], [cx + 2 / k, r.y + r.h / 2]);
    check('a side dragged near the page centre stops on it', near(r.x + r.w, cx, 0.01), r.x + r.w);

    // ---- the right-click menu
    T.select(0, null);
    const re = T.shapeEl(0, r);
    re.dispatchEvent(new MouseEvent('contextmenu', Object.assign({ bubbles: true, cancelable: true }, at(r.x + 10, r.y + 10))));
    await wait(100);
    const items = [...$('ctxmenu').querySelectorAll('button')].map((b) => b.firstChild.textContent);
    check('right-clicking a shape selects it and shows a menu', !$('ctxmenu').hidden && T.state().sel && T.state().sel.shape === r && ['Cut', 'Copy', 'Paste', 'Delete', 'Bring to front'].every((x) => items.includes(x)), items);
    const n0 = shapes().length;
    [...$('ctxmenu').querySelectorAll('button')].find((b) => b.firstChild.textContent === 'Duplicate').click();
    await wait(200);
    check('...whose items work (Duplicate)', shapes().length === n0 + 1 && $('ctxmenu').hidden);
    sheet().dispatchEvent(new MouseEvent('contextmenu', Object.assign({ bubbles: true, cancelable: true }, at(450, 780))));
    await wait(100);
    const items2 = [...$('ctxmenu').querySelectorAll('button')].map((b) => b.firstChild.textContent);
    check('right-clicking the empty page offers Paste and adding a text box there', items2.includes('Paste') && items2.includes('Add a text box here'), items2);
    [...$('ctxmenu').querySelectorAll('button')].find((b) => b.firstChild.textContent === 'Add a text box here').click();
    await wait(300);
    check('...which adds one where the page was clicked', last().kind === 'text' && near(last().x, 450 - 0, 220) && T.state().editing, [last().x, last().y]);
    T.commitEdit();

    // ---- colour swatches
    T.select(0, r);
    await wait(100);
    $('fill').click();
    await wait(100);
    const sw = [...$('swatchpop').querySelectorAll('.sw button')];
    check('the fill colour box opens a palette', !$('swatchpop').hidden && sw.length >= 50, sw.length);
    sw.find((b) => b.title === '#43a047').click();
    await wait(200);
    check('choosing a colour fills the shape with it', r.fill && r.fill.color === '#43a047' && $('swatchpop').hidden, r.fill);
    $('fill').click();
    await wait(100);
    const heads = [...$('swatchpop').querySelectorAll('h4')].map((h) => h.textContent);
    check('...and it is offered again as a recent and a publication colour', heads.includes('Recently used') && heads.includes('In this publication'), heads);
    T.hideSwatches();

    // ---- a picture pasted (a screenshot)
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const c2 = canvas.getContext('2d');
    c2.fillStyle = '#d81b60';
    c2.fillRect(0, 0, 80, 60);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    T.select(0, null);
    const n1 = shapes().length;
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(1500);
    const pic = last();
    check('pasting a picture adds it to the page, selected', shapes().length === n1 + 1 && pic.kind === 'picture' && T.state().sel && T.state().sel.shape === pic, [shapes().length - n1, pic.kind]);
    const resp = pic.image != null ? await fetch('img/' + pic.image + '?t=' + Date.now()) : null;
    check('...and its picture is there', !!resp && resp.ok && /^image\//.test(resp.headers.get('content-type')), resp && resp.status);

    // ---- pictures dropped on the page
    const png = (OPENPUB_OUT.replace(/out\/$/, '') + 'app/assets/openpub.png');
    const n2 = shapes().length, u2 = T.state().undo;
    // (a point in view: a drop is always somewhere visible)
    const vr = document.getElementById('view').getBoundingClientRect(), sr = sheet().getBoundingClientRect(), kk = sr.width / T.doc().width;
    const dropY = Math.max(60, (vr.top - sr.top) / kk + 120);
    const p = at(150, dropY), dpr = window.devicePixelRatio || 1;
    T.send({ cmd: 'addPictureFiles', paths: [png, png], x: p.clientX * dpr, y: p.clientY * dpr });
    await wait(2000);
    const two = shapes().slice(n2);
    check('two picture files dropped on the page add two pictures', two.length === 2 && two.every((s) => s.kind === 'picture'), two.length);
    check('...where they were dropped', two.length === 2 && near(two[0].x + two[0].w / 2, 150, 1) && near(two[0].y + two[0].h / 2, dropY, 1), two[0] && [two[0].x + two[0].w / 2, two[0].y + two[0].h / 2]);
    check('...in one undo step', T.state().undo === u2 + 1);
    T.send({ cmd: 'addPictureFiles', paths: [OPENPUB_OUT.replace(/out\/$/, '') + 'README.md'] });
    await wait(1500);
    check('a file that isn\'t a picture gives a message, and nothing is added', shapes().length === n2 + 2 && !$('notes').hidden, $('notes').textContent);
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
