// Automated check of the security measures, run inside a debug build on a hostile .opub made by
// tools/make-hostile-opub.py (colours that try to fetch from the network, a bad picture type, a
// link that isn't a web address):
//   python tools/make-hostile-opub.py good.opub out/hostile.opub
//   openpub.exe out/hostile.opub --eval=tools/sectest.js
// Prints OK / FAIL lines and a SUMMARY line.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};

(async () => {
  const doc = T.doc();
  check('the hostile file opens', !!doc && doc.pages.length >= 1);

  // ---- what came out of the file
  const colours = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k in v) { if ((k === 'color' || k === 'color2' || k === 'background') && typeof v[k] === 'string') colours.push(v[k]); else walk(v[k]); }
  };
  walk(doc.pages);
  check('every colour from the file is a plain #rrggbb value', colours.length > 5 && colours.every((c) => /^#[0-9a-f]{6}$/i.test(c)), colours.filter((c) => !/^#[0-9a-f]{6}$/i.test(c)).slice(0, 3));
  check('nothing in the page mentions the hostile address', !document.documentElement.outerHTML.includes('203.0.113.9'));
  await wait(800);
  const fetched = performance.getEntriesByType('resource').map((e) => e.name);
  check('nothing was fetched from outside the program', fetched.every((u) => /^(http:\/\/openpub\.localhost|openpub:\/\/localhost|data:|blob:)/i.test(u)), fetched.filter((u) => !/^(http:\/\/openpub\.localhost|openpub:)/i.test(u)).slice(0, 3));

  // ---- the page's own limits (as if something had got into it)
  let blocked = false;
  try { await fetch('http://203.0.113.9/x', { mode: 'no-cors' }); } catch (e) { blocked = true; }
  check('the page cannot contact other computers', blocked);
  const imgBlocked = await new Promise((res) => {
    const im = new Image();
    im.onerror = () => res(true);
    im.onload = () => res(false);
    im.src = 'http://203.0.113.9/p.png?' + Date.now();
    setTimeout(() => res('timeout'), 3000);
  });
  check('nor load pictures from them', imgBlocked === true, imgBlocked);
  let ran = false;
  window.__sec = () => { ran = true; };
  const sc = document.createElement('script');
  sc.textContent = 'window.__sec()';
  document.head.appendChild(sc);
  check('scripts that are not the program\'s own do not run', ran === false);
  // a frame to another site: the content policy refuses it and says so
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI));
  const fr = document.createElement('iframe');
  fr.src = 'https://example.org/';
  document.body.appendChild(fr);
  await wait(1200);
  check('frames to other sites are refused', violations.some((v) => /^frame-src/.test(v) && /example\.org/.test(v)), violations);
  fr.remove();
  const w = window.open('https://example.org/');
  check('no other window can be opened', !w);

  // ---- links: only web and e-mail addresses
  const linked = doc.pages[0].shapes.filter((s) => s.link);
  check('the file\'s link to a program is kept only as text', linked.length > 0 && linked.every((s) => /^file:/.test(s.link)));
  check('and the editor refuses to make such a link', T.normalLink('file:///C:/Windows/System32/calc.exe') === null && T.normalLink('ms-msdt:/id x') === null);

  // ---- the window stays on the program's page
  const here = location.href;
  location.href = 'https://example.org/';
  await wait(1500);
  check('the window cannot be sent to another site', location.href === here, location.href);

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
