// Automated check of WordArt, gradient and shadow, links, table styles, picture adjustments, saving
// a page as a picture and the ready-made designs, run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/extratest.js
// Works on any publication (picture checks need one with a picture). Prints OK / FAIL lines and a
// SUMMARY line. Set window.EXTRATEST_STAY = 'shape' | 'new' | a design id to stop there.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const change = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event('change')); };

(async () => {
  const doc = () => T.doc();
  const page = T.state().current;
  const shapes = () => doc().pages[page].shapes;
  const last = () => shapes()[shapes().length - 1];
  const el = (s) => T.shapeEl(page, s);

  // ---- WordArt
  T.showTab('insert');
  $('addwa').click();
  await wait(300);
  check('WordArt is added and its text box has the focus', last().wordart && last().wordart.text === 'Your text' && !$('wagrp').hidden && document.activeElement === $('watext'));
  change('watext', 'Sports Day');
  await wait(250);
  check('typing changes the text', last().wordart.text === 'Sports Day' && el(last()).querySelector('svg text').textContent === 'Sports Day');
  change('wastyle', '144');
  await wait(250);
  check('a shape bends it', last().shape_type === 144 && el(last()).querySelector('svg text').getAttribute('rotate'));
  check('the status bar calls it WordArt', $('selinfo').textContent === 'WordArt', $('selinfo').textContent);

  // ---- gradient and shadow (on the WordArt and on a rectangle)
  T.addBasic(1);
  await wait(300);
  change('fill', '#3366cc');
  await wait(200);
  change('graddir', '90');
  await wait(250);
  check('a gradient blends the fill into a second colour', last().fill.color2 && last().fill.angle === 90 && !!el(last()).querySelector('linearGradient'), last().fill);
  change('fill2', '#ffcc00');
  await wait(250);
  check('the second colour can be chosen', last().fill.color2 === '#ffcc00' && last().fill.color === '#3366cc');
  change('fill', '#112233');
  await wait(250);
  check('changing the fill colour keeps the gradient', last().fill.color === '#112233' && last().fill.color2 === '#ffcc00' && last().fill.angle === 90, last().fill);
  change('graddir', '');
  await wait(250);
  check('No gradient removes it', !last().fill.color2 && !el(last()).querySelector('linearGradient'));
  $('shadowbtn').click();
  await wait(250);
  check('Shadow adds a shadow', last().shadow && last().shadow.dx > 0 && /drop-shadow/.test(el(last()).style.filter) && $('shadowbtn').classList.contains('on'));
  change('shadowcolor', '#336699');
  await wait(250);
  check('in the chosen colour', last().shadow.color === '#336699');
  $('shadowbtn').click();
  await wait(250);
  check('and again removes it', !last().shadow);
  if (window.EXTRATEST_STAY === 'shape') { T.showTab('shape'); T.select(page, shapes()[shapes().length - 2]); return; }

  // ---- links
  check('addresses are tidied', T.normalLink('example.org/page') === 'https://example.org/page' && T.normalLink('someone@example.org') === 'mailto:someone@example.org' && T.normalLink('http://a.example') === 'http://a.example');
  check('anything that is not a web or e-mail address is refused', T.normalLink('file:///c:/windows/system32/calc.exe') === null && T.normalLink('javascript:alert(1)') === null && T.normalLink('https://a.example/"x') === null);
  T.setLink('example.org');
  await wait(200);
  check('a link is stored on the object', last().link === 'https://example.org' && $('linkbtn').classList.contains('has'));
  T.setLink('file:///c:/x.exe');
  await wait(200);
  check('a refused address changes nothing', last().link === 'https://example.org');
  T.setLink(null);
  await wait(200);
  check('Remove link', !last().link && !$('linkbtn').classList.contains('has'));

  // ---- table style
  T.addTable(4, 3);
  await wait(400);
  const tbl = () => last().table;
  T.setTableStyle({ head: '#1f4e79' });
  await wait(250);
  const row = (r) => tbl().cells.filter((c) => c.r0 === r);
  check('Header row colours the first row, with bold light text', row(0).every((c) => c.fill && c.fill.color === '#1f4e79' && c.paras[0].runs[0].bold && c.paras[0].runs[0].color === '#ffffff') && row(1).every((c) => !c.fill));
  T.setTableStyle({ band: '#e6eef5' });
  await wait(250);
  check('Banded rows colours every other row', row(2).every((c) => c.fill && c.fill.color === '#e6eef5') && row(1).every((c) => !c.fill) && row(3).every((c) => !c.fill) && row(0).every((c) => c.fill.color === '#1f4e79'));
  T.setTableStyle({ plain: true });
  await wait(250);
  check('Plain removes the fills', tbl().cells.every((c) => !c.fill));

  // ---- picture adjustments
  let picPage = -1, pic = null;
  doc().pages.some((pg, i) => { const s = pg.shapes.find((x) => x.kind === 'picture' && x.image != null); if (s) { picPage = i; pic = s; } return !!s; });
  if (pic) {
    T.goTo(picPage);
    await wait(700);
    T.select(picPage, pic);
    T.setPicture({ brightness: 30, contrast: -20, gray: true });
    await wait(300);
    const p2 = doc().pages[picPage].shapes.find((x) => x.seq === pic.seq);
    const img = T.shapeEl(picPage, p2).querySelector('img');
    check('brightness, contrast and grayscale are stored and drawn', p2.brightness === 30 && p2.contrast === -20 && p2.gray === true && /brightness\(1\.3\) contrast\(0\.8\) grayscale\(1\)/.test(img.style.filter), img.style.filter);
    T.setPicture({ shape_type: 3 });
    await wait(300);
    const p3 = doc().pages[picPage].shapes.find((x) => x.seq === pic.seq);
    check('a picture can be shown inside a shape', p3.shape_type === 3 && /url\(/.test(T.shapeEl(picPage, p3).querySelector('.op-pic').style.clipPath) && !!T.shapeEl(picPage, p3).querySelector('clipPath path'));
    T.setPicture({ brightness: 0, contrast: 0, gray: false, shape_type: 75 });
    await wait(300);
    const p4 = doc().pages[picPage].shapes.find((x) => x.seq === pic.seq);
    check('Reset undoes them', !p4.brightness && !p4.contrast && !p4.gray && p4.shape_type === 75 && !T.shapeEl(picPage, p4).querySelector('img').style.filter);
    T.goTo(page);
    await wait(500);
  } else log('SKIP picture adjustments: no picture in this publication');

  // ---- a page as a picture
  const b64 = await T.pagePng(page, 72);
  const head = atob(b64.slice(0, 16));
  check('a page is drawn as a PNG', head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG' && b64.length > 4000, b64.length);
  const im = new Image();
  im.src = 'data:image/png;base64,' + b64;
  await im.decode();
  const cv = document.createElement('canvas');
  cv.width = im.width; cv.height = im.height;
  const cx = cv.getContext('2d');
  cx.drawImage(im, 0, 0);
  const px = cx.getImageData(0, 0, im.width, im.height).data;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 380) dark++;
  check('of the right size, with the page content in it', Math.abs(im.width - doc().width) <= 1 && Math.abs(im.height - doc().height) <= 1 && dark > 200, [im.width, im.height, dark]);
  T.send({ cmd: 'savePng', data: b64, name: 'x', path: window.OPENPUB_OUT + 'extratest-page.png' });

  // ---- first-run question and designs
  $('filebtn').click();
  document.querySelector('#filenav [data-pane="new"]').click();
  const cards = [...$('tplcards').children];
  check('New offers ready-made designs', cards.length === 4 && cards.every((c) => c.querySelector('b').textContent), cards.length);
  if (window.EXTRATEST_STAY === 'new') return;
  const st = await (await fetch('start.json')).json();
  check('the first-run question is not asked while testing', st.askAssoc === false);
  for (const [title, pages, landscape] of [['Event flyer', 1, false], ['Newsletter', 2, false], ['Certificate', 1, true], ['Notice or poster', 1, false]]) {
    window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
    [...$('tplcards').children].find((c) => c.querySelector('b').textContent === title).click();
    await wait(2200);
    const d = doc();
    const texts = d.pages.flatMap((p) => p.shapes).filter((s) => s.text);
    const drawn = T.sheets()[0].el.querySelectorAll('.op-shape').length;
    check(`${title}: ${pages} page(s), filled in and drawn`, d.pages.length === pages && (d.width > d.height) === landscape && texts.length >= 4 && drawn >= 5 && !d.path && document.getElementById('file').hidden, [d.pages.length, texts.length, drawn]);
    if (window.EXTRATEST_STAY === title) return;
    $('filebtn').click();
    document.querySelector('#filenav [data-pane="new"]').click();
  }

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
