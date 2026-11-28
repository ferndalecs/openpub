// PDF export (0.3.18): pictures go into the PDF only as large as they are shown (220 dpi), not at
// the camera's size. Run inside a debug build on the Year 7 booklet (photos of 1600 pixels shown
// 2 cm wide):
//   openpub.exe samples/year7-booklet.pub --eval=tools/pdftest.js
// Writes out/pdf-y7.pdf; the runner checks its size (under 5 MB; it was 40 MB).
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
(async () => {
  try {
    await wait(1000);
    T.exportPdf.path = OPENPUB_OUT + 'pdf-y7.pdf';
    T.exportPdf();
    await wait(300);
    // while the PDF is made, the pictures are asked for at the size they are shown
    const srcs = [...document.querySelectorAll('#pages img')].map((i) => i.getAttribute('src') || '');
    const sized = srcs.filter((s) => /[?&]max=\d+/.test(s));
    check('pictures are asked for at the size they are shown', sized.length >= 20, [sized.length, srcs.length]);
    const m = sized.map((s) => +s.match(/max=(\d+)/)[1]);
    check('...small ones small (a photo 2 cm wide: a couple of hundred pixels)', m.length && Math.min(...m) < 300, Math.min(...m));
    for (let i = 0; i < 1800 && T.state().busy; i++) await wait(100);
    check('the export finishes', !T.state().busy);
    const after = [...document.querySelectorAll('#pages img')].map((i) => i.getAttribute('src') || '');
    check('...and the page shows the full pictures again', after.length > 0 && after.every((s) => !/max=/.test(s)), after.filter((s) => /max=/.test(s)).length);
  } catch (e) {
    check('no error', false, String(e && e.stack || e));
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
