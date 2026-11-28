// Shadows (0.3.25): drawn as a recoloured copy of the shape behind it wherever that is exact
// (WordArt, filled shapes and text boxes, lines), so they reach PDFs and printers as drawing;
// the CSS filter only for the rest (text with nothing behind it, see-through pictures). Before,
// printing and PDFs left every shadow out. Run inside a debug build on the shapes probe:
//   openpub.exe samples/probe/probe-shapes.pub --eval=tools/shadowtest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const shadowed = () => [...document.querySelectorAll('#pages .op-shape')].filter((e) => e.opShape && e.opShape.shadow);
const kind = (e) => {
  const box = [...e.children].find((c) => c.classList.contains('op-shadow'));
  const filter = /drop-shadow/.test(e.style.filter || '');
  return box && !filter ? 'vector' : filter && !box ? 'filter' : box && filter ? 'both' : 'none';
};
(async () => {
  try {
    await wait(800);
    for (let i = 0; i < T.doc().pages.length; i++) { T.goTo(i); await wait(150); }
    const all = shadowed();
    check('the probe has shadowed shapes on screen', all.length >= 10, all.length);
    check('every shadow is drawn one way or the other, never both', all.every((e) => ['vector', 'filter'].includes(kind(e))), all.map(kind));
    const wa = all.filter((e) => e.opShape.wordart);
    check('WordArt shadows are drawn as a copy of the letters', wa.length && wa.every((e) => kind(e) === 'vector'), wa.map(kind));
    const filled = all.filter((e) => !e.opShape.wordart && e.opShape.fill);
    check('filled shapes too', filled.every((e) => kind(e) === 'vector'), filled.map(kind));
    const bare = all.filter((e) => e.opShape.text && !e.opShape.fill && !e.opShape.wordart);
    check('text with nothing behind it keeps the filter', bare.every((e) => kind(e) === 'filter'), bare.map(kind));
    const e = wa[0];
    const box = [...e.children].find((c) => c.classList.contains('op-shadow'));
    const sh = e.opShape.shadow;
    check('the copy is behind the shape', e.firstElementChild === box);
    check('...offset by the shadow\'s distance', Math.abs(parseFloat(box.style.left) - sh.dx) < 0.01 && Math.abs(parseFloat(box.style.top) - sh.dy) < 0.01, [box.style.left, box.style.top, sh.dx, sh.dy]);
    const painted = [...box.querySelectorAll('text, path, rect, ellipse, polygon')].filter((n) => !n.closest('defs, clipPath, pattern, mask'));
    check('...all in the shadow colour', painted.length && painted.every((n) => n.getAttribute('fill') === sh.color || n.getAttribute('fill') === 'none'), painted.map((n) => n.getAttribute('fill')).slice(0, 5));
    check('...hidden from screen readers', box.getAttribute('aria-hidden') === 'true');
    const semi = all.find((x) => kind(x) === 'vector' && x.opShape.shadow.opacity < 1);
    check('a see-through shadow is see-through as a whole', !semi || Math.abs(parseFloat([...semi.children].find((c) => c.classList.contains('op-shadow')).style.opacity) - semi.opShape.shadow.opacity) < 0.01);

    // printing / PDF: the shadows are still there, and the print styles don't take filters away
    await T.preparePdfPictures();
    const printed = shadowed();
    check('when printing, the same shadows', printed.length === all.length && printed.every((x) => ['vector', 'filter'].includes(kind(x))));
    const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch (err) { return []; } })
      .filter((r) => r.media && /print/.test(r.media.mediaText)).flatMap((r) => [...r.cssRules]).map((r) => r.cssText);
    check('print styles only undo filters in the master-page view', css.filter((t) => /filter:\s*none/.test(t)).every((t) => /master-mode/.test(t)), css.filter((t) => /filter/.test(t)));
    T.printRestore();
  } catch (err) {
    check('no error', false, String(err && err.stack || err));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
