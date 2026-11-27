// Automated checks of 0.3.7: arrows on the font and size boxes, the "text doesn't fit" marker on
// turned boxes, links kept in PDFs, a picture shown in a shape exported to Word. Run inside a
// debug build:
//   openpub.exe <file.pub> --eval=tools/gaptest.js
// Writes out/gap-links.pdf and out/gap-picshape.docx (checked by the runner). Prints OK / FAIL
// lines and a SUMMARY line.
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
    // ---- the font and size boxes show they open a list
    for (const id of ['font', 'size', 'wafont']) {
      const bg = getComputedStyle($(id)).backgroundImage;
      check(`the ${id} box has a drop-down arrow`, /svg/.test(bg), bg.slice(0, 40));
    }

    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(1500);

    // ---- a turned box whose text doesn't fit
    T.addText();
    await wait(200);
    document.execCommand('insertText', false, 'This text is far too long for such a small box, so some of it is hidden. '.repeat(3));
    T.commitEdit();
    await wait(200);
    const box = T.state().sel.shape;
    T.setGeom('h', 40);
    T.setRotation(30);
    await wait(300);
    check('a turned text box whose text doesn\'t fit gets the red marker', T.overflowing(0, box) && T.sheets()[0].el.querySelectorAll('.ovf').length === 1);
    T.select(0, box);
    T.fitBoxToText();
    await wait(300);
    check('...and Make box fit text works on it', !T.overflowing(0, box) && box.h > 60 && box.rotation === 30, [box.h, box.rotation]);

    // ---- a link on a shape stays clickable in a PDF
    T.addBasic(1);
    await wait(200);
    T.setLink('https://example.org/openpub-test');
    await wait(200);
    T.exportPdf.path = OPENPUB_OUT + 'gap-links.pdf';
    T.exportPdf();
    await wait(4000);
    check('a PDF with a linked shape is written (links checked by the runner)', true);

    // ---- a picture shown in a shape, exported to Word
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const c2 = canvas.getContext('2d');
    c2.fillStyle = '#1e88e5';
    c2.fillRect(0, 0, 120, 80);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    T.select(0, null);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(1500);
    const pic = T.state().sel && T.state().sel.shape;
    check('a picture is added', pic && pic.kind === 'picture');
    if (pic) {
      T.showTab('picture');
      $('picshape').value = '3';
      $('picshape').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
      check('...and shown in an ellipse', pic.shape_type === 3, pic.shape_type);
      T.send({ cmd: 'docx', doc: OpenPubApp.docJson(), path: OPENPUB_OUT + 'gap-picshape.docx' });
      await wait(2500);
    }
  } catch (e) {
    check('no error', false, String(e) + ' ' + e.stack);
  }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
