// Accessibility checks of the editor (0.3.17): every control has a name for screen readers, text
// meets WCAG AA contrast, focusable controls have a focus style (on the ribbon tabs, with
// something selected, the File screen and Help), and the page can be worked with the keyboard
// (Tab steps through the objects, Esc then Tab leaves the page, selections are announced).
// Run inside a debug build:  openpub.exe samples/Worksheet_8.pub --eval=tools/a11ytest.js
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = OpenPubApp.test;
const found = new Map();
const note = (kind, el, detail) => {
  const id = el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  const where = (el.closest('[id]') || {}).id || '';
  const key = kind + ' ' + id + ' ' + (detail || '');
  if (!found.has(key)) found.set(key, `${kind}: ${id} (in #${where}) ${detail || ''} ${JSON.stringify((el.textContent || '').trim().slice(0, 30))}`);
};
const visible = (el) => {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05 && !el.closest('[hidden]');
};
const nameOf = (el) => {
  const l = el.getAttribute('aria-label');
  if (l && l.trim()) return l;
  const lb = el.getAttribute('aria-labelledby');
  if (lb) return lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim();
  if (el.labels && el.labels.length) return [...el.labels].map((x) => x.textContent).join(' ').trim();
  const t = (el.textContent || '').trim();
  if (t && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return t;
  if (el.getAttribute('title')) return el.getAttribute('title');
  if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
  if (el.alt) return el.alt;
  return '';
};
const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const bgOf = (el) => {
  // the first ancestor with a solid background (gradients and pictures: skipped)
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = rgb(cs.backgroundColor);
    if (c && c.a > 0.9) return c;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
};
// selectors of rules that style focus, with the focus part taken off; the rule must draw something
const focusRules = [];
for (const sheet of document.styleSheets) {
  let rules;
  try { rules = sheet.cssRules; } catch (e) { continue; }
  for (const r of rules) {
    if (!r.selectorText || !/:focus/.test(r.selectorText)) continue;
    const st = r.style;
    const draws = (st.outlineStyle && st.outlineStyle !== 'none') || (st.boxShadow && st.boxShadow !== 'none') || st.background || st.backgroundColor || st.borderColor || st.outline && st.outline !== 'none';
    if (!draws) continue;
    for (const part of r.selectorText.split(',')) {
      const p = part.trim();
      if (/:focus-within/.test(p)) { const w = p.replace(/:focus-within.*$/, ''); focusRules.push(Object.assign(new String(p.replace(/:focus-within/g, '')), { within: w })); }
      else focusRules.push(p.replace(/:focus(-visible)?/g, '').replace(/:not\(\)/g, ''));
    }
  }
}
function audit(label) {
  const root = document.body;
  // 1. names
  for (const el of root.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab], [role=menuitem], [tabindex]:not([tabindex="-1"])')) {
    if (!visible(el) || el.closest('.op-page')) continue;
    if (el.type === 'hidden') continue;
    if (!nameOf(el)) note('NO NAME', el);
  }
  // 2. contrast of text
  for (const el of root.querySelectorAll('#bar *, #status *, #file *, .ctxmenu *, .pop *, #findbar *, #notes *, #pick *, .swatchpop *, #side *, #thumbs *')) {
    if (!visible(el) || el.closest('.op-page')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    const fg = rgb(cs.color), bg = bgOf(el);
    if (!fg || !bg) continue;
    const a = fg.a == null ? 1 : fg.a * parseFloat(cs.opacity || 1);
    const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(mix), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    // (disabled controls are exempt from the contrast rule)
    const disabled = el.closest(':disabled, [aria-disabled=true], .disabled') || (el.htmlFor && document.getElementById(el.htmlFor) && document.getElementById(el.htmlFor).disabled);
    if (ratio < need && !disabled) note('CONTRAST', el, `${ratio.toFixed(2)} < ${need} (${cs.color} on rgb(${bg.r},${bg.g},${bg.b}), ${size}px)`);
  }
  // 3. focus style: some style rule for :focus / :focus-visible / :focus-within applies to it
  // (focusing it from a script doesn't count as keyboard use, so the rules are matched instead)
  for (const el of root.querySelectorAll('#bar button, #bar input, #bar select, #status button, #status input, #status select, #file button, #file input, #side button, .thumb, .ctxmenu button')) {
    if (!visible(el) || el.disabled) continue;
    const has = focusRules.some((sel) => { try { return el.matches(sel) || (sel.within && el.closest(sel.within)); } catch (e) { return false; } });
    if (!has) note('NO FOCUS STYLE', el);
  }
  log(`-- ${label}: ${found.size} findings so far`);
}
let okN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else found.set('KEYS ' + name, 'KEYS: ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const key = (k, shift) => {
  const e = new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true });
  (document.activeElement || document.body).dispatchEvent(e);
  return e;
};
async function keyboard() {
  const view = document.getElementById('view');
  const live = document.getElementById('srlive');
  const own = T.doc().pages[0].shapes.filter((s) => !s.from_master);
  T.goTo(0);
  await wait(300);
  T.select(0, null);
  view.focus();
  let e = key('Tab');
  await wait(100);
  check('Tab on the page selects its first object', e.defaultPrevented && T.state().sel && T.state().sel.shape === own[0], T.state().sel && T.state().sel.shape.seq);
  check('...and says what it is', /of \d+ on page 1/.test(live.textContent), live.textContent);
  key('Tab');
  await wait(100);
  check('Tab again selects the next', T.state().sel && T.state().sel.shape === own[1 % own.length]);
  key('Tab', true);
  await wait(100);
  check('Shift+Tab goes back', T.state().sel && T.state().sel.shape === own[0]);
  key('Tab', true);
  await wait(100);
  check('...and round from the first to the last', T.state().sel && T.state().sel.shape === own[own.length - 1]);
  key('Escape');
  await wait(100);
  check('Esc lets go of it', !T.state().sel);
  e = key('Tab');
  check('the next Tab is left to the browser (it leaves the page area)', !e.defaultPrevented);
  e = key('Tab');
  check('...after which Tab on the page selects again', e.defaultPrevented && !!T.state().sel);
  T.select(0, null);
}
(async () => {
  try {
    await wait(800);
    await keyboard();
    // keyboard use first, so :focus-visible styles apply
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    audit('home tab');
    for (const t of ['t-insert', 't-page']) { document.getElementById(t).click(); await wait(200); audit(t); }
    const page = T.doc().pages[0];
    for (const kind of ['text', 'shape', 'picture', 'table']) {
      const s = page.shapes.find((x) => x.kind === kind);
      if (!s) continue;
      T.select(0, s);
      await wait(300);
      const tab = document.querySelector('#bar [role=tab].ctx:not([hidden])');
      if (tab) { tab.click(); await wait(200); }
      audit('selected ' + kind);
    }
    document.getElementById('filebtn').click();
    await wait(400);
    audit('file screen');
    // (only the buttons that show a pane: Save and Save As would open the Save dialog)
    for (const b of document.querySelectorAll('#filenav button[data-pane]')) { if (visible(b)) { b.click(); await wait(250); audit('file ' + b.textContent.trim()); } }
    // the start screen of a window with no publication, and the help page
    document.getElementById('fileback').click();
    await wait(200);
    const help = document.getElementById('helpbtn');
    if (help) { help.click(); await wait(300); audit('help'); }
  } catch (e) {
    log('ERROR ' + e.stack);
  }
  for (const v of [...found.values()].sort()) log('FAIL ' + v);
  log(`SUMMARY ${okN + (found.size === 0 ? 1 : 0)} OK, ${found.size} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
