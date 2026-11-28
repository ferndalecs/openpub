// Smaller PDFs of see-through pictures (0.3.24): a painting cut out from its background goes into
// a PDF as a JPEG with a mask (CSS mask-image) instead of a picture stored without loss. Run
// inside a debug build on the Cymru textbook (watercolours with see-through backgrounds):
//   openpub.exe "samples/Cymru Textbook (1).pub" --eval=tools/splittest.js
// Writes out/pdf-cymru.pdf; the runner checks its size (16.5 MB before).
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const imgs = () => [...document.querySelectorAll('#pages img')];
const masked = () => imgs().filter((i) => /part=mask/.test(i.style.webkitMask || i.style.mask || ''));
(async () => {
  try {
    await wait(1000);
    check('on screen, no picture has a mask', masked().length === 0);
    await T.preparePdfPictures();
    const split = T.pdfSplit();
    check('some see-through paintings are sent as a JPEG and a mask', split && split.size >= 10, split && split.size);
    const m = masked();
    check('...each drawn with its mask', m.length >= split.size, [m.length, split.size]);
    check('...the JPEG half asked for', m.every((i) => /part=color/.test(i.src) && /max=\d+/.test(i.src)), m.map((i) => i.src).slice(0, 3));
    await Promise.all(m.map((i) => i.decode().catch(() => {})));
    check('...and loaded', m.every((i) => i.complete && i.naturalWidth > 0));
    const r = await fetch(m[0].src);
    check('the colour half is a JPEG', r.headers.get('content-type') === 'image/jpeg');
    const mr = await fetch(m[0].src.replace('part=color', 'part=mask'));
    check('the mask is a PNG', mr.headers.get('content-type') === 'image/png');
    check('cartoons and screenshots are not split (they stay sharp)', imgs().some((i) => /max=/.test(i.src) && !/part=/.test(i.src)));
    T.printRestore();
    await wait(300);
    check('afterwards no masks and the full pictures', masked().length === 0 && imgs().every((i) => !/max=|part=/.test(i.src)) && T.pdfSplit() === null);

    // the PDF itself
    T.exportPdf.path = OPENPUB_OUT + 'pdf-cymru.pdf';
    T.exportPdf();
    for (let i = 0; i < 100 && !T.state().busy; i++) await wait(50);
    for (let i = 0; i < 1800 && T.state().busy; i++) await wait(100);
    check('the PDF is made', !T.state().busy);
  } catch (e) {
    check('no error', false, String(e && e.stack || e));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
