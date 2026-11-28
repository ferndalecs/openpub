// Automated check of text carried on past shapes in the middle of a line: spaces that hang at a
// shape's edge, tabs counted from where the text resumes, and an empty line kept beside a table;
// also freeform outlines (page 79) and no hyphenation in Welsh text (page 34).
// Run inside a debug build on the Cymru textbook (page 50 is a form with boxes in its lines):
//   openpub.exe "samples/Cymru Textbook (1) 9 and 10.pub" --eval=tools/holetest.js
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const textOf = (o) => o.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const done = () => { log(`SUMMARY ${okN} OK, ${failN} FAIL`); window.ipc.postMessage(JSON.stringify({ cmd: 'quit' })); };

(async () => {
  const page = 49;
  if (T.doc().pages.length <= page) { check('the publication has a page 50', false); done(); return; }
  T.goTo(page);
  await wait(1500);
  const sheet = () => T.sheets()[page].el;
  const k = sheet().getBoundingClientRect().width / T.doc().width;
  const plain = (f) => f.textContent.replace(/­/g, '');
  const findFlow = () => [...sheet().querySelectorAll('.op-flow')].find((f) => /Darllen/.test(plain(f)) && /Target/.test(plain(f)));
  const flow = findFlow();
  check('the form frame is on the page', !!flow);
  if (!flow) { done(); return; }
  const shape = flow.closest('.op-shape').opShape;
  const before = textOf(shape.text), runsBefore = JSON.stringify(shape.text.paras);
  // where a word starts, in points from the page's left edge
  const xOf = (f, re) => {
    const pg = sheet().querySelector('.op-page').getBoundingClientRect();
    for (const s of f.querySelectorAll('span')) {
      if (s.classList.contains('op-gap') || !s.firstChild || s.firstChild.nodeType !== 3) continue;
      const m = re.exec(s.firstChild.data.replace(/­/g, ''));
      if (!m) continue;
      const rng = document.createRange();
      // (soft hyphens are in the text: find the match in the original string)
      let i = 0, seen = 0;
      const data = s.firstChild.data;
      for (; i < data.length && seen < m.index; i++) if (data[i] !== '­') seen++;
      rng.setStart(s.firstChild, i);
      rng.setEnd(s.firstChild, i + 1);
      const r = rng.getClientRects()[0];
      if (r) return (r.left - pg.left) / k;
    }
    return null;
  };
  // Publisher (measured from its own picture of the page): Darllen 182.3, Ysgrifennu 317.8,
  // Target Grade 316.6 (the letters' starts, side bearings taken off)
  const near = (v, want) => v != null && Math.abs(v - want) < 1.2;
  const d = xOf(flow, /Darllen/), y = xOf(flow, /Ysgrifennu/), tg = xOf(flow, /Target/);
  check('spaces hang at the first box: Darllen starts just after it', near(d, 182.3), d);
  check('and Ysgrifennu just after the second', near(y, 317.8), y);
  check('three tabs after a box count from where the text resumes', near(tg, 316.6), tg);
  check('the empty line beside the table stays above it', flow.querySelectorAll('.op-kept').length === 1, flow.querySelectorAll('.op-kept').length);
  const pg0 = sheet().querySelector('.op-page').getBoundingClientRect();
  const haveTop = [...flow.querySelectorAll('span')].find((s) => /Have I done/.test(s.textContent));
  const ht = haveTop && (haveTop.getBoundingClientRect().top - pg0.top) / k;
  // (Publisher's paragraph top 477.06; our span's box starts 5.2pt above the paragraph's top)
  check('so the next paragraph is the one below the table', ht != null && Math.abs(ht + 5.2 - 477.06) < 1.5, ht);

  // open for editing and close again: nothing changes (the hanging spaces and tabs read back)
  const undo0 = T.state().undo;
  T.select(page, shape);
  T.startEdit(page, shape, flow);
  await wait(300);
  T.commitEdit();
  await wait(500);
  check('opening and closing the text changes nothing', textOf(shape.text) === before && JSON.stringify(shape.text.paras) === runsBefore && T.state().undo === undo0, [textOf(shape.text) === before, T.state().undo - undo0]);

  // type into the empty line kept beside the table: it flows normally again, and the text is saved
  const f2 = findFlow();
  const kept = f2.querySelector('.op-kept');
  const pi = [...f2.querySelectorAll('.op-para')].indexOf(kept);
  T.startEdit(page, shape, f2, null, { a: { p: pi, o: 0 }, b: { p: pi, o: 0 } });
  await wait(200);
  document.execCommand('insertText', false, 'Typed');
  await wait(200);
  check('typing into the kept empty line lets it flow again', !f2.querySelector('.op-kept'), f2.querySelectorAll('.op-kept').length);
  T.commitEdit();
  await wait(500);
  check('and the typed text is saved in that paragraph', shape.text.paras[pi] && shape.text.paras[pi].runs.map((r) => r.text).join('') === 'Typed', shape.text.paras[pi] && shape.text.paras[pi].runs.map((r) => r.text));
  T.undo();
  await wait(500);
  const again = T.doc().pages[page].shapes.find((s) => s.seq === shape.seq);
  check('Undo restores it', textOf(again.text) === before);
  const f3 = findFlow();
  check('with the empty line kept again', f3 && f3.querySelectorAll('.op-kept').length === 1);

  // page 79: a freeform (a wavy line drawn with the curve tool) is drawn as its own outline
  T.goTo(78);
  await wait(1500);
  const free = T.doc().pages[78].shapes.find((s) => s.shape_type === 0 && s.path);
  check('a freeform keeps its outline from the file', !!free && /C/.test(free.path.d), free && free.path);
  const freeEl = free && [...T.sheets()[78].el.querySelectorAll('.op-shape')].find((e) => e.opShape === free);
  const outline = freeEl && [...freeEl.querySelectorAll('path')].map((p) => p.getAttribute('d')).join(' ');
  check('and is drawn with curves, not as a box', !!outline && /C/.test(outline) && !/^M0 0L/.test(outline), outline && outline.slice(0, 60));

  // page 34: its text is marked Welsh, which Publisher never breaks inside a word
  T.goTo(33);
  await wait(1500);
  const welsh = [...T.sheets()[33].el.querySelectorAll('.op-flow')].find((f) => /Margot/.test(plain(f)));
  check('Welsh text is not hyphenated', !!welsh && !welsh.textContent.includes('­'), welsh && (welsh.textContent.match(/­/g) || []).length);
  // (and English text still is: page 42's long text is marked English (UK))
  T.goTo(41);
  await wait(1500);
  const eng = [...T.sheets()[41].el.querySelectorAll('.op-flow')].sort((a, b) => b.textContent.length - a.textContent.length)[0];
  check('English text still is', !!eng && eng.textContent.includes('­'));
  done();
})().catch((e) => { check('no error', false, String(e && e.stack || e)); done(); });
