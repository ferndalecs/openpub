// OpenPub shell: ribbon, page list, zoom, and editing. The page drawing itself is in render.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const view = $('view'), pagesEl = $('pages'), thumbsEl = $('thumbs');
  const PX = 96 / 72; // css px per point
  const CM = 72 / 2.54; // points per centimetre (sizes are shown in cm)
  const LIST_INDENT = 72 / 2.54; // hanging indent of bulleted/numbered paragraphs, as Publisher uses

  let doc = null;
  let version = 0;
  let zoomMode = 'fit-width';
  let scale = 1;
  let current = 0;
  let sheets = [];   // { el, clip, index, rendered, visible }
  let thumbs = [];
  let observer = null;
  let thumbObserver = null;

  let sel = null;       // { page, shape, shapes }  selected shapes of one page (`shape`: the one picked last)
  let cellSel = null;   // { page, shape, anchor, r0, r1, c0, c1 }  selected cells of the selected table
  let editing = null;   // { flow, owner, shape, page, before }  text being typed into
  let textSel = null;   // { owner, shape, page, a:{p,o}, b:{p,o} }  last text selection
  let undoStack = [], redoStack = [];
  let dirty = false;
  let nextSeq = 1000000;
  let busy = false;     // printing / exporting
  let masterMode = false;   // only master-page items can be picked; changes reach every page using the master
  let masterBase = null;    // { page, peers }  the pages a master-page change has to be copied to
  let cropMode = false;
  let clip = null;          // { shapes, page, text, n, cut, time }  shapes copied with Ctrl+C / Ctrl+X
  let extClipTime = 0;      // when the system clipboard may last have changed outside the shape clipboard
  let replaceTarget = null; // { page, shape }  picture waiting for its replacement
  let quiet = false;        // automated checks: don't open file dialogs
  const pen = { color: '#000000', width: 1 }; // table borders

  function send(msg) {
    if (window.ipc) window.ipc.postMessage(JSON.stringify(msg));
  }
  // (while a PDF is made: each picture asked for only as large as it is shown - picturePixels)
  let pdfMax = null;
  const imageUrl = (i) => 'img/' + i + '?v=' + version + (pdfMax && pdfMax.get(i) ? '&max=' + pdfMax.get(i) : '');
  const k = () => PX * scale; // screen px per point
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const rad = (d) => d * Math.PI / 180;
  const normDeg = (a) => ((a % 360) + 360) % 360;

  // ---- layout ------------------------------------------------------------------------------

  const spreadOn = () => $('spread').checked;

  /** The rows of the two-page view, as [left, right] page indexes (-1 = no page there). Like a
   * printed booklet (and Publisher's two-page view): page 1 on its own on the right, then
   * even | odd pairs. A two-page publication (a sheet's front and back) shows as one pair. */
  function spreadRows(n) {
    if (n <= 2) return [[0, n > 1 ? 1 : -1]];
    const rows = [[-1, 0]];
    for (let i = 1; i < n; i += 2) rows.push([i, i + 1 < n ? i + 1 : -1]);
    return rows;
  }
  /** The first page of the spread before / after the one showing page `i`. */
  function spreadStep(i, dir) {
    const rows = spreadRows(doc.pages.length);
    const r = rows.findIndex((row) => row.includes(i));
    const to = rows[Math.max(0, Math.min(rows.length - 1, r + dir))];
    return to[0] >= 0 ? to[0] : to[1];
  }

  function computeScale() {
    if (!doc) return 1;
    if (zoomMode !== 'fit-width' && zoomMode !== 'fit-page') return parseFloat(zoomMode) || 1;
    const across = spreadOn() ? 2 : 1;
    const availW = Math.max(100, view.clientWidth - 44);
    const availH = Math.max(100, view.clientHeight - 44);
    const sw = availW / (doc.width * PX * across);
    if (zoomMode === 'fit-width') return sw;
    return Math.min(sw, availH / (doc.height * PX));
  }

  function renderSheet(s, force) {
    if (s.rendered === scale && !force) return;
    s.clip.textContent = '';
    let wrap;
    try {
      wrap = OpenPub.renderPage(doc, s.index, { scale, imageUrl, editable: true });
      s.clip.appendChild(wrap);
      wrap.opFinish();
    } catch (e) {
      // (something in the page OpenPub can't draw: say so, and carry on with the other pages)
      s.clip.textContent = '';
      s.rendered = scale;
      showNotes([`Page ${s.index + 1} couldn't be drawn: ${e && e.message ? e.message : e}`]);
      return;
    }
    markOverflow(s, wrap);
    // page items fade out while the master page is edited
    const pg = wrap.querySelector('.op-page');
    if (pg) for (const e of pg.children) if (e.opShape && !e.opShape.from_master) e.classList.add('op-own');
    s.rendered = scale;
    if (sel && sel.page === s.index) showSel();
  }

  function build() {
    if (observer) observer.disconnect();
    pagesEl.textContent = '';
    sheets = [];
    if (!doc) return;
    scale = computeScale();
    updateZoomUi();
    const w = doc.width * PX * scale, h = doc.height * PX * scale;
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const s = e.target.opSheet;
        s.visible = e.isIntersecting;
        if (e.isIntersecting) renderSheet(s);
      }
    }, { root: view, rootMargin: '150% 0px' });

    const mk = (index) => {
      const el = document.createElement('div');
      el.className = 'sheet';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      if (index < 0) {
        el.classList.add('blank');
        return el;
      }
      const clip = document.createElement('div');
      clip.className = 'clip';
      el.appendChild(clip);
      const s = { el, clip, index, rendered: 0, visible: false };
      el.opSheet = s;
      sheets[index] = s;
      observer.observe(el);
      return el;
    };
    const n = doc.pages.length;
    if (spreadOn()) {
      for (const [a, b] of spreadRows(n)) {
        const row = document.createElement('div');
        row.className = 'row';
        row.appendChild(mk(a));
        row.appendChild(mk(b));
        pagesEl.appendChild(row);
      }
    } else {
      for (let i = 0; i < n; i++) pagesEl.appendChild(mk(i));
    }
  }

  let thumbScale = 1;
  function drawThumb(t) {
    t.frame.textContent = '';
    const wrap = OpenPub.renderPage(doc, t.index, { scale: thumbScale, imageUrl });
    t.frame.appendChild(wrap);
    wrap.opFinish();
    t.done = true;
  }

  function buildThumbs() {
    if (thumbObserver) thumbObserver.disconnect();
    thumbsEl.textContent = '';
    thumbs = [];
    if (!doc) return;
    const tw = 112;
    thumbScale = tw / (doc.width * PX);
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = e.target.opThumb;
        t.visible = e.isIntersecting;
        if (e.isIntersecting && !t.done) drawThumb(t);
      }
    }, { root: thumbsEl, rootMargin: '100% 0px' });
    doc.pages.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'thumb';
      b.title = 'Page ' + (i + 1) + ' (drag to move it)';
      const frame = document.createElement('div');
      frame.className = 'frame';
      frame.style.width = tw + 'px';
      frame.style.height = doc.height * PX * thumbScale + 'px';
      const label = document.createElement('span');
      label.textContent = String(i + 1);
      b.appendChild(frame);
      b.appendChild(label);
      b.addEventListener('click', () => { if (!thumbMoved) goTo(i); });
      const t = { el: b, frame, index: i, done: false, visible: false };
      b.opThumb = t;
      thumbs.push(t);
      thumbsEl.appendChild(b);
      thumbObserver.observe(b);
    });
    setCurrent(current);
  }

  const staleThumbs = new Set();
  let thumbTimer = 0;
  function refreshThumb(i) {
    staleThumbs.add(i);
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      for (const j of staleThumbs) {
        const t = thumbs[j];
        if (!t) continue;
        if (t.visible) drawThumb(t); else t.done = false;
      }
      staleThumbs.clear();
    }, 500);
  }

  // dragging a page in the page list moves it
  let thumbDrag = null, thumbMoved = false;
  thumbsEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.thumb');
    if (!b || e.button !== 0 || !doc || busy) return;
    thumbMoved = false;
    thumbDrag = { from: b.opThumb.index, y0: e.clientY, el: b, line: null, ins: null, id: e.pointerId };
  });
  thumbsEl.addEventListener('pointermove', (e) => {
    const d = thumbDrag;
    if (!d) return;
    if (!d.line) {
      if (Math.abs(e.clientY - d.y0) < 8) return;
      d.el.classList.add('dragging');
      d.line = document.createElement('div');
      d.line.className = 'dropline';
      thumbsEl.appendChild(d.line);
      try { thumbsEl.setPointerCapture(d.id); } catch (_) { /* synthetic events */ }
    }
    const r = thumbsEl.getBoundingClientRect();
    if (e.clientY < r.top + 30) thumbsEl.scrollTop -= 14;
    else if (e.clientY > r.bottom - 30) thumbsEl.scrollTop += 14;
    let ins = thumbs.length;
    for (const t of thumbs) {
      const tr = t.el.getBoundingClientRect();
      if (e.clientY < tr.top + tr.height / 2) { ins = t.index; break; }
    }
    d.ins = ins;
    const ref = thumbs[Math.min(ins, thumbs.length - 1)].el;
    d.line.style.top = (ins < thumbs.length ? ref.offsetTop : ref.offsetTop + ref.offsetHeight) - 2 + 'px';
  });
  function endThumbDrag() {
    const d = thumbDrag;
    thumbDrag = null;
    if (!d || !d.line) return;
    thumbMoved = true; // the click that follows is not a page change
    setTimeout(() => { thumbMoved = false; }, 0);
    d.el.classList.remove('dragging');
    d.line.remove();
    if (d.ins == null) return;
    const to = d.ins > d.from ? d.ins - 1 : d.ins;
    if (to !== d.from) movePage(d.from, to);
  }
  thumbsEl.addEventListener('pointerup', endThumbDrag);
  thumbsEl.addEventListener('pointercancel', endThumbDrag);

  function setCurrent(i, fromScroll) {
    if (!doc) return;
    current = Math.max(0, Math.min(doc.pages.length - 1, i));
    $('pageno').value = String(current + 1);
    $('prev').disabled = current <= 0;
    $('next').disabled = current >= doc.pages.length - 1;
    $('pageup').disabled = busy || current <= 0;
    $('pagedown').disabled = busy || current >= doc.pages.length - 1;
    thumbs.forEach((t, j) => t.el.classList.toggle('current', j === current));
    const t = thumbs[current];
    if (t && fromScroll) t.el.scrollIntoView({ block: 'nearest' });
    if (masterMode) updateMasterBar();
  }

  function goTo(i) {
    if (!doc) return;
    i = Math.max(0, Math.min(doc.pages.length - 1, i));
    const s = sheets[i];
    if (s) {
      const top = s.el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
      view.scrollTop = top - 14;
    }
    setCurrent(i, true);
  }

  function onScroll() {
    if (!doc) return;
    const vr = view.getBoundingClientRect();
    const mid = vr.top + vr.height * 0.35;
    let best = current, bd = Infinity;
    for (const s of sheets) {
      if (!s) continue;
      const r = s.el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bd) { bd = d; best = s.index; }
    }
    if (best !== current) setCurrent(best, true);
  }

  function relayout(keepPage) {
    const page = current;
    build();
    if (keepPage) goTo(page);
    $('zoom').value = zoomMode;
    updateZoomUi();
  }

  // The slider runs from 10% to 800% on a logarithmic scale (the middle is about 90%).
  const ZMIN = 0.1, ZMAX = 8;
  const sliderToScale = (v) => ZMIN * Math.pow(ZMAX / ZMIN, v / 100);
  const scaleToSlider = (z) => Math.round(100 * Math.log(Math.max(ZMIN, Math.min(ZMAX, z)) / ZMIN) / Math.log(ZMAX / ZMIN));
  function updateZoomUi() {
    $('zoompct').textContent = Math.round(scale * 100) + '%';
    if (document.activeElement !== $('zoomslider')) $('zoomslider').value = scaleToSlider(scale);
  }

  function setZoom(mode) {
    commitEdit();
    zoomMode = String(mode);
    const selEl = $('zoom');
    if (![...selEl.options].some((o) => o.value === zoomMode)) {
      [...selEl.querySelectorAll('option[data-custom]')].forEach((x) => x.remove());
      const o = document.createElement('option');
      o.value = zoomMode;
      o.textContent = Math.round(parseFloat(zoomMode) * 100) + '%';
      o.dataset.custom = '1';
      selEl.appendChild(o);
    }
    relayout(true);
  }

  const STEPS = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  function stepZoom(dir) {
    const next = dir > 0 ? STEPS.find((s) => s > scale * 1.02) || STEPS[STEPS.length - 1] : [...STEPS].reverse().find((s) => s < scale * 0.98) || STEPS[0];
    setZoom(next);
  }

  // ---- undo --------------------------------------------------------------------------------

  // ---- recovery copies -----------------------------------------------------------------------------
  // While there are unsaved changes the publication is sent for a recovery copy (recovery.rs):
  // 5 seconds after the first change, then at most every 30 seconds.
  let autosaveTimer = 0, lastAutosave = 0;
  function scheduleAutosave() {
    if (autosaveTimer || !doc) return;
    const wait = lastAutosave ? Math.max(5000, 30000 - (Date.now() - lastAutosave)) : 5000;
    autosaveTimer = setTimeout(autosaveNow, wait);
  }
  function autosaveNow() {
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    if (!doc || !dirty) return;
    if (drag || busy) { scheduleAutosave(); return; }
    lastAutosave = Date.now();
    send({ cmd: 'autosave', doc: docJsonLive() });
  }
  /** The publication as JSON with the text being typed in it, without ending the typing. */
  function docJsonLive() {
    if (!editing || editing.owner._commit) return JSON.stringify(doc);
    const o = editing.owner, keep = o.paras;
    try {
      o.paras = readFlow(editing.flow, keep);
      return JSON.stringify(doc);
    } finally {
      o.paras = keep;
    }
  }
  // A new publication not saved after 5 minutes of work: a reminder (once, or again after "later").
  let unsavedSince = 0, remindAfter = 5 * 60000;
  function checkUnsaved() {
    const show = !!doc && !doc.path && dirty && unsavedSince && Date.now() - unsavedSince > remindAfter && $('file').hidden;
    $('savebar').hidden = !show;
  }
  setInterval(checkUnsaved, 20000);

  function setDirty(v) {
    if (v) {
      scheduleAutosave();
      if (!unsavedSince) unsavedSince = Date.now();
    } else {
      unsavedSince = 0;
      remindAfter = 5 * 60000;
      $('savebar').hidden = true;
    }
    if (dirty === v) return;
    dirty = v;
    send({ cmd: 'dirty', value: v });
    $('docname').textContent = (doc && doc.name ? doc.name : '') + (v ? ' •' : '');
  }

  function snapshot(page) {
    return page == null ? { all: JSON.stringify(doc.pages), w: doc.width, h: doc.height } : { page, json: JSON.stringify(doc.pages[page]) };
  }
  /** Call before changing a page (or, with no argument, the list of pages). */
  function pushUndo(page) {
    if (masterMode && page != null) {
      // a master-page item is about to change: every page that shows it changes too
      masterBase = { page, peers: masterPeers(page) };
      page = null;
    }
    undoStack.push(snapshot(page));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0; // (in place: restore() may be holding it)
    setDirty(true);
    updateButtons();
  }
  function restore(from, to) {
    // text being typed is committed first, as its own step: Undo then takes back the typing
    commitEdit();
    const e = from.pop();
    if (!e) return;
    to.push(snapshot(e.all ? null : e.page));
    sel = null;
    textSel = null;
    cellSel = null;
    cropMode = false;
    masterBase = null;
    if (e.all) {
      doc.pages = JSON.parse(e.all);
      if (e.w && e.h) { doc.width = e.w; doc.height = e.h; }
      renumberLabels();
      buildThumbs();
      relayout(true);
    } else {
      doc.pages[e.page] = JSON.parse(e.json);
      rerender(e.page);
      goToIfHidden(e.page);
    }
    hideSel();
    setDirty(true);
    updateButtons();
    syncToolbar();
  }
  function goToIfHidden(i) {
    const s = sheets[i];
    if (!s) return;
    const r = s.el.getBoundingClientRect(), v = view.getBoundingClientRect();
    if (r.bottom < v.top + 40 || r.top > v.bottom - 40) goTo(i);
  }

  /** Redraws a page after a change (and copies master-page changes to the other pages). */
  function rerender(i) {
    if (masterBase && masterBase.page === i) {
      const peers = masterBase.peers;
      masterBase = null;
      spreadMaster(i, peers);
    }
    const s = sheets[i];
    if (s) renderSheet(s, true);
    refreshThumb(i);
  }
  /** Redraws a page that isn't being edited: now if it is near the view, otherwise when it comes into view. */
  function redraw(i) {
    const s = sheets[i];
    if (s) {
      if (s.visible) renderSheet(s, true);
      else s.rendered = 0;
    }
    refreshThumb(i);
  }

  // ---- master pages ------------------------------------------------------------------------

  function masterSeqs(i) {
    return new Set(doc.pages[i].shapes.filter((s) => s.from_master).map((s) => s.seq));
  }
  /** The pages that show the same master page as page i (including i). */
  function masterPeers(i) {
    const mine = masterSeqs(i);
    const out = [];
    doc.pages.forEach((p, q) => {
      const s = masterSeqs(q);
      if (mine.size ? [...s].some((x) => mine.has(x)) : s.size === 0) out.push(q);
    });
    return out;
  }
  /** Gives every peer page the master items of page i. */
  function spreadMaster(i, peers) {
    const items = doc.pages[i].shapes.filter((s) => s.from_master);
    for (const q of peers) {
      if (q === i || !doc.pages[q]) continue;
      const pg = doc.pages[q];
      pg.shapes = clone(items).concat(pg.shapes.filter((s) => !s.from_master));
      redraw(q);
    }
  }
  function setMasterMode(on) {
    commitEdit();
    select(0, null);
    masterMode = !!on;
    masterBase = null;
    document.body.classList.toggle('master-mode', masterMode);
    $('masterbar').hidden = !masterMode;
    $('mastermode').setAttribute('aria-pressed', String(masterMode));
    if (masterMode) updateMasterBar();
    updateButtons();
    updateSelInfo();
  }
  function updateMasterBar() {
    if (!doc) return;
    const peers = masterPeers(current);
    const items = doc.pages[current].shapes.filter((s) => s.from_master).length;
    $('masterinfo').textContent = 'Master page: only the shared items (headers, footers, page numbers…) can be changed. ' +
      (items ? `Changes reach all ${peers.length} page${peers.length === 1 ? '' : 's'} that use this master.` : `This page has no master items yet: shapes you add go on all ${peers.length} page${peers.length === 1 ? '' : 's'} without one.`);
  }

  // ---- geometry ----------------------------------------------------------------------------

  /** The page-aligned box around a (possibly rotated) shape. */
  function aabb(s) {
    const r = rad(s.rotation || 0);
    if (!r) return { x: s.x, y: s.y, w: s.w, h: s.h };
    const c = Math.abs(Math.cos(r)), n = Math.abs(Math.sin(r));
    const w = s.w * c + s.h * n, h = s.w * n + s.h * c;
    return { x: s.x + s.w / 2 - w / 2, y: s.y + s.h / 2 - h / 2, w, h };
  }
  function union(list) {
    const x0 = Math.min(...list.map((b) => b.x)), y0 = Math.min(...list.map((b) => b.y));
    const x1 = Math.max(...list.map((b) => b.x + b.w)), y1 = Math.max(...list.map((b) => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** Moves the edges of a rotated frame: d = [left, top, right, bottom] in the frame's own axes. */
  function reframe(o, d, rot) {
    const L = -o.w / 2 + d[0], T = -o.h / 2 + d[1], R = o.w / 2 + d[2], B = o.h / 2 + d[3];
    const w = R - L, h = B - T, lx = (L + R) / 2, ly = (T + B) / 2;
    const a = rad(rot || 0);
    const cx = o.x + o.w / 2 + lx * Math.cos(a) - ly * Math.sin(a);
    const cy = o.y + o.h / 2 + lx * Math.sin(a) + ly * Math.cos(a);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  /** A point on the page in a shape's own (unrotated) axes, from its top-left corner. */
  function toLocal(sh, p) {
    const a = rad(-(sh.rotation || 0));
    const dx = p.x - (sh.x + sh.w / 2), dy = p.y - (sh.y + sh.h / 2);
    return { x: dx * Math.cos(a) - dy * Math.sin(a) + sh.w / 2, y: dx * Math.sin(a) + dy * Math.cos(a) + sh.h / 2 };
  }
  function shift(shape, dx, dy) {
    shape.x += dx;
    shape.y += dy;
    for (const c of shape.children || []) shift(c, dx, dy);
  }
  /** Gives a shape a new frame; groups scale their members, tables their rows and columns. */
  function setFrame(sh, n) {
    const o = { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
    const sx = o.w > 0 ? n.w / o.w : 1, sy = o.h > 0 ? n.h / o.h : 1;
    if (sh.kind === 'group') {
      const walk = (list) => {
        for (const c of list) {
          const cx = n.x + (c.x + c.w / 2 - o.x) * sx, cy = n.y + (c.y + c.h / 2 - o.y) * sy;
          c.w *= sx;
          c.h *= sy;
          c.x = cx - c.w / 2;
          c.y = cy - c.h / 2;
          if (c.table) scaleTable(c.table, sx, sy);
          if (c.children) walk(c.children);
        }
      };
      walk(sh.children || []);
    }
    if (sh.table) scaleTable(sh.table, sx, sy);
    Object.assign(sh, n);
  }
  function scaleTable(t, sx, sy) {
    t.cols = t.cols.map((v) => v * sx);
    t.rows = t.rows.map((v) => v * sy);
  }
  function setRot(sh, a) {
    a = Math.round(normDeg(a) * 100) / 100;
    if (a === 0 || a === 360) delete sh.rotation;
    else sh.rotation = a;
  }
  function previewRotate(el, sh, a) {
    if (!el) return;
    if (sh.kind === 'group') {
      el.style.transformOrigin = `${sh.x + sh.w / 2}pt ${sh.y + sh.h / 2}pt`;
      const f = sh.flip_h || sh.flip_v ? ` scale(${sh.flip_h ? -1 : 1}, ${sh.flip_v ? -1 : 1})` : '';
      el.style.transform = `rotate(${a}deg)${f}`;
    } else {
      el.style.transform = a ? `rotate(${a}deg)` : '';
    }
  }

  // ---- selection ---------------------------------------------------------------------------

  function shapeEl(page, shape) {
    const s = sheets[page];
    if (!s) return null;
    for (const e of s.clip.querySelectorAll('.op-shape')) if (e.opShape === shape) return e;
    return null;
  }

  /** Master-page items can only be picked in master-page mode, page items only outside it. */
  const inMode = (s) => !!s.from_master === masterMode;

  /** The top-level shape of a page under a DOM node (null if it can't be picked now). */
  function topShape(node, sheetEl) {
    let top = null;
    for (let n = node; n && n !== sheetEl; n = n.parentElement) if (n.opShape) top = n;
    if (!top || !inMode(top.opShape)) return null;
    return top.opShape;
  }

  const single = () => (sel && sel.shapes.length === 1 ? sel.shape : null);
  const selTable = () => { const s = single(); return s && s.kind === 'table' && s.table ? s : null; };
  const selPicture = () => { const s = single(); return s && s.image != null && s.kind !== 'group' ? s : null; };
  /** Shapes with groups opened up. */
  function leaves(list) {
    const out = [];
    const walk = (s) => { if (s.kind === 'group') (s.children || []).forEach(walk); else out.push(s); };
    list.forEach(walk);
    return out;
  }
  /** The selected shapes in stacking order. */
  function selOrdered() {
    if (!sel) return [];
    const ps = doc.pages[sel.page].shapes;
    return sel.shapes.slice().sort((a, b) => ps.indexOf(a) - ps.indexOf(b));
  }

  let selBoxes = [];
  function hideSel() {
    for (const b of selBoxes) b.remove();
    selBoxes = [];
  }
  function showSel() {
    hideSel();
    updateSelInfo();
    if (!sel) return;
    const s = sheets[sel.page];
    if (!s || !s.rendered) return;
    const multi = sel.shapes.length > 1;
    for (const sh of sel.shapes) {
      const b = document.createElement('div');
      b.className = 'selbox' + (multi ? ' multi' : '') + (sh.from_master ? ' master' : '');
      if (editing && editing.shape === sh) b.classList.add('editing');
      placeBox(b, sh.x, sh.y, sh.w, sh.h, sh.rotation || 0);
      b.opShape = sh;
      if (!multi) {
        if (cropMode && sh.image != null) addCropBits(b, sh);
        else addHandles(b, sh);
        if (cellSel && cellSel.shape === sh && !editing) addCellMarks(b, sh);
      }
      s.el.appendChild(b);
      selBoxes.push(b);
    }
    if (multi) {
      const u = union(sel.shapes.map(aabb));
      const b = document.createElement('div');
      b.className = 'selbox union';
      placeBox(b, u.x, u.y, u.w, u.h, 0);
      s.el.appendChild(b);
      selBoxes.push(b);
    }
  }
  function handle(h, title) {
    const d = document.createElement('div');
    d.className = 'h ' + h;
    d.dataset.h = h;
    if (title) d.title = title;
    return d;
  }
  const SIDES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  function addHandles(b, sh) {
    for (const h of SIDES) b.appendChild(handle(h));
    const stem = document.createElement('div');
    stem.className = 'stem';
    b.appendChild(stem);
    b.appendChild(handle('rot', 'Drag to rotate (hold Shift for 15° steps)'));
    if (sh.kind === 'table') {
      const g = handle('grip', 'Drag to move the table');
      g.textContent = '✥';
      b.appendChild(g);
    }
  }
  function placeBox(b, x, y, w, h, rot) {
    b.style.left = x * k() + 'px';
    b.style.top = y * k() + 'px';
    b.style.width = Math.max(1, w * k()) + 'px';
    b.style.height = Math.max(1, h * k()) + 'px';
    b.style.transform = rot ? `rotate(${rot}deg)` : '';
  }

  /** Crop fractions as seen on the page (a flipped picture shows its right edge on the left). */
  function visCrop(sh, c) {
    c = (c || sh.crop || [0, 0, 0, 0]).slice();
    if (sh.flip_h) [c[0], c[2]] = [c[2], c[0]];
    if (sh.flip_v) [c[1], c[3]] = [c[3], c[1]];
    return c;
  }
  function setCropArr(sh, c) {
    c = c.map((v) => Math.max(0, Math.round(v * 1e6) / 1e6));
    if (c.every((v) => v === 0)) delete sh.crop;
    else sh.crop = c;
  }
  function addCropBits(b, sh) {
    b.classList.add('crop');
    const g = document.createElement('div');
    g.className = 'ghost';
    const img = document.createElement('img');
    img.src = imageUrl(sh.image);
    img.draggable = false;
    if (sh.flip_h || sh.flip_v) img.style.transform = `scale(${sh.flip_h ? -1 : 1}, ${sh.flip_v ? -1 : 1})`;
    g.appendChild(img);
    b.appendChild(g);
    placeGhost(b, sh.w, sh.h, visCrop(sh));
    for (const h of SIDES) b.appendChild(handle(h, 'Drag to crop'));
  }
  function placeGhost(b, w, h, vc) {
    const g = b && b.querySelector('.ghost');
    if (!g) return;
    const iw = w / Math.max(0.01, 1 - vc[0] - vc[2]), ih = h / Math.max(0.01, 1 - vc[1] - vc[3]);
    g.style.left = -vc[0] * iw * k() + 'px';
    g.style.top = -vc[1] * ih * k() + 'px';
    g.style.width = iw * k() + 'px';
    g.style.height = ih * k() + 'px';
  }
  function addCellMarks(b, sh) {
    const el = shapeEl(cellSel.page, sh);
    if (!el) return;
    const inRange = new Set(rangeCells(cellSel));
    const f = 0.75 * k(); // layout px -> pt -> screen px
    for (const td of el.querySelectorAll('td')) {
      if (!td.opCell || !inRange.has(td.opCell)) continue;
      const m = document.createElement('div');
      m.className = 'cell';
      m.style.left = td.offsetLeft * f + 'px';
      m.style.top = td.offsetTop * f + 'px';
      m.style.width = td.offsetWidth * f + 'px';
      m.style.height = td.offsetHeight * f + 'px';
      b.appendChild(m);
    }
  }

  /** Says something to screen readers (a polite live region; nothing on the screen changes). */
  let tabOut = false; // Esc let go of an object: the next Tab leaves the page area
  function announce(text) {
    const live = $('srlive');
    if (!live) return;
    // (the same words twice are still read out: clear first, then set)
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  }
  /** An object as a screen reader should hear it: its kind and the start of its words. */
  function describeShape(s) {
    const words = s.wordart ? s.wordart.text : s.text && s.text.paras ? s.text.paras.map((p) => p.runs.map((r) => r.text || '').join('')).join(' ') : '';
    const w = words.replace(/\s+/g, ' ').trim();
    return kindName(s) + (w ? ': ' + (w.length > 60 ? w.slice(0, 57) + '…' : w) : '');
  }

  function kindName(s) {
    if (s.kind === 'table') return `Table (${s.table.rows.length} × ${s.table.cols.length})`;
    if (s.kind === 'group') return `Group of ${(s.children || []).length}`;
    if (s.wordart) return 'WordArt';
    if (s.kind === 'picture' || s.image != null) return 'Picture';
    if (s.kind === 'line') return 'Line';
    if (s.kind === 'text') return 'Text box';
    return 'Shape';
  }
  function updateSelInfo(text) {
    let t = text || '';
    if (!t && sel) {
      if (cellSel && cellSel.shape === sel.shape) {
        const n = rangeCells(cellSel).length;
        t = n === 1 ? '1 cell selected' : n + ' cells selected';
      } else if (sel.shapes.length > 1) t = sel.shapes.length + ' objects selected';
      else t = kindName(sel.shape) + (cropMode ? ' – cropping' : '');
    }
    if (!text && waEdit) t = 'WordArt – type the words, then press Esc or click away';
    if (masterMode) t = 'Master page' + (t ? ' · ' + t : '');
    $('selinfo').textContent = t;
    if (!text && sel && !cellSel && sel.shapes.some((s) => overflowing(sel.page, s))) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = " · Text doesn't fit";
      $('selinfo').appendChild(w);
    }
    updateSelGeom();
  }
  /** Where the selection is and how big, for the status bar. */
  function updateSelGeom() {
    let g = '';
    if (sel && sel.shapes.length) {
      const cm = (v) => (v / 72 * 2.54).toFixed(2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of sel.shapes) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h); }
      g = `${cm(x0)}, ${cm(y0)} cm  ·  ${cm(x1 - x0)} × ${cm(y1 - y0)} cm`;
      if (sel.shapes.length === 1 && sel.shape.rotation) g += `  ·  ${Math.round(normDeg(sel.shape.rotation) * 10) / 10}°`;
    }
    $('selgeom').textContent = g;
  }

  /** Selects one shape; mode 'toggle' adds or removes it from the selection instead. */
  function select(page, shape, mode) {
    if (!mode && shape && sel && sel.page === page && sel.shapes.length === 1 && sel.shape === shape) return;
    commitEdit();
    cropMode = false;
    if (!shape) sel = null;
    else if (mode && sel && sel.page === page) {
      const i = sel.shapes.indexOf(shape);
      if (i < 0) {
        sel.shapes.push(shape);
        sel.shape = shape;
      } else if (mode === 'toggle') {
        sel.shapes.splice(i, 1);
        sel.shape = sel.shapes[sel.shapes.length - 1];
        if (!sel.shapes.length) sel = null;
      }
    } else sel = { page, shape, shapes: [shape] };
    textSel = null;
    cellSel = null;
    afterSelect();
  }
  function selectMany(page, list) {
    commitEdit();
    cropMode = false;
    sel = list.length ? { page, shape: list[list.length - 1], shapes: list.slice() } : null;
    textSel = null;
    cellSel = null;
    afterSelect();
  }
  function afterSelect() {
    showSel();
    updateButtons();
    syncToolbar();
  }
  function selectAll() {
    if (!doc) return;
    selectMany(current, doc.pages[current].shapes.filter(inMode));
  }

  /** Other text frames keep flowing around a shape that moved, went away or changed size. */
  function fixWraps(page, shape, dx, dy, remove) {
    const walk = (list) => {
      for (const s of list) {
        if (s.children) walk(s.children);
        const t = s.text;
        if (s === shape) {
          // the frame itself moved: the shapes it avoids stay where they are
          if (t && t.wrap) for (const r of t.wrap) { r[0] -= dx; r[2] -= dx; r[1] -= dy; r[3] -= dy; }
          continue;
        }
        if (!t || !t.wrap || !t.wrap_seq) continue;
        for (let i = t.wrap.length - 1; i >= 0; i--) {
          if (t.wrap_seq[i] !== shape.seq) continue;
          if (remove) { t.wrap.splice(i, 1); t.wrap_seq.splice(i, 1); }
          else { const r = t.wrap[i]; r[0] += dx; r[2] += dx; r[1] += dy; r[3] += dy; }
        }
      }
    };
    walk(doc.pages[page].shapes);
  }

  // ---- pointer: select, move, resize, rotate, crop, cells ----------------------------------

  let drag = null;
  const capture = (e) => { try { pagesEl.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no pointer to capture */ } };
  function sheetPoint(sheetEl, x, y) {
    const r = sheetEl.getBoundingClientRect();
    return { x: (x - r.left) / k(), y: (y - r.top) / k() };
  }

  pagesEl.addEventListener('pointerdown', (e) => {
    if (!doc || busy || e.button !== 0) return;
    closeMenus();
    const sheetEl = e.target.closest('.sheet');
    if (!sheetEl || !sheetEl.opSheet) { select(0, null); return; }
    const page = sheetEl.opSheet.index;
    if (tool) {
      e.preventDefault();
      commitEdit();
      if (current !== page) setCurrent(page, true);
      drag = { kind: 'draw', page, sheetEl, p0: sheetPoint(sheetEl, e.clientX, e.clientY), p: null, box: null, targets: snapTargets(page, null) };
      if (!e.altKey) {
        const sx = snap1([drag.p0.x], drag.targets.xs, snapTol()), sy = snap1([drag.p0.y], drag.targets.ys, snapTol());
        if (sx) drag.p0.x += sx.d;
        if (sy) drag.p0.y += sy.d;
      }
      capture(e);
      return;
    }
    const hd = e.target.classList.contains('h') && e.target.dataset.h;
    if (hd && sel) { e.preventDefault(); startHandle(e, hd); return; }
    if (editing && e.target.closest('.op-flow') === editing.flow) return; // typing: let the caret move
    const shape = topShape(e.target, sheetEl);
    if (current !== page) setCurrent(page, true);
    const ctrl = e.ctrlKey || e.metaKey, add = e.shiftKey || ctrl;
    if (ctrl && !e.shiftKey && shape && shape.link) { e.preventDefault(); send({ cmd: 'openLink', url: shape.link }); return; }
    const tsh = selTable();
    if (tsh && shape === tsh && sel.page === page && !ctrl) { tableDown(e, page, tsh, sheetEl); return; }
    e.preventDefault();
    view.focus({ preventScroll: true });
    if (!shape) {
      // empty part of the page: drag out a box to select what's inside
      if (!add) select(page, null);
      drag = { kind: 'band', page, sheetEl, p0: sheetPoint(sheetEl, e.clientX, e.clientY), add, box: null, r: null };
      capture(e);
      return;
    }
    let collapse = false;
    if (add) {
      if (sel && sel.page === page) select(page, shape, 'toggle'); else select(page, shape);
      if (!sel || !sel.shapes.includes(shape)) return;
    } else if (sel && sel.page === page && sel.shapes.includes(shape)) {
      if (editing) commitEdit();
      collapse = sel.shapes.length > 1;
    } else select(page, shape);
    drag = { kind: 'move', page, shape, collapse, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, els: sel.shapes.map((s) => shapeEl(page, s)) };
    capture(e);
  });

  function startHandle(e, hd) {
    const sh = sel.shape;
    if (hd === 'grip') {
      commitEdit();
      drag = { kind: 'move', page: sel.page, shape: sh, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, els: [shapeEl(sel.page, sh)] };
      capture(e);
      return;
    }
    if (hd === 'rot') {
      commitEdit();
      const box = selBoxes[0];
      if (!box) return;
      const r = box.getBoundingClientRect();
      drag = { kind: 'rot', shape: sh, cx: r.left + r.width / 2, cy: r.top + r.height / 2, a: sh.rotation || 0, moved: false, el: shapeEl(sel.page, sh) };
      capture(e);
      return;
    }
    const o = { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
    drag = { kind: cropMode ? 'crop' : 'size', h: hd, x0: e.clientX, y0: e.clientY, o, n: null };
    if (cropMode) {
      const vc = visCrop(sh);
      Object.assign(drag, { vc0: vc, vc, iw: o.w / Math.max(0.01, 1 - vc[0] - vc[2]), ih: o.h / Math.max(0.01, 1 - vc[1] - vc[3]) });
    }
    capture(e);
  }

  function tableDown(e, page, tsh, sheetEl) {
    e.preventDefault();
    const line = gridHit(page, tsh, toLocal(tsh, sheetPoint(sheetEl, e.clientX, e.clientY)));
    const td = e.target.closest('td');
    const cell = td && td.opCell;
    if (line) {
      commitEdit();
      drag = Object.assign({ kind: 'grid', page, shape: tsh, x0: e.clientX, y0: e.clientY, d: 0 }, line);
      capture(e);
      return;
    }
    if (editing) commitEdit();
    view.focus({ preventScroll: true });
    if (!cell) {
      drag = { kind: 'move', page, shape: tsh, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, els: [shapeEl(page, tsh)] };
      capture(e);
      return;
    }
    if (e.shiftKey && cellSel && cellSel.shape === tsh) extendCells(cell);
    else setCells(page, tsh, cell);
    drag = { kind: 'cells', page, shape: tsh, last: cell };
    capture(e);
  }

  pagesEl.addEventListener('pointermove', (e) => {
    const d = drag;
    if (!d) { hover(e); return; }
    const dx = (e.clientX - d.x0) / k(), dy = (e.clientY - d.y0) / k();
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      let mx = dx, my = dy, gx = null, gy = null;
      if (!e.altKey && sel) {
        if (!d.u0) { d.u0 = union(sel.shapes.map(aabb)); d.targets = snapTargets(d.page, sel.shapes); }
        const u = d.u0, tol = snapTol();
        const sx = snap1([u.x + dx, u.x + dx + u.w / 2, u.x + dx + u.w], d.targets.xs, tol);
        const sy = snap1([u.y + dy, u.y + dy + u.h / 2, u.y + dy + u.h], d.targets.ys, tol);
        if (sx) { mx += sx.d; gx = sx.at; }
        if (sy) { my += sy.d; gy = sy.at; }
      }
      if (sheets[d.page]) showGuides(sheets[d.page].el, gx, gy);
      d.dx = mx;
      d.dy = my;
      for (const el of d.els) if (el) el.style.translate = `${mx}pt ${my}pt`;
      for (const b of selBoxes) b.style.translate = `${mx * k()}px ${my * k()}px`;
    } else if (d.kind === 'size' || d.kind === 'crop') {
      if (!sel) return;
      const sh = sel.shape, o = d.o, h = d.h, rot = sh.rotation || 0, a = rad(rot);
      const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a);
      const dd = [h.includes('w') ? lx : 0, h.includes('n') ? ly : 0, h.includes('e') ? lx : 0, h.includes('s') ? ly : 0];
      if (d.kind === 'crop') {
        const vc = d.vc0;
        dd[0] = Math.max(dd[0], -vc[0] * d.iw);
        dd[2] = Math.min(dd[2], vc[2] * d.iw);
        dd[1] = Math.max(dd[1], -vc[1] * d.ih);
        dd[3] = Math.min(dd[3], vc[3] * d.ih);
        if (o.w - dd[0] + dd[2] < 6) { if (h.includes('w')) dd[0] = o.w + dd[2] - 6; else dd[2] = 6 - o.w + dd[0]; }
        if (o.h - dd[1] + dd[3] < 6) { if (h.includes('n')) dd[1] = o.h + dd[3] - 6; else dd[3] = 6 - o.h + dd[1]; }
        d.vc = [vc[0] + dd[0] / d.iw, vc[1] + dd[1] / d.ih, vc[2] - dd[2] / d.iw, vc[3] - dd[3] / d.ih];
      } else {
        const min = sh.kind === 'line' ? 0 : 6;
        let w = o.w - dd[0] + dd[2], ht = o.h - dd[1] + dd[3];
        // Shift on a corner keeps the proportions
        if (e.shiftKey && h.length === 2 && o.w > 0 && o.h > 0) {
          const f = Math.max(w / o.w, ht / o.h);
          w = o.w * f;
          ht = o.h * f;
        }
        w = Math.max(min, w);
        ht = Math.max(min, ht);
        if (h.includes('w')) dd[0] = o.w - w; else if (h.includes('e')) dd[2] = w - o.w;
        if (h.includes('n')) dd[1] = o.h - ht; else if (h.includes('s')) dd[3] = ht - o.h;
      }
      d.n = reframe(o, dd, rot);
      if (d.kind === 'size' && !rot && !e.shiftKey && !e.altKey && sh.kind !== 'line') {
        if (!d.targets) d.targets = snapTargets(sel.page, sel.shapes);
        const t = d.targets, tol = snapTol(), n = d.n;
        let gx = null, gy = null;
        if (h.includes('w')) { const s = snap1([n.x], t.xs, tol); if (s && n.w - s.d >= 6) { n.x += s.d; n.w -= s.d; gx = s.at; } }
        else if (h.includes('e')) { const s = snap1([n.x + n.w], t.xs, tol); if (s && n.w + s.d >= 6) { n.w += s.d; gx = s.at; } }
        if (h.includes('n')) { const s = snap1([n.y], t.ys, tol); if (s && n.h - s.d >= 6) { n.y += s.d; n.h -= s.d; gy = s.at; } }
        else if (h.includes('s')) { const s = snap1([n.y + n.h], t.ys, tol); if (s && n.h + s.d >= 6) { n.h += s.d; gy = s.at; } }
        if (sheets[sel.page]) showGuides(sheets[sel.page].el, gx, gy);
      }
      const box = selBoxes[0];
      if (box) placeBox(box, d.n.x, d.n.y, d.n.w, d.n.h, rot);
      if (d.kind === 'crop') placeGhost(box, d.n.w, d.n.h, d.vc);
      updateSelInfo(`${fmtCm(d.n.w)} × ${fmtCm(d.n.h)} cm`);
    } else if (d.kind === 'rot') {
      let a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx) * 180 / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      a = normDeg(a);
      d.a = a;
      d.moved = true;
      previewRotate(d.el, d.shape, a);
      const sh = d.shape;
      if (selBoxes[0]) placeBox(selBoxes[0], sh.x, sh.y, sh.w, sh.h, a);
      updateSelInfo('Rotation ' + Math.round(a) + '°');
    } else if (d.kind === 'draw') {
      const p = sheetPoint(d.sheetEl, e.clientX, e.clientY);
      if (!d.box) {
        if (Math.hypot(p.x - d.p0.x, p.y - d.p0.y) * k() < 4) return;
        d.box = document.createElement('div');
        d.box.className = 'band draw';
        d.sheetEl.appendChild(d.box);
      }
      let gx = null, gy = null;
      if (!e.altKey) {
        const sx = snap1([p.x], d.targets.xs, snapTol()), sy = snap1([p.y], d.targets.ys, snapTol());
        if (sx) { p.x += sx.d; gx = sx.at; }
        if (sy) { p.y += sy.d; gy = sy.at; }
      }
      if (e.shiftKey) {
        const ddx = p.x - d.p0.x, ddy = p.y - d.p0.y;
        if (tool && tool.kind === 'line') {
          // lines at 45° steps
          const a = Math.round(Math.atan2(ddy, ddx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(ddx, ddy);
          p.x = d.p0.x + Math.round(Math.cos(a) * len * 1000) / 1000;
          p.y = d.p0.y + Math.round(Math.sin(a) * len * 1000) / 1000;
        } else {
          // squares and circles
          const m = Math.max(Math.abs(ddx), Math.abs(ddy));
          p.x = d.p0.x + Math.sign(ddx || 1) * m;
          p.y = d.p0.y + Math.sign(ddy || 1) * m;
        }
      }
      d.p = p;
      showGuides(d.sheetEl, gx, gy);
      placeBox(d.box, Math.min(p.x, d.p0.x), Math.min(p.y, d.p0.y), Math.abs(p.x - d.p0.x), Math.max(Math.abs(p.y - d.p0.y), 1 / k()), 0);
      updateSelInfo(`${fmtCm(Math.abs(p.x - d.p0.x))} × ${fmtCm(Math.abs(p.y - d.p0.y))} cm`);
    } else if (d.kind === 'band') {
      const p = sheetPoint(d.sheetEl, e.clientX, e.clientY);
      if (!d.box) {
        if (Math.hypot(p.x - d.p0.x, p.y - d.p0.y) * k() < 4) return;
        d.box = document.createElement('div');
        d.box.className = 'band';
        d.sheetEl.appendChild(d.box);
      }
      d.r = { x: Math.min(p.x, d.p0.x), y: Math.min(p.y, d.p0.y), w: Math.abs(p.x - d.p0.x), h: Math.abs(p.y - d.p0.y) };
      placeBox(d.box, d.r.x, d.r.y, d.r.w, d.r.h, 0);
    } else if (d.kind === 'cells') {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const td = t && t.closest && t.closest('td');
      const c = td && td.opCell;
      if (c && c !== d.last && d.shape.table.cells.includes(c)) {
        d.last = c;
        extendCells(c);
      }
    } else if (d.kind === 'grid') {
      const sh = d.shape, a = rad(sh.rotation || 0);
      const l = d.axis === 'col' ? dx * Math.cos(a) + dy * Math.sin(a) : -dx * Math.sin(a) + dy * Math.cos(a);
      d.d = Math.max(l, 4 - d.size);
      const box = selBoxes[0];
      if (!box) return;
      if (!d.guide) {
        d.guide = document.createElement('div');
        d.guide.className = 'guide';
        box.appendChild(d.guide);
      }
      const at = (d.pos + d.d) * k();
      d.guide.style.cssText = d.axis === 'col' ? `left:${at - 1}px;top:0;width:2px;height:100%` : `top:${at - 1}px;left:0;height:2px;width:100%`;
      updateSelInfo((d.axis === 'col' ? 'Column ' : 'Row ') + fmtCm(d.size + d.d) + ' cm');
    }
  });

  function endDrag() {
    const d = drag;
    drag = null;
    if (!d) return;
    clearGuides();
    if (d.kind === 'draw') {
      if (d.box) d.box.remove();
      if (!tool) return;
      if (d.p && (Math.abs(d.p.x - d.p0.x) > 1 || Math.abs(d.p.y - d.p0.y) > 1)) {
        const p = d.p, p0 = d.p0;
        const f = { x: Math.min(p.x, p0.x), y: Math.min(p.y, p0.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
        if (tool.kind !== 'line') { f.w = Math.max(f.w, 6); f.h = Math.max(f.h, 6); }
        placeTool(d.page, f, { h: p.x < p0.x, v: p.y < p0.y });
      } else {
        // a click: the usual size, centred where it was clicked (a line goes to the right)
        const [w, h] = toolSize(tool);
        const x = tool.kind === 'line' ? d.p0.x : d.p0.x - w / 2, y = tool.kind === 'line' ? d.p0.y : d.p0.y - h / 2;
        placeTool(d.page, { x: Math.max(0, Math.min(doc.width - w, x)), y: Math.max(0, Math.min(doc.height - h, y)), w, h });
      }
      return;
    }
    if (d.kind === 'band') {
      if (d.box) d.box.remove();
      if (d.r) {
        const r = d.r;
        const hits = doc.pages[d.page].shapes.filter((s) => {
          if (!inMode(s)) return false;
          const b = aabb(s);
          return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
        });
        if (d.add && sel && sel.page === d.page) selectMany(d.page, sel.shapes.concat(hits.filter((s) => !sel.shapes.includes(s))));
        else selectMany(d.page, hits);
      }
      return;
    }
    if (!sel) return;
    const page = sel.page;
    if (d.kind === 'move') {
      if (d.moved) {
        pushUndo(page);
        for (const sh of sel.shapes) {
          shift(sh, d.dx, d.dy);
          fixWraps(page, sh, d.dx, d.dy, false);
        }
        rerender(page);
      } else if (d.collapse) select(page, d.shape);
    } else if ((d.kind === 'size' || d.kind === 'crop') && d.n) {
      const sh = sel.shape;
      pushUndo(page);
      if (d.kind === 'crop') {
        Object.assign(sh, d.n);
        setCropArr(sh, visCrop(sh, d.vc));
      } else {
        const ddx = d.n.x - sh.x, ddy = d.n.y - sh.y;
        setFrame(sh, d.n);
        fixWraps(page, sh, ddx, ddy, false);
      }
      rerender(page);
    } else if (d.kind === 'rot' && d.moved) {
      pushUndo(page);
      setRot(d.shape, d.a);
      rerender(page);
    } else if (d.kind === 'grid' && d.d) {
      pushUndo(page);
      const t = d.shape.table;
      if (d.axis === 'col') t.cols[d.i] = Math.max(4, t.cols[d.i] + d.d);
      else t.rows[d.i] = Math.max(4, d.size + d.d);
      fitTable(d.shape);
      rerender(page);
    } else if (d.kind === 'grid' && d.guide) {
      d.guide.remove();
    }
    updateSelInfo();
    syncToolbar();
  }
  pagesEl.addEventListener('pointerup', endDrag);
  pagesEl.addEventListener('pointercancel', endDrag);

  // grid lines of the selected table show a resize pointer
  let hoverSheet = null;
  function hover(e) {
    const tsh = selTable();
    const s = tsh && !editing && sheets[sel.page];
    let cur = '';
    if (s && e.target.closest('.sheet') === s.el && topShape(e.target, s.el) === tsh) {
      const g = gridHit(sel.page, tsh, toLocal(tsh, sheetPoint(s.el, e.clientX, e.clientY)));
      if (g) cur = g.axis === 'col' ? 'col-resize' : 'row-resize';
    }
    if (hoverSheet && (!s || hoverSheet !== s.el)) hoverSheet.style.cursor = '';
    hoverSheet = s ? s.el : null;
    if (hoverSheet) hoverSheet.style.cursor = cur;
  }

  pagesEl.addEventListener('dblclick', (e) => {
    if (!doc || busy) return;
    const sheetEl = e.target.closest('.sheet');
    if (!sheetEl || !sheetEl.opSheet) return;
    const shape = topShape(e.target, sheetEl);
    if (!shape) return;
    const page = sheetEl.opSheet.index;
    if (cropMode) { setCropMode(false); return; }
    if (shape.wordart) { editWordArt(page, shape); return; }
    select(page, shape);
    const td = e.target.closest('td');
    let flow = e.target.closest('.op-flow') || (td && td.querySelector('.op-flow'));
    if (!flow && shape.kind !== 'table') {
      if (!shape.text && (shape.kind === 'shape' || shape.kind === 'text')) {
        pushUndo(page);
        shape.text = newTextBody();
        rerender(page);
      }
      const el = shapeEl(page, shape);
      flow = el && el.querySelector('.op-flow');
    }
    if (flow && flow.opOwner) startEdit(page, shape, flow, e);
  });

  // ---- text editing ------------------------------------------------------------------------

  const SYMBOL = /^(symbol|wingdings|wingdings 2|wingdings 3|webdings)$/i;
  const DEFAULT_RUN = { font: 'Calibri', size: 11, bold: false, italic: false, underline: false, color: '#000000', script: 0 };
  const DEFAULT_PARA = { align: 'left', left: 0, right: 0, first: 0, before: 0, after: 0, spacing: 1 };

  function newTextBody(text) {
    const lines = text == null ? [''] : text.split('\n');
    return { margins: [2.88, 2.88, 2.88, 2.88], valign: 'top', columns: 1, column_gap: 0, story: 0, paras: lines.map((l) => Object.assign({}, DEFAULT_PARA, { runs: [Object.assign({ text: l }, DEFAULT_RUN, { size: 12 })] })) };
  }

  function cleanRun(r) {
    const o = { text: r.text, font: r.font, size: r.size, color: r.color };
    if (r.bold) o.bold = true;
    if (r.italic) o.italic = true;
    if (r.underline) o.underline = true;
    if (r.script) o.script = r.script;
    if (r.strike) o.strike = true;
    if (r.effect) o.effect = r.effect;
    if (r.caps) o.caps = r.caps;
    if (r.tracking) o.tracking = r.tracking;
    if (r.scale) o.scale = r.scale;
    if (r.kerning) o.kerning = r.kerning;
    if (r.field) o.field = r.field;
    if (r.lang) o.lang = r.lang;
    if (r.object) o.object = r.object;
    return o;
  }
  const sameStyle = (a, b) => a.font === b.font && a.size === b.size && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && a.color === b.color && (a.script || 0) === (b.script || 0) && !!a.strike === !!b.strike && (a.effect || 0) === (b.effect || 0) && (a.caps || 0) === (b.caps || 0) && (a.tracking || 0) === (b.tracking || 0) && (a.kerning || 0) === (b.kerning || 0) && (a.scale || 0) === (b.scale || 0) && (a.lang || 0) === (b.lang || 0);

  /** Reads the runs of one paragraph element (or a fragment of one). */
  function readRuns(node, fallback) {
    const runs = [];
    const push = (style, text) => {
      const st = style ? JSON.parse(style) : fallback;
      if (SYMBOL.test(st.font)) text = text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xf000));
      const last = runs[runs.length - 1];
      if (last && !last.object && !last.field && sameStyle(last, st)) last.text += text;
      else runs.push(Object.assign({}, st, { text }));
    };
    const walk = (n, style) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = c.nodeValue.replace(/­/g, '');
          if (t) push(style, t);
        } else if (c.nodeType === 1) {
          if (c.classList.contains('op-bullet') || c.classList.contains('op-wrap')) continue;
          if (c.classList.contains('op-obj')) {
            runs.push(c.opRun || Object.assign({}, fallback, { text: '￼' }));
            continue;
          }
          const st = (c.dataset && c.dataset.r) || style;
          if (c.classList.contains('op-tab')) push(st, '\t');
          else if (c.tagName === 'BR') push(st, '\n');
          else if (c.dataset && c.dataset.field) runs.push(Object.assign({}, st ? JSON.parse(st) : fallback, { text: '#', field: c.dataset.field }));
          else walk(c, st);
        }
      }
    };
    walk(node, null);
    return runs;
  }
  const runsLength = (runs) => runs.reduce((n, r) => n + (r.object ? 1 : r.text.length), 0);
  /** A run's length as the editor counts characters (the page shows a field as one, and optional
   * hyphens aren't counted): positions in the page and in the model agree. */
  const visLen = (r) => (r.object || r.field ? 1 : r.text.length - (r.text.match(/\u00AD/g) || []).length);
  /** Where in `t` the text after its first `n` counted characters starts. */
  function textIndex(t, n) {
    let i = 0, k = 0;
    while (i < t.length && k < n) {
      if (t[i] !== '\u00AD') k++;
      i++;
    }
    return i;
  }
  /** Text with the characters OpenPub adds for laying it out (hyphenation points, the joiners in
   * the spacers beside shapes) taken out. */
  const plainOf = (t) => t.replace(/[\u00AD\u2060]/g, '');

  function paraDivs(flow) {
    return [...flow.children].filter((c) => !c.classList.contains('op-wrap'));
  }

  /** Reads edited text back into paragraphs. */
  function readFlow(flow, old) {
    const paras = [];
    let lastStyle = Object.assign({}, DEFAULT_PARA);
    let lastRun = (old[0] && old[0].runs[0]) || DEFAULT_RUN;
    for (const div of paraDivs(flow)) {
      if (div.dataset && div.dataset.p) lastStyle = JSON.parse(div.dataset.p);
      const first = div.querySelector('[data-r]');
      if (first) lastRun = JSON.parse(first.dataset.r);
      let runs = readRuns(div, lastRun);
      // the browser keeps a line break at the end of a paragraph so the caret has somewhere to sit
      const tail = runs[runs.length - 1];
      if (tail && !tail.object && tail.text.endsWith('\n')) {
        tail.text = tail.text.slice(0, -1);
        if (!tail.text && runs.length > 1) runs.pop();
      }
      if (!runs.length) runs = [Object.assign({}, lastRun, { text: '' })];
      lastRun = runs[runs.length - 1];
      paras.push(Object.assign({}, lastStyle, { runs: runs.map(cleanRun) }));
    }
    if (!paras.length) paras.push(Object.assign({}, lastStyle, { runs: [cleanRun(Object.assign({}, lastRun, { text: '' }))] }));
    return paras;
  }

  /** A DOM position inside a flow as { p: paragraph index, o: character offset }. */
  function toOffset(flow, node, offset) {
    const divs = paraDivs(flow);
    for (let p = 0; p < divs.length; p++) {
      if (!divs[p].contains(node) && divs[p] !== node) continue;
      const r = document.createRange();
      r.setStart(divs[p], 0);
      r.setEnd(node, offset);
      return { p, o: runsLength(readRuns(r.cloneContents(), DEFAULT_RUN)) };
    }
    return { p: Math.max(0, divs.length - 1), o: 1e9 };
  }

  function fromOffset(flow, pos) {
    const divs = paraDivs(flow);
    const div = divs[Math.min(pos.p, divs.length - 1)];
    if (!div) return null;
    let left = pos.o, last = null;
    // inline objects and fields (page numbers) count as one character, as in toOffset
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const v = c.nodeValue;
          last = { node: c, offset: v.length };
          for (let i = 0; i <= v.length; i++) {
            if (left === 0 && (i === v.length || v[i] !== '­')) return { node: c, offset: i };
            if (i < v.length && v[i] !== '­') left--;
          }
        } else if (c.nodeType === 1) {
          if (c.classList.contains('op-bullet') || c.classList.contains('op-wrap')) continue;
          if (c.classList.contains('op-obj') || (c.dataset && c.dataset.field) || c.classList.contains('op-tab') || c.tagName === 'BR') {
            const i = [...n.childNodes].indexOf(c);
            if (left === 0) return { node: n, offset: i };
            left--;
            last = { node: n, offset: i + 1 };
            continue;
          }
          const r = walk(c);
          if (r) return r;
        }
      }
      return null;
    };
    return walk(div) || last || { node: div, offset: 0 };
  }

  function captureSelection() {
    if (!editing) return;
    const s = window.getSelection();
    if (!s.rangeCount || !editing.flow.contains(s.anchorNode)) return;
    const r = s.getRangeAt(0);
    textSel = { owner: editing.owner, shape: editing.shape, page: editing.page, a: toOffset(editing.flow, r.startContainer, r.startOffset), b: toOffset(editing.flow, r.endContainer, r.endOffset) };
  }

  function findFlow(page, shape, owner) {
    const el = shapeEl(page, shape);
    if (!el) return null;
    for (const f of el.querySelectorAll('.op-flow')) if (f.opOwner === owner) return f;
    return null;
  }

  function startEdit(page, shape, flow, ev, restoreSel) {
    commitEdit();
    editing = { flow, owner: flow.opOwner, shape, page, before: JSON.stringify(flow.opOwner.paras), wasClean: !dirty };
    for (const e of flow.querySelectorAll('.op-empty')) {
      e.textContent = '';
      e.appendChild(document.createElement('br'));
    }
    // a page number is one unit: text typed next to it must not go inside it
    for (const f of flow.querySelectorAll('[data-field]')) f.contentEditable = 'false';
    flow.contentEditable = 'true';
    flow.spellcheck = true;
    const box = flow.closest('.op-text');
    if (box) box.classList.add('editing');
    flow.focus({ preventScroll: true });
    const s = window.getSelection();
    if (restoreSel) {
      const a = fromOffset(flow, restoreSel.a), b = fromOffset(flow, restoreSel.b);
      if (a && b) s.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    } else if (ev && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (r && flow.contains(r.startContainer)) {
        s.removeAllRanges();
        s.addRange(r);
      }
    }
    // what reading the text back gives before anything is typed: the test for "was it changed?"
    editing.read = JSON.stringify(readFlow(flow, flow.opOwner.paras));
    flow.addEventListener('blur', onEditBlur);
    flow.addEventListener('keydown', onEditKey);
    flow.addEventListener('paste', onEditPaste);
    flow.addEventListener('input', onEditInput);
    flow.addEventListener('copy', onEditCopy);
    flow.addEventListener('cut', onEditCopy);
    showSel();
    updateButtons();
    syncToolbar();
  }

  // text being typed counts as an unsaved change straight away (the window may be closed before
  // the typing is committed)
  function onEditInput() {
    setDirty(true);
    // an empty line held beside a shape (render.js keepEmptyLines) flows normally once typed in
    if (editing) for (const p of editing.flow.querySelectorAll('.op-kept')) if (p.textContent.trim()) OpenPub.releaseEmpty(p);
  }
  // (the copy is plain text: the hyphenation points and joiners added for layout are left out)
  function onEditCopy(e) {
    const s = window.getSelection();
    if (!s.rangeCount || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', plainOf(String(s)));
    if (e.type === 'cut') document.execCommand('delete');
  }
  function onEditBlur() {
    captureSelection();
    // toolbar fields take the focus; the selection is remembered so formatting can apply to it
    setTimeout(() => {
      if (editing && document.activeElement !== editing.flow) commitEdit();
    }, 0);
  }
  const ALIGN_KEYS = { l: 'left', e: 'center', r: 'right', j: 'justify' };
  function onEditKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      commitEdit();
      view.focus();
    }
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && 'biu'.includes(key) && key.length === 1) {
      e.preventDefault();
      format({ [{ b: 'bold', i: 'italic', u: 'underline' }[key]]: 'toggle' });
    } else if (ctrl && (key === 'f' || key === 'h')) {
      e.preventDefault();
      showFind(key === 'h');
    } else if (ctrl && e.shiftKey && (e.key === '>' || e.key === '<')) {
      e.preventDefault();
      stepSize(e.key === '>' ? 1 : -1);
    } else if (ctrl && key in ALIGN_KEYS && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      format({ align: ALIGN_KEYS[key] });
    } else if (ctrl && key === 's') {
      e.preventDefault();
      save(false);
    } else if (ctrl && key === 'p') {
      e.preventDefault();
      commitEdit();
      printAll();
    } else if (ctrl && (key === 'c' || key === 'x')) {
      extClipTime = Date.now(); // copied text: a paste outside the text makes a text box from it
    }
  }
  function onEditPaste(e) {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (t) document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
  }

  function commitEdit() {
    if (!editing) return;
    const ed = editing;
    editing = null;
    ed.flow.removeEventListener('blur', onEditBlur);
    ed.flow.removeEventListener('keydown', onEditKey);
    ed.flow.removeEventListener('paste', onEditPaste);
    ed.flow.removeEventListener('input', onEditInput);
    ed.flow.removeEventListener('copy', onEditCopy);
    ed.flow.removeEventListener('cut', onEditCopy);
    ed.flow.contentEditable = 'false';
    const paras = readFlow(ed.flow, ed.owner.paras);
    const after = JSON.stringify(paras);
    // (the text of linked boxes on other pages changes too)
    const many = ed.owner._commit ? storyPagesOf([ed.shape]) : null;
    if (after !== ed.read) {
      // record the page as it was before typing started
      ed.owner.paras = JSON.parse(ed.before);
      if (many) pushUndo(); else pushUndo(ed.page);
      ed.owner.paras = paras;
    } else if (ed.wasClean) {
      setDirty(false); // typed and taken out again
    }
    if (many) many.forEach(rerender); else rerender(ed.page);
  }

  // ---- formatting --------------------------------------------------------------------------

  /** Everything in a shape that holds paragraphs (text bodies and table cells). */
  function owners(shape) {
    const out = [];
    const walk = (s) => {
      if (s.text) out.push(s.text);
      if (s.table) for (const c of s.table.cells) out.push(c);
      for (const c of s.children || []) walk(c);
    };
    walk(shape);
    return out;
  }
  /** What formatting applies to when no text is selected: the selected cells, or the selected shapes. */
  function targetOwners() {
    if (!sel) return [];
    if (cellSel && cellSel.shape === sel.shape) return rangeCells(cellSel);
    const out = [];
    for (const s of sel.shapes) {
      const f = s.text && chainFlow(sel.page, s);
      out.push(...owners(s).map((o) => (f && o === s.text ? f.opOwner : o)));
    }
    return out;
  }

  function applyRuns(para, s, e, fn) {
    const out = [];
    let pos = 0;
    for (const r of para.runs) {
      const len = visLen(r);
      const a = Math.max(s, pos), b = Math.min(e, pos + len);
      if (b <= a) {
        // an empty paragraph still takes the formatting so typing into it uses it
        if (!r.object && !r.field && len === 0 && s <= pos && e >= pos) fn(r);
        out.push(r);
      } else if (r.object) {
        out.push(r);
      } else if (r.field) {
        // (a field - a page number - is formatted whole)
        const f = Object.assign({}, r);
        fn(f);
        out.push(f);
      } else {
        const ia = textIndex(r.text, a - pos), ib = textIndex(r.text, b - pos);
        if (ia > 0) out.push(Object.assign({}, r, { text: r.text.slice(0, ia) }));
        const mid = Object.assign({}, r, { text: r.text.slice(ia, ib) });
        fn(mid);
        out.push(mid);
        if (ib < r.text.length) out.push(Object.assign({}, r, { text: r.text.slice(ib) }));
      }
      pos += len;
    }
    para.runs = out;
  }

  /**
   * Applies formatting to the text selection, or to all the text of the selected cells/shapes.
   * Character formatting: { bold: true | 'toggle', size: 12, ... }. Paragraph formatting:
   * { align: 'center' } or { para: (para, index, list, first) => ... }.
   */
  function format(change) {
    if (!doc) return;
    let resume = null;
    if (editing) {
      captureSelection();
      resume = { page: editing.page, shape: editing.shape, owner: editing.owner, sel: textSel && { a: textSel.a, b: textSel.b } };
      commitEdit();
    }
    if (textSel) textSel.owner = liveOwner(textSel.page, textSel.shape, textSel.owner);
    const target = textSel || (sel && { page: sel.page });
    if (!target) return;
    const paraFn = change.para || ('align' in change ? (p) => { p.align = change.align; } : null);
    const runKeys = Object.keys(change).filter((key) => key !== 'para' && key !== 'align');
    const many = storyPagesOf(textSel ? [textSel.shape] : sel.shapes);
    if (many) pushUndo(); else pushUndo(target.page);
    const touched = [];
    const ranged = textSel && (textSel.a.p !== textSel.b.p || textSel.a.o !== textSel.b.o);
    const toggleState = currentStyle() || {};
    const apply = (r) => {
      for (const key of runKeys) r[key] = change[key] === 'toggle' ? !toggleState[key] : typeof change[key] === 'function' ? change[key](r[key], r) : change[key];
    };
    if (textSel && (ranged || paraFn)) {
      const ps = textSel.owner.paras;
      touched.push(textSel.owner);
      const last = Math.min(textSel.b.p, ps.length - 1);
      for (let p = textSel.a.p; p <= last; p++) {
        if (paraFn) paraFn(ps[p], p, ps, p === textSel.a.p);
        if (runKeys.length) applyRuns(ps[p], p === textSel.a.p ? textSel.a.o : 0, p === textSel.b.p ? textSel.b.o : 1e9, apply);
      }
    } else {
      const list = textSel ? [textSel.owner] : targetOwners();
      touched.push(...list);
      list.forEach((o, n) => o.paras.forEach((p, i) => {
        if (paraFn) paraFn(p, i, o.paras, n === 0 && i === 0);
        if (runKeys.length) applyRuns(p, 0, 1e9, apply);
      }));
    }
    commitViews(touched);
    if (many) many.forEach(rerender); else rerender(target.page);
    if (resume) {
      const flow = findFlow(resume.page, resume.shape, resume.owner) || (resume.owner._commit && chainFlow(resume.page, resume.shape));
      if (flow) startEdit(resume.page, resume.shape, flow, null, resume.sel);
    }
    syncToolbar();
  }

  function toggleScript(v) {
    const st = currentStyle();
    format({ script: st && st.script === v ? 0 : v });
  }
  // the sizes of Publisher's font size list
  const SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72, 96, 144];
  function stepSize(dir) {
    format({
      size: (v) => {
        const cur = v || 10;
        if (dir > 0) return SIZES.find((s) => s > cur + 0.01) || Math.min(999, cur + 12);
        return [...SIZES].reverse().find((s) => s < cur - 0.01) || Math.max(1, cur - 1);
      },
    });
  }

  // ---- shapes gallery, align and flip, page setup ----------------------------------------------

  // Office shape types (the numbers of the drawing format), by family
  const GALLERY = [
    ['Lines', [[20, 'Line']]],
    ['Basic shapes', [[1, 'Rectangle'], [2, 'Rounded rectangle'], [3, 'Ellipse'], [5, 'Triangle'], [6, 'Right-angled triangle'], [4, 'Diamond'], [7, 'Parallelogram'], [8, 'Trapezoid'], [56, 'Pentagon'], [9, 'Hexagon'], [10, 'Octagon'], [11, 'Cross'], [16, 'Cube'], [22, 'Cylinder'], [84, 'Bevel'], [23, 'Ring'], [65, 'Folded corner'], [96, 'Smiley face'], [74, 'Heart'], [73, 'Lightning bolt'], [183, 'Sun'], [184, 'Moon'], [185, 'Square brackets'], [186, 'Curly brackets']]],
    ['Block arrows', [[13, 'Right arrow'], [66, 'Left arrow'], [68, 'Up arrow'], [67, 'Down arrow'], [69, 'Left-right arrow'], [70, 'Up-down arrow'], [76, 'Four-way arrow'], [91, 'Bent arrow'], [101, 'U-turn arrow'], [15, 'Pentagon arrow'], [55, 'Chevron'], [78, 'Right arrow callout']]],
    ['Flowchart', [[109, 'Process'], [116, 'Terminator'], [110, 'Decision'], [111, 'Data'], [114, 'Document'], [117, 'Preparation'], [118, 'Manual input'], [119, 'Manual operation'], [120, 'Connector']]],
    ['Stars and banners', [[187, '4-point star'], [12, '5-point star'], [58, '8-point star'], [59, '16-point star'], [92, '24-point star'], [60, '32-point star'], [71, 'Explosion 1'], [72, 'Explosion 2'], [53, 'Ribbon down'], [54, 'Ribbon up'], [64, 'Wave'], [98, 'Horizontal scroll'], [97, 'Vertical scroll']]],
    ['Callouts', [[61, 'Rectangular callout'], [62, 'Rounded callout'], [63, 'Oval callout'], [106, 'Cloud callout']]],
  ];
  function buildShapeGallery() {
    const pop = $('shapepop');
    const NS = 'http://www.w3.org/2000/svg';
    for (const [title, items] of GALLERY) {
      const cells = mk('div', 'cells');
      for (const [type, name] of items) {
        let geo = null;
        const probe = { kind: type === 20 ? 'line' : 'shape', shape_type: type, x: 0, y: 0, w: 24, h: type === 20 ? 0 : 20 };
        try { geo = window.OpenPubGeometry ? window.OpenPubGeometry(probe) : null; } catch (e) { geo = null; }
        if (type === 20) geo = { paths: [{ d: 'M2 18L22 2', fill: false }] };
        if (!geo || !geo.paths || !geo.paths.length) continue; // only shapes that can be drawn
        const b = mk('button');
        b.title = name;
        b.setAttribute('aria-label', name);
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', type === 20 ? '0 0 24 20' : '-1 -1 26 22');
        for (const p of geo.paths) {
          const node = document.createElementNS(NS, 'path');
          node.setAttribute('d', p.d);
          node.setAttribute('fill', p.fill === false ? 'none' : '#fff');
          node.setAttribute('stroke', p.stroke === false ? 'none' : '#23211d');
          node.setAttribute('stroke-width', '1.1');
          node.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(node);
        }
        b.appendChild(svg);
        b.addEventListener('click', () => (type === 20 ? armTool('line', 20) : armTool('shape', type, 'a ' + name.toLowerCase())));
        cells.appendChild(b);
      }
      if (!cells.children.length) continue;
      pop.appendChild(mk('h3', '', title));
      pop.appendChild(cells);
    }
  }

  function addWordArt() {
    if (!doc) return;
    const w = Math.min(320, doc.width * 0.6), h = 70;
    const p = visibleSpot(w, h);
    addShape({ kind: 'shape', shape_type: 136, x: p.x, y: p.y, w, h, fill: { color: '#0f6e5f', opacity: 1 }, wordart: { text: 'Your text', font: 'Arial Black', size: 36, stretch: true } }, false);
    showTab('shape');
    syncToolbar();
    editWordArt(current, sel.shape);
  }
  function setWordArt(change, type) {
    editShapes((s) => {
      if (!s.wordart) return;
      if (change) Object.assign(s.wordart, change);
      // (another style: its own default shape, not the old style's adjustment)
      if (type && type !== s.shape_type) { s.shape_type = type; delete s.adjust; }
    }, true);
  }
  /** A pattern (16 hex digits, see model.rs) in the fill colour on white; '' for none. */
  function setPattern(bits) {
    editShapes((s) => {
      if (s.kind === 'line' || (s.fill && s.fill.image != null)) return;
      if (!bits) { if (s.fill) { delete s.fill.pattern; delete s.fill.back; } return; }
      if (!/^[0-9a-f]{16}$/i.test(bits)) return;
      if (!s.fill || (s.fill.color || '').toLowerCase() === '#ffffff') s.fill = { color: '#1e88e5', opacity: s.fill ? s.fill.opacity : 1 };
      delete s.fill.color2;
      delete s.fill.angle;
      delete s.fill.stops;
      delete s.fill.radial;
      s.fill.pattern = bits.toLowerCase();
      s.fill.back = s.fill.back || '#ffffff';
    });
  }
  /** dir: null = no gradient, a number = its angle; color2: the second colour. */
  function setGradient(dir, color2) {
    editShapes((s) => {
      if (!s.fill || s.fill.image != null || s.kind === 'line') return;
      // (a gradient set here has the two colours chosen: a file's own colour list and
      // middle-out style go)
      delete s.fill.stops;
      delete s.fill.radial;
      if (dir === null) { delete s.fill.color2; delete s.fill.angle; return; }
      delete s.fill.pattern;
      delete s.fill.back;
      s.fill.color2 = color2 || s.fill.color2 || $('fill2').value;
      if (dir !== undefined) s.fill.angle = dir;
      else if (s.fill.angle == null) s.fill.angle = 180;
    });
  }
  function setShadow(on, color) {
    editShapes((s) => {
      if (!on) { delete s.shadow; return; }
      s.shadow = Object.assign({ color: $('shadowcolor').value, opacity: 1, dx: 3, dy: 3 }, s.shadow, color ? { color } : {});
    });
  }
  /** A typed address as a link: web and e-mail addresses only. */
  function normalLink(v) {
    let u = String(v || '').trim();
    if (!u) return null;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u)) u = 'mailto:' + u;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    if (!/^(https?:\/\/|mailto:)/i.test(u) || /[\s"<>^`|]/.test(u) || u.length > 2000) return null;
    return u;
  }
  function setLink(v) {
    if (!sel) return;
    const u = v == null ? null : normalLink(v);
    if (v != null && String(v).trim() && !u) { showNotes(['Only web addresses (http or https) and e-mail addresses can be used as links.'], 6000); return; }
    editShapes((s) => { if (u) s.link = u; else delete s.link; }, true);
  }
  /** Colours a table: { head } the first row, { band } every other row below it, { plain } none. */
  function setTableStyle(st) {
    const sh = selTable();
    if (!sh) return;
    commitEdit();
    pushUndo(sel.page);
    for (const c of sh.table.cells) {
      if (st.plain) delete c.fill;
      if (st.head && c.r0 === 0) {
        c.fill = { color: st.head, opacity: 1 };
        // text that reads on the colour, in bold
        const n = parseInt(st.head.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        for (const p of c.paras) for (const r of p.runs) { r.bold = true; r.color = lum < 0.55 ? '#ffffff' : '#000000'; }
      }
      if (st.band && c.r0 > 0) {
        if (c.r0 % 2 === 0) c.fill = { color: st.band, opacity: 1 }; else delete c.fill;
      }
    }
    rerender(sel.page);
    syncToolbar();
  }
  function setPicture(change) {
    editShapes((s) => {
      if (s.image == null) return;
      for (const k of ['brightness', 'contrast']) if (k in change) { if (change[k]) s[k] = change[k]; else delete s[k]; }
      if ('gray' in change) { if (change.gray) s.gray = true; else delete s.gray; }
      if ('shape_type' in change && change.shape_type) s.shape_type = change.shape_type;
    });
  }

  /** Lines objects up: with each other when several are selected, with the page when one is. */
  function alignSel(mode) {
    if (!sel || !doc) return;
    commitEdit();
    let x0 = 0, y0 = 0, x1 = doc.width, y1 = doc.height;
    if (sel.shapes.length > 1) {
      x0 = Math.min(...sel.shapes.map((s) => s.x)); y0 = Math.min(...sel.shapes.map((s) => s.y));
      x1 = Math.max(...sel.shapes.map((s) => s.x + s.w)); y1 = Math.max(...sel.shapes.map((s) => s.y + s.h));
    }
    pushUndo(sel.page);
    for (const s of sel.shapes) {
      let dx = 0, dy = 0;
      if (mode === 'left') dx = x0 - s.x;
      else if (mode === 'center') dx = (x0 + x1) / 2 - (s.x + s.w / 2);
      else if (mode === 'right') dx = x1 - (s.x + s.w);
      else if (mode === 'top') dy = y0 - s.y;
      else if (mode === 'middle') dy = (y0 + y1) / 2 - (s.y + s.h / 2);
      else if (mode === 'bottom') dy = y1 - (s.y + s.h);
      if (!dx && !dy) continue;
      shift(s, dx, dy);
      fixWraps(sel.page, s, dx, dy, false);
    }
    rerender(sel.page);
    syncToolbar();
  }
  function flipSel(axis) {
    const key = axis === 'h' ? 'flip_h' : 'flip_v';
    editShapes((s) => { if (s[key]) delete s[key]; else s[key] = true; }, true);
  }

  const PAGE_SIZES = { a4: [210 * 72 / 25.4, 297 * 72 / 25.4], a5: [148 * 72 / 25.4, 210 * 72 / 25.4], a3: [297 * 72 / 25.4, 420 * 72 / 25.4], letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], a2: [420 * 72 / 25.4, 594 * 72 / 25.4], a6: [105 * 72 / 25.4, 148 * 72 / 25.4], dl: [99 * 72 / 25.4, 210 * 72 / 25.4], bizcard: [55 * 72 / 25.4, 85 * 72 / 25.4] };
  /** Changes the size of every page; objects stay where they are, measured from the top left. */
  function setPageSize(w, h) {
    if (!doc || !(w >= 28 && h >= 28) || (Math.abs(w - doc.width) < 0.01 && Math.abs(h - doc.height) < 0.01)) { syncPageUi(); return; }
    commitEdit();
    pushUndo(); // the size is part of the whole-publication step
    doc.width = w;
    doc.height = h;
    const page = current;
    buildThumbs();
    relayout(false);
    goTo(page);
    syncToolbar();
  }
  function syncPageUi() {
    if (!doc) return;
    const active = document.activeElement;
    const a = Math.min(doc.width, doc.height), b = Math.max(doc.width, doc.height);
    let name = 'custom';
    for (const k in PAGE_SIZES) if (Math.abs(PAGE_SIZES[k][0] - a) < 1 && Math.abs(PAGE_SIZES[k][1] - b) < 1) name = k;
    if (active !== $('pgsize')) $('pgsize').value = name;
    if (active !== $('pgw')) $('pgw').value = fmtCm(doc.width);
    if (active !== $('pgh')) $('pgh').value = fmtCm(doc.height);
    $('pgport').classList.toggle('on', doc.height >= doc.width);
    $('pgland').classList.toggle('on', doc.width > doc.height);
    const bg = doc.pages[current] && doc.pages[current].background;
    $('pgbg').value = isHex(bg) ? bg : '#ffffff';
  }
  function setPageBackground(color, all) {
    if (!doc) return;
    commitEdit();
    const set = (pg) => { delete pg.background_fill; if (color) pg.background = color; else delete pg.background; };
    if (all) {
      pushUndo();
      doc.pages.forEach((pg, i) => { set(pg); redraw(i); });
    } else {
      pushUndo(current);
      set(doc.pages[current]);
      rerender(current);
    }
    syncToolbar();
  }
  function addPageBorder() {
    if (!doc) return;
    const m = Math.min(36, doc.width / 8, doc.height / 8);
    addShape({ kind: 'shape', shape_type: 1, x: m, y: m, w: doc.width - 2 * m, h: doc.height - 2 * m, line: { color: '#000000', width: 1.5 }, wrap: 'none' }, false);
  }



  // ---- the font and size lists ---------------------------------------------------------------------
  // A box to type in, with a list underneath: fonts each shown in their own lettering, sizes.
  const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72, 96];
  let systemFonts = null;
  const recentFonts = [];
  const pickEl = document.createElement('div');
  pickEl.className = 'pickpop';
  pickEl.id = 'pickpop';
  pickEl.setAttribute('role', 'listbox');
  pickEl.hidden = true;
  document.body.appendChild(pickEl);
  const pick = { input: null, rows: [], at: -1, start: '', applied: null, seen: null };
  const fontCss = (n) => '"' + String(n).replace(/["\\]/g, '') + '", "Segoe UI", sans-serif';

  async function loadSystemFonts() {
    if (systemFonts) return systemFonts;
    try {
      const list = await (await fetch('fonts.json')).json();
      systemFonts = Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
    } catch (e) {
      systemFonts = [];
    }
    return systemFonts;
  }
  /** The fonts the publication uses. */
  function docFonts() {
    const names = new Set();
    if (!doc) return [];
    const walk = (s) => {
      for (const o of owners(s)) for (const p of o.paras) for (const r of p.runs) if (r.font) names.add(r.font);
      if (s.wordart && s.wordart.font) names.add(s.wordart.font);
    };
    for (const p of doc.pages) for (const s of p.shapes) walk(s);
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  function pickKind(input) {
    return input.id === 'size' ? 'size' : 'font';
  }
  function openPick(input, filter) {
    pick.input = input;
    pickEl.textContent = '';
    pick.rows = [];
    pick.at = -1;
    if (pick.seen) pick.seen.disconnect();
    // (each font is drawn in its own lettering only when its row scrolls into view)
    pick.seen = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting && e.target.opFont) { e.target.style.fontFamily = fontCss(e.target.opFont); pick.seen.unobserve(e.target); }
    }, { root: pickEl });
    const head = (t) => pickEl.appendChild(mk('div', 'ph', t));
    const row = (value, font) => {
      const d = mk('div', 'pr', value);
      d.dataset.v = value;
      d.setAttribute('role', 'option');
      if (font) { d.opFont = value; d.title = value; }
      d.addEventListener('mousedown', (e) => { e.preventDefault(); choosePick(value); });
      pickEl.appendChild(d);
      pick.rows.push(d);
      if (font) pick.seen.observe(d);
    };
    if (pickKind(input) === 'size') {
      for (const s of FONT_SIZES) row(String(s));
    } else {
      const q = String(filter || '').trim().toLowerCase();
      const match = (n) => !q || n.toLowerCase().includes(q);
      const inDoc = docFonts().filter(match), rec = recentFonts.filter(match);
      const all = (systemFonts || []).filter(match);
      if (inDoc.length) { head('In this publication'); inDoc.forEach((n) => row(n, true)); }
      if (rec.length) { head('Recently used'); rec.forEach((n) => row(n, true)); }
      if (all.length) { head(systemFonts.length ? 'All fonts' : 'Fonts'); all.forEach((n) => row(n, true)); }
      if (!pick.rows.length) pickEl.appendChild(mk('div', 'pe', q ? `No font called "${filter}" on this computer. Press Enter to use the name anyway.` : 'No fonts found.'));
    }
    const r = input.getBoundingClientRect();
    pickEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 270)) + 'px';
    pickEl.style.top = r.bottom + 2 + 'px';
    pickEl.style.minWidth = Math.max(r.width, pickKind(input) === 'size' ? 64 : 230) + 'px';
    pickEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const cur = String(input.value).trim().toLowerCase();
    const i = pick.rows.findIndex((d) => d.dataset.v.toLowerCase() === cur);
    markPick(i >= 0 ? i : q0(filter) ? 0 : -1);
  }
  const q0 = (f) => !!String(f || '').trim();
  function markPick(i) {
    if (pick.rows[pick.at]) pick.rows[pick.at].classList.remove('at');
    pick.at = i;
    const d = pick.rows[i];
    if (d) { d.classList.add('at'); d.scrollIntoView({ block: 'nearest' }); }
  }
  function closePick() {
    if (pickEl.hidden) return;
    pickEl.hidden = true;
    if (pick.seen) pick.seen.disconnect();
    if (pick.input) pick.input.setAttribute('aria-expanded', 'false');
  }
  /** Applies a font or size from the list or typed in the box. */
  function applyPick(input, value) {
    const v = String(value).trim();
    if (!v) return;
    pick.applied = v;
    if (input.id === 'size') {
      const n = parseFloat(v.replace(',', '.'));
      if (n >= 1 && n <= 999) format({ size: Math.round(n * 2) / 2 });
      else syncToolbar();
      return;
    }
    const i = recentFonts.indexOf(v);
    if (i >= 0) recentFonts.splice(i, 1);
    recentFonts.unshift(v);
    recentFonts.length = Math.min(recentFonts.length, 6);
    if (input.id === 'wafont') setWordArt({ font: v });
    else format({ font: v });
  }
  function choosePick(value) {
    const input = pick.input;
    if (!input) return;
    input.value = value;
    closePick();
    applyPick(input, value);
    input.blur();
    if (!editing) view.focus({ preventScroll: true });
  }
  for (const input of document.querySelectorAll('input.picker')) {
    input.addEventListener('focus', () => {
      pick.start = input.value;
      pick.applied = null;
      input.select();
      loadSystemFonts().then(() => { if (document.activeElement === input) openPick(input, ''); });
    });
    input.addEventListener('mousedown', () => { if (document.activeElement === input && pickEl.hidden) openPick(input, ''); });
    input.addEventListener('click', () => {
      if (!pickEl.hidden && pick.input === input) return;
      pick.start = input.value;
      pick.applied = null;
      loadSystemFonts().then(() => openPick(input, ''));
    });
    input.addEventListener('input', () => { if (pickKind(input) === 'font') openPick(input, input.value); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (pickEl.hidden || pick.input !== input) openPick(input, '');
        else markPick(Math.max(0, Math.min(pick.rows.length - 1, pick.at + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const d = !pickEl.hidden && pick.input === input && pick.rows[pick.at];
        if (d && (pickKind(input) === 'font' || d.dataset.v === String(input.value).trim())) choosePick(d.dataset.v);
        else { const v = input.value; closePick(); applyPick(input, v); input.blur(); if (!editing) view.focus({ preventScroll: true }); }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = pick.start;
        closePick();
        input.blur();
        view.focus({ preventScroll: true });
      } else if (e.key === 'Tab') closePick();
    });
    input.addEventListener('blur', () => {
      closePick();
      // a name or size typed and left: use it (unless it is already what the text has: the
      // window may report focus late, after the choice was applied)
      const v = String(input.value).trim();
      if (!v || v === pick.start || v === pick.applied) return;
      const st = currentStyle();
      const now = input.id === 'size' ? st && String(st.size) : input.id === 'wafont' ? sel && sel.shape && sel.shape.wordart && sel.shape.wordart.font : st && st.font;
      if (now != null && String(now).toLowerCase() === v.toLowerCase()) return;
      applyPick(input, v);
    });
  }
  window.addEventListener('resize', closePick);
  view.addEventListener('scroll', closePick);

  // ---- WordArt typed on the page ---------------------------------------------------------------
  // The words go in a box on the page next to the WordArt, which follows as they are typed.
  let waEdit = null;
  function editWordArt(page, shape, typed) {
    commitEdit();
    endWordArt();
    if (!shape || !shape.wordart || !sheets[page]) return;
    if (current !== page) goTo(page);
    select(page, shape);
    renderSheet(sheets[page]);
    const s = sheets[page];
    const ta = document.createElement('textarea');
    ta.className = 'waedit';
    ta.setAttribute('aria-label', 'WordArt words');
    ta.spellcheck = true;
    ta.value = shape.wordart.text;
    // under the WordArt (above it near the bottom of the page), as wide as it
    const b = aabb(shape);
    const w = Math.max(b.w, 150 / k());
    const lines = Math.max(1, ta.value.split('\n').length);
    const h = (Math.min(4, lines) * 26 + 16) / k();
    const y = b.y + b.h + h + 6 / k() > doc.height ? b.y - h - 6 / k() : b.y + b.h + 6 / k();
    ta.style.left = Math.max(0, b.x) * k() + 'px';
    ta.style.top = Math.max(0, y) * k() + 'px';
    ta.style.width = w * k() + 'px';
    ta.style.height = h * k() + 'px';
    ta.style.fontFamily = fontCss(shape.wordart.font);
    ta.style.fontSize = '18px';
    if (shape.wordart.bold) ta.style.fontWeight = 'bold';
    if (shape.wordart.italic) ta.style.fontStyle = 'italic';
    s.el.appendChild(ta);
    const ed = { page, shape, ta, before: shape.wordart.text, timer: 0 };
    waEdit = ed;
    const changed = () => {
      setDirty(true);
      shape.wordart.text = ta.value.replace(/\r\n?/g, '\n') || ' ';
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => { if (waEdit === ed) { rerender(page); } }, 120);
    };
    ta.addEventListener('input', changed);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        endWordArt();
        view.focus({ preventScroll: true });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && ta.value === ed.before) {
        e.preventDefault();
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (waEdit === ed && document.activeElement !== ta) endWordArt(); }, 0));
    // (and a click anywhere else, whether or not the window had the keyboard)
    const away = (e) => {
      if (waEdit !== ed) { document.removeEventListener('pointerdown', away, true); return; }
      if (e.target === ta) return;
      document.removeEventListener('pointerdown', away, true);
      endWordArt();
    };
    document.addEventListener('pointerdown', away, true);
    ta.focus({ preventScroll: true });
    if (typed != null) {
      ta.value = typed;
      ta.setSelectionRange(typed.length, typed.length);
      changed();
    } else ta.select();
    updateSelInfo('WordArt – type the words, then press Esc or click away');
  }
  function endWordArt() {
    if (!waEdit) return;
    const { page, shape, ta, before, timer } = waEdit;
    waEdit = null;
    clearTimeout(timer);
    ta.remove();
    const now = shape.wordart.text;
    if (now !== before) {
      // one undo step for the whole edit
      shape.wordart.text = before;
      pushUndo(page);
      shape.wordart.text = now;
    }
    rerender(page);
    updateSelInfo();
    syncToolbar();
  }

  // ---- text that doesn't fit its box -------------------------------------------------------------
  /** Red markers on the boxes whose text doesn't all show (editor only: not printed or exported). */
  function markOverflow(s, wrap) {
    for (const m of s.el.querySelectorAll('.ovf')) m.remove();
    if (busy) return;
    for (const box of wrap.querySelectorAll('.op-text')) {
      if (!box.opOverflow) continue;
      const el = box.closest('.op-shape');
      const sh = el && el.opShape;
      if (!sh) continue;
      const m = document.createElement('button');
      m.className = 'ovf';
      m.textContent = '!';
      m.title = "Some of the text doesn't fit in this box. Click to choose how to fix it.";
      m.setAttribute('aria-label', "Text doesn't fit");
      // at the bottom right corner of the box (turned with it)
      const a = (sh.rotation || 0) * Math.PI / 180;
      const cx = sh.x + sh.w / 2 + (sh.w / 2) * Math.cos(a) - (sh.h / 2) * Math.sin(a);
      const cy = sh.y + sh.h / 2 + (sh.w / 2) * Math.sin(a) + (sh.h / 2) * Math.cos(a);
      m.style.left = cx * k() + 'px';
      m.style.top = cy * k() + 'px';
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        select(s.index, sh);
        showTab('textbox');
      });
      s.el.appendChild(m);
    }
  }
  function overflowing(page, sh) {
    const el = shapeEl(page, sh);
    return !!el && [...el.querySelectorAll('.op-text')].some((b) => b.opOverflow);
  }
  /** Shapes in the selection whose text can be fitted (not turned, not part of linked boxes). */
  function fitTargets() {
    if (!sel) return [];
    const chains = OpenPub.storyChains(doc);
    return sel.shapes.filter((s) => s.text && s.kind !== 'table' && !s.wordart && !chains.has(s.text.story));
  }
  /** Where the text of a box ends, in points below the top of the box (null if it has none). */
  function textBottom(page, sh) {
    const el = shapeEl(page, sh);
    const flow = el && el.querySelector('.op-flow');
    if (!flow) return null;
    // (measured unturned)
    const turn = el.style.transform;
    if (turn) el.style.transform = 'none';
    const top = el.getBoundingClientRect().top;
    let bottom = null;
    for (const span of flow.querySelectorAll('span')) {
      if (span.classList.contains('op-wrap') || !/\S/.test(span.textContent.replace(/[\u00AD\u2060]/g, ''))) continue;
      for (const r of span.getClientRects()) if (r.height) bottom = Math.max(bottom == null ? -Infinity : bottom, r.bottom);
    }
    if (turn) el.style.transform = turn;
    return bottom == null ? null : (bottom - top) / k();
  }
  /** Makes each selected box as tall as its text. */
  function fitBoxToText() {
    const list = fitTargets();
    if (!list.length) return;
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    let off = false;
    for (const sh of list) {
      const keep = { h: sh.h, valign: sh.text.valign };
      // laid out from the top in a very tall box, to see where the text ends
      sh.text.valign = 'top';
      sh.h = Math.max(sh.h, doc.height * 2);
      rerender(page);
      const end = textBottom(page, sh);
      if (keep.valign === undefined) delete sh.text.valign; else sh.text.valign = keep.valign;
      sh.h = end == null ? keep.h : Math.max(12, Math.ceil(end + (sh.text.margins ? sh.text.margins[3] : 0) + 2));
      if (sh.y + sh.h > doc.height + 0.5) off = true;
    }
    rerender(page);
    showSel();
    syncToolbar();
    if (off) showNotes(['The box now runs past the bottom of the page: move it up, or make the text smaller.'], 6000);
  }
  /** Makes the text of each selected box smaller, in half-point steps, until it all shows. */
  function shrinkTextToFit() {
    const list = fitTargets().filter((sh) => overflowing(sel.page, sh));
    if (!list.length) { showNotes(['The text already fits.'], 3000); return; }
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    let stuck = false;
    for (const sh of list) {
      const orig = clone(sh.text.paras);
      const sizes = orig.flatMap((p) => p.runs.filter((r) => !r.object).map((r) => r.size || 11));
      const max = Math.max(6.5, ...sizes);
      const steps = Math.ceil((max - 6) / 0.5);
      const apply = (n) => {
        const f = (max - 0.5 * n) / max;
        sh.text.paras = clone(orig);
        for (const p of sh.text.paras) for (const r of p.runs) if (!r.object) r.size = Math.max(6, Math.round((r.size || 11) * f * 2) / 2);
        rerender(page);
        return !overflowing(page, sh);
      };
      // the fewest steps that make it fit
      if (!apply(steps)) { stuck = true; continue; }
      let lo = 1, hi = steps;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (apply(mid)) hi = mid; else lo = mid + 1;
      }
      apply(hi);
    }
    showSel();
    syncToolbar();
    if (stuck) showNotes(["Even at 6 pt the text doesn't fit: make the box bigger, or use Make box fit text."], 7000);
  }


  // ---- drawing new boxes, shapes and lines with the mouse -----------------------------------------
  // A tool is chosen with a button; then a click on the page puts the thing there at its usual
  // size, or a drag draws it at the size wanted. Esc (or Cancel) puts the tool down.
  let tool = null;
  const TOOL_NAMES = { text: 'a text box', line: 'a line' };
  function armTool(kind, type, name) {
    if (!doc) return;
    commitEdit();
    closeMenus();
    tool = { kind, type };
    document.body.classList.add('drawing');
    const what = name || TOOL_NAMES[kind] || 'the shape';
    $('toolhint').firstChild.textContent = kind === 'line' ? 'Drag on the page from one end of the line to the other.' : `Click on the page to add ${what}, or drag to draw it the size you want.`;
    $('toolhint').hidden = false;
    updateSelInfo('Drawing ' + what + ' – Esc to cancel');
  }
  function cancelTool() {
    if (!tool) return false;
    tool = null;
    document.body.classList.remove('drawing');
    $('toolhint').hidden = true;
    updateSelInfo();
    return true;
  }
  /** Puts the chosen thing on the page: `f` its frame, `flip` for a line drawn right to left or upwards. */
  function placeTool(page, f, flip) {
    const t = tool;
    cancelTool();
    if (!t) return;
    if (current !== page) setCurrent(page, true);
    if (t.kind === 'text') addShape({ kind: 'text', shape_type: 202, x: f.x, y: f.y, w: f.w, h: f.h, text: newTextBody() }, true);
    else if (t.kind === 'line') {
      const s = { kind: 'line', shape_type: 20, x: f.x, y: f.y, w: f.w, h: f.h, line: { color: '#000000', width: 1 } };
      if (flip && flip.h) s.flip_h = true;
      if (flip && flip.v) s.flip_v = true;
      addShape(s, false);
    } else addShape({ kind: 'shape', shape_type: t.type, x: f.x, y: f.y, w: f.w, h: f.h, line: { color: '#000000', width: 0.75 }, fill: { color: '#ffffff', opacity: 1 } }, false);
  }
  /** The usual size of what a tool puts on the page with a click. */
  function toolSize(t) {
    return t.kind === 'text' ? [220, 60] : t.kind === 'line' ? [150, 0] : [140, 90];
  }

  // ---- lining things up while moving, sizing and drawing ------------------------------------------
  // Edges and centres snap to the page's edges, centre and margins (1.27 cm) and to other objects'
  // edges and centres when they come within a few pixels; a pink guide shows what lined up. Hold
  // Alt to place freely.
  const SNAP_MARGIN = 36;
  function snapTargets(page, skip) {
    const W = doc.width, H = doc.height;
    const xs = [0, W / 2, W, SNAP_MARGIN, W - SNAP_MARGIN], ys = [0, H / 2, H, SNAP_MARGIN, H - SNAP_MARGIN];
    for (const s of doc.pages[page].shapes) {
      if ((skip && skip.includes(s)) || !inMode(s)) continue;
      const b = aabb(s);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { xs, ys };
  }
  /** The smallest move that puts one of `cands` on one of `targets` (within `tol`), or null. */
  function snap1(cands, targets, tol) {
    let best = null;
    for (const c of cands) for (const t of targets) {
      const d = t - c;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
    return best;
  }
  function showGuides(sheetEl, gx, gy) {
    for (const g of sheetEl.querySelectorAll('.snapline')) g.remove();
    if (gx != null) { const g = document.createElement('div'); g.className = 'snapline v'; g.style.left = gx * k() + 'px'; sheetEl.appendChild(g); }
    if (gy != null) { const g = document.createElement('div'); g.className = 'snapline h'; g.style.top = gy * k() + 'px'; sheetEl.appendChild(g); }
  }
  function clearGuides() {
    for (const g of pagesEl.querySelectorAll('.snapline')) g.remove();
  }
  const snapTol = () => 6 / k();

  // ---- the right-click menu ---------------------------------------------------------------------
  function ctxItem(label, keys, fn, enabled) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.appendChild(document.createTextNode(label));
    if (keys) b.appendChild(mk('kbd', '', keys));
    if (enabled === false) b.disabled = true;
    b.addEventListener('click', () => { hideCtx(); fn(); });
    return b;
  }
  function hideCtx() {
    $('ctxmenu').hidden = true;
  }
  /** Starts typing in a selected box (or WordArt's words), at the end of its text. */
  function editTextOf(page, shape) {
    if (shape.wordart) { editWordArt(page, shape); return; }
    if (!shape.text && (shape.kind === 'shape' || shape.kind === 'text')) {
      pushUndo(page);
      shape.text = newTextBody();
      rerender(page);
    }
    const el = shapeEl(page, shape);
    const flow = el && el.querySelector('.op-flow');
    if (flow && flow.opOwner) startEdit(page, shape, flow, null, { a: { p: 1e6, o: 1e9 }, b: { p: 1e6, o: 1e9 } });
  }
  function showCtx(x, y, page, shape, at) {
    const m = $('ctxmenu');
    m.textContent = '';
    const add = (b) => m.appendChild(b);
    const sep = () => m.appendChild(document.createElement('hr'));
    if (shape) {
      const one = sel && sel.shapes.length === 1;
      add(ctxItem('Cut', 'Ctrl+X', () => copyButton(true)));
      add(ctxItem('Copy', 'Ctrl+C', () => copyButton(false)));
      add(ctxItem('Paste', 'Ctrl+V', pasteButton));
      add(ctxItem('Duplicate', '', duplicate));
      add(ctxItem('Delete', 'Del', removeSelected));
      sep();
      if (one && (shape.wordart || shape.kind === 'text' || shape.kind === 'shape')) add(ctxItem(shape.wordart ? 'Edit the words' : 'Type text in it', 'Enter', () => editTextOf(page, shape)));
      if (one && shape.image != null && shape.kind === 'picture') add(ctxItem('Change picture…', '', replacePicture));
      if (one && (shape.kind === 'text' || shape.text) && !shape.wordart) add(ctxItem('Make box fit text', '', fitBoxToText, fitTargets().length > 0));
      add(ctxItem('Bring to front', '', () => reorder(true)));
      add(ctxItem('Send to back', '', () => reorder(false)));
      if (sel && sel.shapes.length > 1) add(ctxItem('Group', '', groupSel));
      if (one && shape.kind === 'group') add(ctxItem('Ungroup', '', ungroupSel));
    } else {
      add(ctxItem('Paste', 'Ctrl+V', pasteButton));
      add(ctxItem('Select all', 'Ctrl+A', selectAll));
      sep();
      add(ctxItem('Add a text box here', '', () => {
        tool = { kind: 'text' };
        placeTool(page, { x: Math.max(0, Math.min(doc.width - 220, at.x)), y: Math.max(0, Math.min(doc.height - 60, at.y)), w: 220, h: 60 });
      }));
      add(ctxItem('Add a picture…', '', insertPicture));
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    // in text being typed, and in boxes to type in: Windows' own menu (spelling, cut, copy, paste)
    if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    e.preventDefault();
    hideCtx();
    if (!doc || busy || drag) return;
    const sheetEl = t.closest && t.closest('.sheet');
    if (!sheetEl || !sheetEl.opSheet) return;
    cancelTool();
    closeMenus();
    const page = sheetEl.opSheet.index;
    const shape = topShape(t, sheetEl);
    if (current !== page) setCurrent(page, true);
    if (shape && !(sel && sel.page === page && sel.shapes.includes(shape))) select(page, shape);
    if (!shape) select(page, null);
    showCtx(e.clientX, e.clientY, page, shape, sheetPoint(sheetEl, e.clientX, e.clientY));
  });
  document.addEventListener('pointerdown', (e) => { if (!$('ctxmenu').contains(e.target)) hideCtx(); }, true);
  $('ctxmenu').addEventListener('keydown', (e) => {
    const items = [...$('ctxmenu').querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); hideCtx(); view.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]; if (n) n.focus(); }
    e.stopPropagation();
  });

  // ---- colour swatches --------------------------------------------------------------------------
  // The colour boxes open a palette (and the publication's own and recently used colours); "More
  // colours…" opens Windows' colour picker.
  const SWATCHES = [
    '#000000', '#262626', '#404040', '#595959', '#7f7f7f', '#a6a6a6', '#bfbfbf', '#d9d9d9', '#f2f2f2', '#ffffff',
    '#b71c1c', '#e65100', '#f9a825', '#1b5e20', '#00695c', '#01579b', '#0d47a1', '#1a237e', '#4a148c', '#880e4f',
    '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#039be5', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60',
    '#e57373', '#ffb74d', '#fff176', '#81c784', '#4db6ac', '#4fc3f7', '#64b5f6', '#7986cb', '#ba68c8', '#f06292',
    '#ffcdd2', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b2dfdb', '#b3e5fc', '#bbdefb', '#c5cae9', '#e1bee7', '#f8bbd0',
  ];
  const COLOUR_INPUTS = ['color', 'pgbg', 'fill', 'fill2', 'shadowcolor', 'linecolor', 'cellfill', 'tblhead', 'tblband', 'bcolor'];
  const recentColours = [];
  let swatchFor = null;
  /** The colours the publication uses most (up to 10). */
  function docColours() {
    const n = new Map();
    const count = (c) => { if (isHex(c)) { c = c.toLowerCase(); n.set(c, (n.get(c) || 0) + 1); } };
    const walk = (s) => {
      if (s.fill) { count(s.fill.color); count(s.fill.color2); }
      if (s.line) count(s.line.color);
      for (const o of owners(s)) for (const p of o.paras) for (const r of p.runs) count(r.color);
      for (const c of s.children || []) walk(c);
    };
    if (doc) for (const p of doc.pages) { count(p.background); for (const s of p.shapes) walk(s); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 10);
  }
  function addRecentColour(c) {
    if (!isHex(c)) return;
    c = c.toLowerCase();
    const i = recentColours.indexOf(c);
    if (i >= 0) recentColours.splice(i, 1);
    recentColours.unshift(c);
    recentColours.length = Math.min(recentColours.length, 10);
  }
  function chooseColour(input, c) {
    hideSwatches();
    input.value = c;
    addRecentColour(c);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function openSwatches(input) {
    const p = $('swatchpop');
    p.textContent = '';
    swatchFor = input;
    const group = (title, list) => {
      if (!list.length) return;
      p.appendChild(mk('h4', '', title));
      const g = mk('div', 'sw');
      for (const c of list) {
        const b = document.createElement('button');
        b.style.background = c;
        b.title = c;
        b.setAttribute('aria-label', 'Colour ' + c);
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => chooseColour(input, c));
        g.appendChild(b);
      }
      p.appendChild(g);
    };
    group('Colours', SWATCHES);
    group('In this publication', docColours());
    group('Recently used', recentColours);
    const more = mk('button', 'more', 'More colours…');
    more.addEventListener('click', () => {
      hideSwatches();
      input.opNative = true;
      try { input.showPicker(); } catch (_) { input.click(); }
    });
    p.appendChild(more);
    p.hidden = false;
    const r = input.closest('label') ? input.closest('label').getBoundingClientRect() : input.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    p.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pr.width - 6)) + 'px';
    p.style.top = Math.min(r.bottom + 3, window.innerHeight - pr.height - 6) + 'px';
  }
  function hideSwatches() {
    $('swatchpop').hidden = true;
    swatchFor = null;
  }
  for (const id of COLOUR_INPUTS) {
    const input = $(id);
    if (!input) continue;
    input.addEventListener('click', (e) => {
      if (input.opNative) { input.opNative = false; return; } // "More colours…": Windows' picker
      e.preventDefault();
      if (input.disabled) return;
      if (swatchFor === input) { hideSwatches(); return; }
      closeMenus();
      openSwatches(input);
    });
    input.addEventListener('change', () => addRecentColour(input.value));
  }
  document.addEventListener('pointerdown', (e) => {
    if ($('swatchpop').hidden || $('swatchpop').contains(e.target)) return;
    if (swatchFor && (e.target === swatchFor || (swatchFor.closest('label') && swatchFor.closest('label').contains(e.target)))) return;
    hideSwatches();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('swatchpop').hidden) { hideSwatches(); e.stopPropagation(); } }, true);

  // ---- arrowheads -------------------------------------------------------------------------------
  function setArrows(v) {
    editShapes((s) => {
      if (s.kind !== 'line' || !s.line) return;
      const start = v === 'start' || v === 'both', end = v === 'end' || v === 'both';
      s.line.start_arrow = start ? 1 : 0;
      s.line.end_arrow = end ? 1 : 0;
      for (const key of ['start_arrow_w', 'start_arrow_l', 'end_arrow_w', 'end_arrow_l']) if (s.line[key] == null) s.line[key] = 1;
    });
  }

  // ---- pictures dropped on the page or pasted ----------------------------------------------------
  function pastePicture(file) {
    if (file.size > 50 * 1024 * 1024) { showNotes(['The pasted picture is too large to add (the limit is 50 MB).']); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      const data = s.slice(s.indexOf(',') + 1);
      send({ cmd: 'pastePicture', data });
    };
    fr.readAsDataURL(file);
  }
  /** Pictures read by the program (`list` of { index, w, h, mime }), put on the page where they
   * were dropped (`at`: a point of the window in device pixels) or in view. */
  function picturesAdded(list, at) {
    if (!doc || !list || !list.length) return;
    version++;
    commitEdit();
    cancelTool();
    let page = current, cx = null, cy = null;
    if (at) {
      const dpr = window.devicePixelRatio || 1;
      const x = at[0] / dpr, y = at[1] / dpr;
      const t = document.elementFromPoint(x, y);
      const sh = t && t.closest && t.closest('.sheet');
      if (sh && sh.opSheet) {
        page = sh.opSheet.index;
        const p = sheetPoint(sh, x, y);
        cx = p.x;
        cy = p.y;
      }
    }
    if (page !== current) setCurrent(page, true);
    pushUndo(page);
    const most = list.length > 1 ? 0.4 : 0.6;
    const added = list.map((it, n) => {
      if (doc.images && !doc.images[it.index]) doc.images[it.index] = { mime: it.mime || 'image/png', orientation: 1 };
      let pw = it.w * 0.75, ph = it.h * 0.75;
      const f = Math.min(1, (doc.width * most) / pw, (doc.height * most) / ph);
      pw *= f;
      ph *= f;
      let x, y;
      if (cx != null) { x = cx - pw / 2 + n * 12; y = cy - ph / 2 + n * 12; } else { const p = visibleSpot(pw, ph); x = p.x + n * 12; y = p.y + n * 12; }
      x = Math.max(0, Math.min(doc.width - pw, x));
      y = Math.max(0, Math.min(doc.height - ph, y));
      return { kind: 'picture', shape_type: 75, x, y, w: pw, h: ph, image: it.index, seq: nextSeq++ };
    });
    insertShapes(page, added);
    sel = { page, shape: added[added.length - 1], shapes: added };
    textSel = null;
    cellSel = null;
    cropMode = false;
    rerender(page);
    showSel();
    updateButtons();
    syncToolbar();
  }


  // ---- picture borders (BorderArt) -------------------------------------------------------------
  // Built-in borders are drawn here as small pictures (one picture for every position: they are
  // the same all round); borders already in the publication (from Publisher) can be chosen too.
  const BORDER_ART = {
    stars: '<path d="M32 4l8.2 17.6 19.3 2.3-14.2 13.2 3.7 19.1L32 46.8 15 56.2l3.7-19.1L4.5 23.9l19.3-2.3z" fill="#f9c80e" stroke="#c98a00" stroke-width="2"/>',
    hearts: '<path d="M32 56S6 40 6 22c0-9 7-15 14-15 6 0 10 4 12 8 2-4 6-8 12-8 7 0 14 6 14 15 0 18-26 34-26 34z" fill="#e53935" stroke="#a31515" stroke-width="2"/>',
    dots: '<circle cx="32" cy="32" r="14" fill="#23211d"/>',
    flowers: '<g fill="#ec407a"><circle cx="32" cy="16" r="11"/><circle cx="47" cy="27" r="11"/><circle cx="41" cy="45" r="11"/><circle cx="23" cy="45" r="11"/><circle cx="17" cy="27" r="11"/></g><circle cx="32" cy="32" r="8" fill="#fdd835"/>',
    squares: '<rect x="12" y="12" width="40" height="40" rx="4" fill="#1e88e5" stroke="#0d47a1" stroke-width="2"/>',
    checks: '<rect width="64" height="64" fill="#fff"/><rect width="32" height="32" fill="#23211d"/><rect x="32" y="32" width="32" height="32" fill="#23211d"/>',
    apples: '<path d="M32 18c-4-4-14-5-19 2-6 9-1 26 8 32 4 3 7 2 11 0 4 2 7 3 11 0 9-6 14-23 8-32-5-7-15-6-19-2z" fill="#d32f2f" stroke="#8e1b1b" stroke-width="2"/><path d="M32 18c0-6 2-10 6-12" stroke="#5d4037" stroke-width="3" fill="none"/><path d="M34 12c6-6 14-4 16 0-6 4-12 4-16 0z" fill="#43a047"/>',
    smiles: '<circle cx="32" cy="32" r="26" fill="#fdd835" stroke="#c98a00" stroke-width="2"/><circle cx="23" cy="26" r="4" fill="#23211d"/><circle cx="41" cy="26" r="4" fill="#23211d"/><path d="M19 37q13 13 26 0" stroke="#23211d" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
  };
  const borderImages = new Map(); // design -> picture number (for this publication)
  let imageWait = new Map(), imageToken = 0;
  function svgToPng(inner, px) {
    return new Promise((resolve, reject) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${inner}</svg>`;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = px;
        c.height = px;
        c.getContext('2d').drawImage(img, 0, 0, px, px);
        const u = c.toDataURL('image/png');
        resolve(u.slice(u.indexOf(',') + 1));
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }
  /** Stores pictures made here with the program; resolves to their numbers. */
  function addImages(list) {
    const token = 'i' + (++imageToken);
    return new Promise((resolve) => {
      imageWait.set(token, resolve);
      send({ cmd: 'addImages', token, list });
      setTimeout(() => { if (imageWait.has(token)) { imageWait.delete(token); resolve(null); } }, 10000);
    });
  }
  function imagesAdded(token, list) {
    const done = imageWait.get(token);
    if (!done) return;
    imageWait.delete(token);
    for (const i of list) if (Number.isInteger(i) && doc && doc.images && !doc.images[i]) doc.images[i] = { mime: 'image/png', orientation: 1 };
    version++;
    done(list);
  }
  /** Gives the selected shapes a picture border (`design`: a built-in name, or "doc:<n>" for the
   * n-th border already in the publication), or takes it off (''). */
  async function setBorderArt(design) {
    if (!sel || !doc) return;
    const shapes = sel.shapes.filter((s) => s.kind !== 'line' && s.kind !== 'group' && s.kind !== 'table');
    if (!shapes.length) return;
    if (!design) { editShapes((s) => { if (shapes.includes(s)) delete s.border_art; }, true); return; }
    let tiles = null;
    if (design.startsWith('doc:')) {
      tiles = docBorders()[parseInt(design.slice(4), 10)] || null;
    } else if (BORDER_ART[design]) {
      if (!borderImages.has(design)) {
        const png = await svgToPng(BORDER_ART[design], 96);
        const got = await addImages([png]);
        if (!got || !Number.isInteger(got[0])) { showNotes(["The picture border couldn't be made."]); return; }
        borderImages.set(design, got[0]);
      }
      tiles = new Array(8).fill(borderImages.get(design));
    }
    if (!tiles) return;
    const size = Math.max(4, Math.min(72, num('bordersize') || 16));
    editShapes((s) => {
      if (!shapes.includes(s)) return;
      s.border_art = { tiles: tiles.slice(), size: (s.border_art && s.border_art.size) || size };
      delete s.line;
    }, true);
  }
  function setBorderSize(v) {
    if (!(v > 0)) return;
    v = Math.max(4, Math.min(72, v));
    editShapes((s) => { if (s.border_art) s.border_art.size = v; }, true);
  }
  /** The picture borders already in the publication (their tiles). */
  function docBorders() {
    const seen = new Map();
    const walk = (s) => { if (s.border_art && Array.isArray(s.border_art.tiles)) seen.set(s.border_art.tiles.join(','), s.border_art.tiles); (s.children || []).forEach(walk); };
    if (doc) for (const p of doc.pages) p.shapes.forEach(walk);
    return [...seen.values()];
  }
  /** The border list: the built-in ones, then the publication's own. */
  function fillBorderList() {
    const sel_ = $('borderart');
    for (const o of [...sel_.querySelectorAll('option[data-doc]')]) o.remove();
    docBorders().forEach((t, i) => {
      if (BORDER_ART && [...borderImages.values()].includes(t[0]) && t.every((x) => x === t[0])) return; // (a built-in one)
      const o = document.createElement('option');
      o.value = 'doc:' + i;
      o.dataset.doc = '1';
      o.textContent = 'From this publication ' + (i + 1);
      sel_.appendChild(o);
    });
  }

  // ---- linked text boxes ------------------------------------------------------------------------
  // A story can flow through several linked boxes, on several pages. The first box holds the
  // text; each box on the page shows a stand-in for its part ("view", render.js chainViews).

  /** The pages showing the stories of linked boxes among `shapes`, when a story runs over more
   * than one page (they all change together), else null. */
  function storyPagesOf(shapes) {
    const chains = OpenPub.storyChains(doc);
    const ids = new Set();
    const look = (s) => {
      if (s && s.text && chains.has(s.text.story)) ids.add(s.text.story);
      for (const c of (s && s.children) || []) look(c);
    };
    (shapes || []).forEach(look);
    if (!ids.size) return null;
    const pages = new Set();
    for (const id of ids) for (const f of chains.get(id)) pages.add(f.page);
    return pages.size > 1 ? [...pages].sort((a, b) => a - b) : null;
  }
  /** The flow showing a linked box's part of its story on the page (null for other boxes). */
  function chainFlow(page, shape) {
    const el = shapeEl(page, shape);
    return el ? [...el.querySelectorAll('.op-flow')].find((f) => f.opOwner && f.opOwner._commit) || null : null;
  }
  /** The text body to change for `owner` now: a linked box's stand-in is replaced each time the
   * page is drawn, so an old one is swapped for the current one. */
  function liveOwner(page, shape, owner) {
    if (!owner || !owner._commit) return owner;
    const f = chainFlow(page, shape);
    return f ? f.opOwner : owner;
  }
  /** Puts changes made to stand-ins back into their stories. */
  function commitViews(list) {
    for (const o of list) if (o && o._commit && JSON.stringify(o.paras) !== o._orig) o._commit(o.paras);
  }
  let lastStory = 0;
  /** A story number no text in the publication has (nor any handed out before). */
  function freshStory() {
    let n = lastStory;
    const walk = (list) => { for (const s of list) { if (s.text && s.text.story > n) n = s.text.story; if (s.children) walk(s.children); } };
    doc.pages.forEach((pg) => walk(pg.shapes));
    lastStory = n + 1;
    return lastStory;
  }
  /** Copies of shapes (`copies`, made from `origs` on page `page`): copies of linked boxes from
   * one story become a chain of their own (or, alone, an ordinary text box) holding the text the
   * originals show, so they don't join the original story. Every copied text gets a new story. */
  function unlinkCopies(origs, copies, page) {
    const chains = OpenPub.storyChains(doc);
    const groups = new Map();
    const pair = (o, c) => {
      if (o.text && c.text) {
        if (chains.has(o.text.story)) {
          if (!groups.has(o.text.story)) groups.set(o.text.story, []);
          groups.get(o.text.story).push({ o, c });
        } else c.text.story = freshStory();
      }
      (o.children || []).forEach((oc, i) => c.children && c.children[i] && pair(oc, c.children[i]));
    };
    origs.forEach((o, i) => copies[i] && pair(o, copies[i]));
    for (const [id, list] of groups) {
      list.sort((x, y) => (x.o.text.chain || 0) - (y.o.text.chain || 0));
      const story = chains.get(id)[0].shape.text.paras;
      const first = chainFlow(page, list[0].o), last = chainFlow(page, list[list.length - 1].o);
      const from = first ? first.opOwner._range[0] : { p: 0, o: 0 };
      const to = last ? last.opOwner._range[1] : null;
      const text = clone(OpenPub.sliceStory(story, from, to));
      const sid = freshStory();
      list.forEach(({ c }, k) => {
        c.text.story = sid;
        c.text.paras = k === 0 ? text : [];
        if (list.length > 1 && k > 0) c.text.chain = k;
        else delete c.text.chain;
      });
    }
  }
  /** Pasted copies get stories of their own (each paste is a new copy). */
  function restory(copies) {
    const map = new Map();
    const walk = (s) => {
      if (s.text && s.text.story != null) {
        if (!map.has(s.text.story)) map.set(s.text.story, freshStory());
        s.text.story = map.get(s.text.story);
      }
      (s.children || []).forEach(walk);
    };
    copies.forEach(walk);
  }

  // ---- find and replace -----------------------------------------------------------------------

  /** The text of a paragraph as searched: one character per text character; objects and fields
   * can't match. */
  const paraText = (para) => para.runs.map((r) => (r.object || r.field ? '\uFFFC' : r.text.replace(/\u00AD/g, ''))).join('');
  /** Lower case, one character for one (a few letters, such as the Turkish İ, become two
   * characters in lower case: they're left as they are so positions stay right). */
  function lower(s) {
    let out = '';
    for (const ch of s) {
      const l = ch.toLowerCase();
      out += l.length === ch.length ? l : ch;
    }
    return out;
  }

  /** Every match in the publication, in reading order: { page, shape, oi, owner, p, o, len }. */
  function findMatches(q, matchCase) {
    const out = [];
    if (!q || !doc) return out;
    const needle = matchCase ? q : lower(q);
    doc.pages.forEach((pg, page) => {
      let oi = 0;
      for (const shape of pg.shapes) {
        const own = owners(shape);
        // master-page items are edited on the master page
        const skip = !!shape.from_master !== !!masterMode;
        for (const owner of own) {
          if (!skip) {
            owner.paras.forEach((para, p) => {
              const hay = matchCase ? paraText(para) : lower(paraText(para));
              for (let o = hay.indexOf(needle); o >= 0; o = hay.indexOf(needle, o + needle.length)) out.push({ page, shape, oi, owner, p, o, len: needle.length });
            });
          }
          oi++;
        }
      }
    });
    return out;
  }
  const findKey = (m) => [m.page, m.oi, m.p, m.o];
  const keyLess = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

  let findLast = null; // the match shown
  function clearFindMark() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete('op-find');
  }
  function showFind(replace) {
    if (!doc) return;
    // start from the text selected in the publication
    const s = window.getSelection();
    const picked = editing && s.rangeCount && editing.flow.contains(s.anchorNode) ? plainOf(String(s)).trim() : '';
    commitEdit();
    closeMenus();
    $('findbar').hidden = false;
    if (picked && picked.length < 80 && !picked.includes('\n')) { $('findq').value = picked; findLast = null; }
    const f = replace && $('findq').value ? $('findr') : $('findq');
    f.focus();
    f.select();
  }
  function hideFind() {
    if ($('findbar').hidden) return;
    $('findbar').hidden = true;
    clearFindMark();
    findLast = null;
    view.focus({ preventScroll: true });
  }

  /** Shows a match: its page, its text box selected, the text marked. */
  /** Where a match in a story of linked boxes is shown: the box, page, stand-in and position. */
  function chainSpot(m) {
    const frames = m.shape.text && m.owner === m.shape.text ? OpenPub.storyChains(doc).get(m.shape.text.story) : null;
    if (!frames) return null;
    const before = (x, y) => x.p < y.p || (x.p === y.p && x.o <= y.o);
    for (const f of frames) {
      if (sheets[f.page]) renderSheet(sheets[f.page]);
      const flow = chainFlow(f.page, f.shape);
      if (!flow) continue;
      const [a, b] = flow.opOwner._range;
      if (before(a, m) && (!b || !before(b, { p: m.p, o: m.o + 1 }))) {
        return { page: f.page, shape: f.shape, owner: flow.opOwner, p: m.p - a.p, o: m.p === a.p ? m.o - a.o : m.o, len: m.len };
      }
    }
    return null;
  }
  function showMatch(match) {
    commitEdit();
    const m = Object.assign({}, match, chainSpot(match) || {});
    if (current !== m.page) goTo(m.page);
    const sheet = sheets[m.page];
    if (sheet) renderSheet(sheet);
    select(m.page, m.shape);
    clearFindMark();
    const flow = findFlow(m.page, m.shape, m.owner);
    const a = flow && fromOffset(flow, { p: m.p, o: m.o }), b = flow && fromOffset(flow, { p: m.p, o: m.o + m.len });
    let target = shapeEl(m.page, m.shape);
    if (a && b && window.Highlight && CSS.highlights) {
      const r = document.createRange();
      try {
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        CSS.highlights.set('op-find', new Highlight(r));
        target = r;
      } catch (e) { /* the box is selected instead */ }
    }
    // bring it into view (below the find box)
    if (target) {
      const box = target.getBoundingClientRect(), v = view.getBoundingClientRect();
      if (box.top < v.top + 90 || box.bottom > v.bottom - 30) view.scrollTop += box.top - (v.top + Math.min(200, v.height / 3));
      if (box.left < v.left + 10 || box.right > v.right - 10) view.scrollLeft += box.left - (v.left + v.width / 3);
    }
    findLast = match;
  }

  function findNext(quiet) {
    const q = $('findq').value;
    const all = findMatches(q, $('findcase').checked);
    const msg = $('findmsg');
    if (!q) { msg.textContent = ''; return null; }
    if (!all.length) { clearFindMark(); findLast = null; msg.textContent = 'No matches'; return null; }
    // after the match shown, or from the top of the page in view
    const from = findLast ? findKey(findLast) : [current, -1, 0, -1];
    let i = all.findIndex((m) => keyLess(from, findKey(m)));
    const wrapped = i < 0;
    if (wrapped) i = 0;
    showMatch(all[i]);
    if (!quiet) msg.textContent = `${i + 1} of ${all.length}` + (wrapped && findLast ? ' · from the start' : '');
    $('findq').focus({ preventScroll: true });
    return all[i];
  }

  /** Puts `text` in place of `len` characters at `o`, in the formatting of the first of them. */
  function replaceRange(para, o, len, text) {
    const out = [];
    let pos = 0, put = false;
    for (const r of para.runs) {
      const n = visLen(r);
      const a = Math.max(o, pos), b = Math.min(o + len, pos + n);
      if (!r.object && !r.field && b > a) {
        out.push(Object.assign({}, r, { text: r.text.slice(0, textIndex(r.text, a - pos)) + (put ? '' : text) + r.text.slice(textIndex(r.text, b - pos)) }));
        put = true;
      } else out.push(r);
      pos += n;
    }
    const kept = out.filter((r) => r.object || r.field || r.text);
    para.runs = kept.length ? kept : [Object.assign({}, out[0], { text: '' })];
  }
  const stillThere = (m, q, matchCase) => {
    const para = m.owner.paras[m.p];
    if (!para || !doc.pages[m.page] || !doc.pages[m.page].shapes.includes(m.shape)) return false;
    const t = paraText(para).substr(m.o, m.len);
    return matchCase ? t === q : lower(t) === lower(q);
  };

  function replaceOne() {
    const q = $('findq').value, matchCase = $('findcase').checked;
    if (!q) return;
    if (!findLast || !stillThere(findLast, q, matchCase)) { findLast = null; findNext(); return; }
    const m = findLast, text = $('findr').value;
    const many = storyPagesOf([m.shape]);
    if (many) pushUndo(); else pushUndo(m.page);
    replaceRange(m.owner.paras[m.p], m.o, m.len, text);
    if (many) many.forEach(rerender); else rerender(m.page);
    // go on after the new text (it may contain the search text itself)
    findLast = Object.assign({}, m, { o: m.o + text.length - 1, len: 0 });
    const next = findNext();
    if (!next) { hideSel(); $('findmsg').textContent = 'Replaced · no more matches'; }
  }

  function replaceAll() {
    const q = $('findq').value;
    const all = findMatches(q, $('findcase').checked);
    if (!q) return;
    if (!all.length) { $('findmsg').textContent = 'No matches'; return; }
    commitEdit();
    const text = $('findr').value;
    pushUndo(); // every page in one step
    // from the end of each paragraph, so earlier positions stay right
    for (let i = all.length - 1; i >= 0; i--) replaceRange(all[i].owner.paras[all[i].p], all[i].o, all[i].len, text);
    clearFindMark();
    findLast = null;
    sel = null;
    textSel = null;
    cellSel = null;
    hideSel();
    const pages = new Set(all.map((m) => m.page));
    for (const pg of storyPagesOf(all.map((m) => m.shape)) || []) pages.add(pg);
    for (const pg of pages) redraw(pg);
    updateButtons();
    syncToolbar();
    $('findmsg').textContent = `Replaced ${all.length} ${all.length === 1 ? 'match' : 'matches'}`;
  }

  // paragraph commands
  let lastBullet = '•', lastNumber = 0;
  function listIndent(p) {
    if (!(p.first < 0)) {
      p.left = (p.left || 0) + LIST_INDENT;
      p.first = -LIST_INDENT;
    }
  }
  function setBullet(ch) {
    if (!ch) { clearList(); return; }
    lastBullet = ch;
    format({ para: (p) => {
      const had = !!p.bullet;
      p.bullet = { text: ch };
      if (!had) listIndent(p);
    } });
  }
  function setNumbering(fmt, start) {
    if (fmt == null || fmt < 0) { clearList(); return; }
    lastNumber = fmt;
    format({ para: (p, i, list, first) => {
      const had = !!p.bullet;
      p.bullet = { text: '', number: fmt };
      if (first && start > 1) p.bullet.start = Math.min(32767, Math.round(start));
      if (!had) listIndent(p);
    } });
  }
  function clearList() {
    format({ para: (p) => {
      if (!p.bullet) return;
      delete p.bullet;
      if (p.first < 0) {
        p.left = Math.max(0, (p.left || 0) + p.first);
        p.first = 0;
      }
    } });
  }
  function toggleBullets() {
    const st = currentStyle();
    if (st && st.para.bullet && st.para.bullet.number == null) clearList(); else setBullet(lastBullet);
  }
  function toggleNumbering() {
    const st = currentStyle();
    if (st && st.para.bullet && st.para.bullet.number != null) clearList(); else setNumbering(lastNumber);
  }
  function indent(dir) {
    format({ para: (p) => {
      p.left = Math.max(0, (p.left || 0) + dir * LIST_INDENT);
      if ((p.first || 0) < -p.left) p.first = -p.left;
    } });
  }
  /** Line spacing: a multiple of single spacing, or exactly `v` points. */
  function setSpacing(v, exact) {
    if (!(v > 0)) return;
    v = Math.min(v, exact ? 1600 : 10);
    format({ para: (p) => {
      p.spacing = v;
      if (exact) p.spacing_exact = true; else delete p.spacing_exact;
    } });
  }
  function setParaSpace(key, v) {
    if (!(v >= 0)) return;
    v = Math.min(v, 1600);
    format({ para: (p) => { p[key] = v; } });
  }

  /** Formatting at the start of the selection (for showing in the toolbar). */
  function currentStyle() {
    let para = null, run = null;
    if (textSel) {
      para = textSel.owner.paras[Math.min(textSel.a.p, textSel.owner.paras.length - 1)];
      if (para) {
        let pos = 0;
        run = para.runs[0];
        for (const r of para.runs) {
          const len = r.object ? 1 : r.text.length;
          if (!r.object && textSel.a.o < pos + len) { run = r; break; }
          if (!r.object) run = r;
          pos += len;
        }
      }
    } else if (sel) {
      const o = targetOwners()[0];
      para = o && o.paras[0];
      run = para && para.runs.find((r) => !r.object);
    }
    if (!run) return null;
    return { font: run.font, size: run.size, bold: !!run.bold, italic: !!run.italic, underline: !!run.underline, strike: !!run.strike, script: run.script || 0, color: run.color, align: para.align, para };
  }

  const fmtCm = (v) => String(Math.round((v / CM) * 100) / 100);
  const fmtPt = (v) => String(Math.round(v * 100) / 100);
  /** A length typed by the user ("2.5", "2,5 cm", "12pt", "1in", "20 mm") in points. */
  function parseLen(s, unit) {
    const m = String(s).trim().replace(',', '.').match(/^(-?\d*\.?\d+)\s*(cm|mm|pt|in|"|)$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const u = (m[2] || unit || 'cm').toLowerCase();
    return u === 'cm' ? v * CM : u === 'mm' ? v * CM / 10 : u === 'in' || u === '"' ? v * 72 : v;
  }
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

  function syncToolbar() {
    updateSelGeom();
    syncPageUi();
    const st = currentStyle();
    const active = document.activeElement;
    const setv = (id, v) => { const e = $(id); if (e && e !== active) e.value = v; };
    const tog = (id, on) => $(id).classList.toggle('on', !!on);
    if (st) {
      setv('font', st.font);
      setv('size', st.size);
      $('color').value = isHex(st.color) ? st.color : '#000000';
    }
    tog('bold', st && st.bold);
    tog('italic', st && st.italic);
    tog('underline', st && st.underline);
    tog('strike', st && st.strike);
    tog('super', st && st.script === 1);
    tog('sub', st && st.script === 2);
    tog('al', st && st.align === 'left');
    tog('ac', st && st.align === 'center');
    tog('ar', st && st.align === 'right');
    tog('aj', st && st.align === 'justify');
    const b = st && st.para.bullet;
    tog('bul', b && b.number == null && b.text);
    tog('num', b && b.number != null);
    setv('numstart', b && b.start ? b.start : 1);
    setv('spexact', st && st.para.spacing_exact ? fmtPt(st.para.spacing) : '');
    setv('spbefore', st ? fmtPt(st.para.before || 0) : '');
    setv('spafter', st ? fmtPt(st.para.after || 0) : '');

    // shape format
    const lv = sel ? leaves(sel.shapes).filter((s) => s.kind !== 'table') : [];
    const f = lv.find((s) => s.fill) , l = lv.find((s) => s.line);
    if (f && isHex(f.fill.color)) $('fill').value = f.fill.color;
    setv('transp', f ? Math.round((1 - (f.fill.opacity == null ? 1 : f.fill.opacity)) * 100) : '');
    if (l && isHex(l.line.color)) $('linecolor').value = l.line.color;
    const ln = lv.find((s) => s.kind === 'line' && s.line);
    if (ln) setv('arrows', ln.line.start_arrow && ln.line.end_arrow ? 'both' : ln.line.start_arrow ? 'start' : ln.line.end_arrow ? 'end' : 'none');
    // gradient, shadow, link, WordArt
    const grad = f && f.fill.color2 ? f.fill : null;
    setv('graddir', grad ? String(grad.angle || 0) : '');
    setv('pattern', f && f.fill.pattern ? f.fill.pattern : '');
    const ba = sel && sel.shapes.find((s) => s.border_art);
    if (ba) {
      fillBorderList();
      const t = ba.border_art.tiles || [];
      let v = [...borderImages.entries()].find(([, i]) => t.every((x) => x === i));
      if (v) setv('borderart', v[0]);
      else { const i = docBorders().findIndex((d) => d.join(',') === t.join(',')); setv('borderart', i >= 0 ? 'doc:' + i : ''); }
      setv('bordersize', fmtPt(ba.border_art.size));
    } else { setv('borderart', ''); setv('bordersize', ''); }
    if ($('pattern').selectedIndex < 0) $('pattern').selectedIndex = 0;
    if ($('graddir').selectedIndex < 0) $('graddir').value = '180';
    if (grad && isHex(grad.color2)) $('fill2').value = grad.color2;
    const shd = lv.find((s) => s.shadow);
    tog('shadowbtn', !!shd);
    if (shd && isHex(shd.shadow.color)) $('shadowcolor').value = shd.shadow.color;
    const linked = sel && sel.shapes.find((s) => s.link);
    $('linkbtn').classList.toggle('has', !!linked);
    if ($('linkpop').hidden) setv('linkurl', linked ? linked.link : '');
    const wa = sel && sel.shapes.length === 1 && sel.shape.wordart ? sel.shape : null;
    $('wagrp').hidden = !wa;
    if (wa) { setv('wafont', wa.wordart.font); setv('wastyle', String(wa.shape_type)); }
    // picture adjustments
    const picSel = selPicture();
    setv('picbri', picSel ? Math.round(picSel.brightness || 0) : '');
    setv('piccon', picSel ? Math.round(picSel.contrast || 0) : '');
    tog('picgray', picSel && picSel.gray);
    if (picSel) { setv('picshape', String(picSel.shape_type)); if ($('picshape').selectedIndex < 0) $('picshape').value = '75'; }
    if (sel) {
      const lw = l ? l.line.width : 0;
      const opt = [...$('linewidth').options].reduce((a, o) => (Math.abs(o.value - lw) < Math.abs(a.value - lw) ? o : a));
      $('linewidth').value = opt.value;
      $('dash').value = String(l && l.line.dash ? l.line.dash : 0);
      if (!$('dash').value) $('dash').value = '0';
    }
    const one = single();
    if (one) {
      setv('gx', fmtCm(one.x));
      setv('gy', fmtCm(one.y));
      setv('gw', fmtCm(one.w));
      setv('gh', fmtCm(one.h));
      setv('grot', fmtPt(one.rotation || 0));
    } else if (sel) {
      const u = union(sel.shapes.map(aabb));
      setv('gx', fmtCm(u.x));
      setv('gy', fmtCm(u.y));
      setv('gw', '');
      setv('gh', '');
      setv('grot', fmtPt(sel.shape.rotation || 0));
    } else for (const id of ['gx', 'gy', 'gw', 'gh', 'grot']) setv(id, '');

    // text box
    const tb = lv.find((s) => s.text);
    const body = tb && tb.text;
    const m = body ? body.margins : null;
    setv('ml', m ? fmtCm(m[0]) : '');
    setv('mt', m ? fmtCm(m[1]) : '');
    setv('mr', m ? fmtCm(m[2]) : '');
    setv('mb', m ? fmtCm(m[3]) : '');
    tog('vt', body && (body.valign || 'top') === 'top');
    tog('vm', body && body.valign === 'middle');
    tog('vb', body && body.valign === 'bottom');
    setv('ncols', body ? Math.max(1, body.columns || 1) : '');
    setv('colgap', body ? fmtCm(body.column_gap || 0) : '');

    // table
    const rg = tableRange();
    const cell = rg && rangeCells(rg)[0];
    if (cell && cell.fill && isHex(cell.fill.color)) $('cellfill').value = cell.fill.color;
    tog('cvt', cell && (cell.valign || 'top') === 'top');
    tog('cvm', cell && cell.valign === 'middle');
    tog('cvb', cell && cell.valign === 'bottom');
    const bl = cell && cell.borders.find((x) => x);
    if (bl) {
      pen.color = isHex(bl.color) ? bl.color : pen.color;
      pen.width = bl.width || pen.width;
    }
    $('bcolor').value = pen.color;
    const bopt = [...$('bwidth').options].reduce((a, o) => (Math.abs(o.value - pen.width) < Math.abs(a.value - pen.width) ? o : a));
    $('bwidth').value = bopt.value;

    // picture
    const pic = selPicture();
    const c = pic ? pic.crop || [0, 0, 0, 0] : null;
    ['crl', 'crt', 'crr', 'crb'].forEach((id, i) => setv(id, c ? Math.round(c[i] * 1000) / 10 : ''));
    $('crop').setAttribute('aria-pressed', String(cropMode));
    $('mastermode').setAttribute('aria-pressed', String(masterMode));
  }

  function en(ids, on) {
    for (const id of ids) {
      const e = $(id);
      if (!e) continue;
      e.disabled = !on;
      const l = e.closest('label');
      if (l) l.classList.toggle('disabled', !on);
    }
  }
  function updateButtons() {
    const has = !!doc && !busy;
    const s = !!sel && !busy;
    const n = sel ? sel.shapes.length : 0;
    en(['save', 'addtext', 'addpic', 'addtable', 'addrect', 'addellipse', 'addline', 'addpage', 'inspage', 'duppage', 'selall', 'mastermode', 'paste', 'findbtn', 'shapesbtn', 'pgsize', 'pgport', 'pgland', 'pgw', 'pgh', 'pgbg', 'pgbgnone', 'pgbgall', 'pgborder'], has);
    en(['delpage'], has && doc.pages.length > 1);
    en(['pageup'], has && current > 0);
    en(['pagedown'], has && current < doc.pages.length - 1);
    en(['front', 'back', 'dup', 'del', 'cut', 'copy'], s);
    en(['group'], s && n > 1);
    en(['ungroup'], s && sel.shapes.some((x) => x.kind === 'group'));
    const text = s || !!textSel;
    en(['font', 'size', 'grow', 'shrink', 'bold', 'italic', 'underline', 'strike', 'super', 'sub', 'color', 'al', 'ac', 'ar', 'aj', 'bul', 'bulmenu', 'num', 'nummenu', 'indl', 'indr', 'spbtn'], text);
    const lv = sel ? leaves(sel.shapes).filter((x) => x.kind !== 'table') : [];
    en(['fill', 'nofill', 'transp', 'graddir', 'fill2', 'pattern'], s && lv.some((x) => x.kind !== 'line'));
    en(['shadowbtn', 'shadowcolor', 'linkbtn'], s);
    en(['addwa'], has);
    en(['linecolor', 'linewidth', 'dash'], s && lv.length > 0);
    en(['arrows'], s && lv.some((x) => x.kind === 'line'));
    en(['borderart'], s && sel.shapes.some((x) => x.kind !== 'line' && x.kind !== 'group' && x.kind !== 'table'));
    en(['bordersize'], s && sel.shapes.some((x) => x.border_art));
    en(['gx', 'gy', 'grot', 'rotl', 'rotr', 'rot0'], s);
    en(['gw', 'gh'], s && n === 1);
    en(['ml', 'mt', 'mr', 'mb', 'vt', 'vm', 'vb', 'ncols', 'colgap'], s && lv.some((x) => x.text));
    en(['fitbox', 'fittext'], s && !busy && fitTargets().length > 0);
    en(['waedit'], s && n === 1 && !!sel.shape.wordart);
    const ts = selTable();
    const cs = !!ts && !!cellSel && cellSel.shape === ts;
    en(['rowabove', 'rowbelow', 'colleft', 'colright', 'cellfill', 'cellnofill', 'cvt', 'cvm', 'cvb', 'ball', 'bout', 'bin', 'bnone', 'bcolor', 'bwidth'], !!ts && !busy);
    en(['delrows', 'delcols'], cs);
    en(['merge'], cs && rangeCells(cellSel).length > 1);
    en(['split'], cs && rangeCells(cellSel).some((c) => c.r1 > c.r0 || c.c1 > c.c0));
    en(['replacepic', 'crop', 'resetcrop', 'crl', 'crt', 'crr', 'crb'], !!selPicture() && !busy);
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
    updateTabs();
  }

  // ---- ribbon tabs -------------------------------------------------------------------------

  const TABS = ['home', 'insert', 'page', 'shape', 'textbox', 'table', 'picture'];
  let activeTab = 'home';
  function showTab(name) {
    if ($('t-' + name).hidden) name = 'home';
    activeTab = name;
    for (const t of TABS) {
      const on = t === name;
      const b = $('t-' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('p-' + t).hidden = !on;
    }
  }
  function updateTabs() {
    const lv = sel ? leaves(sel.shapes) : [];
    $('t-shape').hidden = !sel;
    $('t-textbox').hidden = !lv.some((x) => x.text && x.kind !== 'table');
    $('t-table').hidden = !selTable();
    $('t-picture').hidden = !selPicture();
    if ($('t-' + activeTab).hidden) showTab('home');
  }
  for (const t of TABS) $('t-' + t).addEventListener('click', () => showTab(t));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !e.target.matches('[role=tab]')) return;
    const vis = TABS.filter((t) => !$('t-' + t).hidden);
    let i = vis.indexOf(activeTab);
    if (e.key === 'ArrowLeft') i = (i - 1 + vis.length) % vis.length;
    else if (e.key === 'ArrowRight') i = (i + 1) % vis.length;
    else if (e.key === 'Home') i = 0;
    else i = vis.length - 1;
    e.preventDefault();
    showTab(vis[i]);
    $('t-' + vis[i]).focus();
  });

  document.addEventListener('selectionchange', () => {
    if (!editing) return;
    captureSelection();
    syncToolbar();
  });

  // ---- shape commands ----------------------------------------------------------------------

  /** Changes every selected shape (members of groups, not tables) with fn. */
  function editShapes(fn, top) {
    if (!sel) return;
    commitEdit();
    pushUndo(sel.page);
    for (const s of top ? sel.shapes : leaves(sel.shapes)) if (top || s.kind !== 'table') fn(s);
    rerender(sel.page);
    syncToolbar();
  }

  function insertShapes(page, list) {
    const shapes = doc.pages[page].shapes;
    for (const c of list) {
      if (masterMode) c.from_master = true;
      else delete c.from_master;
    }
    if (masterMode) {
      // master items sit under the page's own items
      let j = 0;
      shapes.forEach((s, i) => { if (s.from_master) j = i + 1; });
      shapes.splice(j, 0, ...list);
    } else shapes.push(...list);
  }

  function removeSelected() {
    if (!sel) return;
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    const list = doc.pages[page].shapes;
    for (const sh of sel.shapes) {
      const i = list.indexOf(sh);
      if (i >= 0) list.splice(i, 1);
      fixWraps(page, sh, 0, 0, true);
    }
    sel = null;
    textSel = null;
    cellSel = null;
    cropMode = false;
    hideSel();
    rerender(page);
    updateButtons();
    syncToolbar();
  }

  function reseq(shape) {
    shape.seq = nextSeq++;
    for (const c of shape.children || []) reseq(c);
  }

  function duplicate() {
    if (!sel) return;
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    const origs = selOrdered();
    const copies = origs.map((s) => {
      const c = clone(s);
      reseq(c);
      shift(c, 12, 12);
      return c;
    });
    unlinkCopies(origs, copies, page);
    insertShapes(page, copies);
    sel = { page, shape: copies[copies.length - 1], shapes: copies };
    textSel = null;
    cellSel = null;
    rerender(page);
    updateButtons();
    syncToolbar();
  }

  function reorder(front) {
    if (!sel) return;
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    const list = doc.pages[page].shapes;
    const items = selOrdered();
    for (const s of items) list.splice(list.indexOf(s), 1);
    let j = 0;
    if (masterMode) {
      // master items stay under the page's own items
      if (front) list.forEach((s, i) => { if (s.from_master) j = i + 1; });
    } else if (front) j = list.length;
    else {
      j = 0;
      while (j < list.length && list[j].from_master) j++;
    }
    list.splice(j, 0, ...items);
    rerender(page);
  }

  function groupSel() {
    if (!sel || sel.shapes.length < 2) return;
    commitEdit();
    const page = sel.page, list = doc.pages[page].shapes;
    pushUndo(page);
    const kids = selOrdered();
    const at = list.indexOf(kids[kids.length - 1]) - (kids.length - 1);
    for (const s of kids) list.splice(list.indexOf(s), 1);
    const u = union(kids.map(aabb));
    const g = { seq: nextSeq++, kind: 'group', shape_type: 0, x: u.x, y: u.y, w: u.w, h: u.h, children: kids };
    if (masterMode) g.from_master = true;
    list.splice(Math.max(0, at), 0, g);
    sel = { page, shape: g, shapes: [g] };
    textSel = null;
    cellSel = null;
    rerender(page);
    updateButtons();
    syncToolbar();
  }

  /** Bakes a group's rotation and flips into its members before they are let go. */
  function ungroupTransform(g) {
    const r = g.rotation || 0, fh = !!g.flip_h, fv = !!g.flip_v;
    if (!r && !fh && !fv) return;
    const gx = g.x + g.w / 2, gy = g.y + g.h / 2, a = rad(r);
    for (const c of g.children || []) {
      let dx = c.x + c.w / 2 - gx, dy = c.y + c.h / 2 - gy;
      if (fh) dx = -dx;
      if (fv) dy = -dy;
      const nx = gx + dx * Math.cos(a) - dy * Math.sin(a), ny = gy + dx * Math.sin(a) + dy * Math.cos(a);
      shift(c, nx - (c.x + c.w / 2), ny - (c.y + c.h / 2));
      setRot(c, fh !== fv ? r - (c.rotation || 0) : r + (c.rotation || 0));
      if (fh) c.flip_h = !c.flip_h;
      if (fv) c.flip_v = !c.flip_v;
      if (!c.flip_h) delete c.flip_h;
      if (!c.flip_v) delete c.flip_v;
    }
  }
  function ungroupSel() {
    if (!sel) return;
    const groups = sel.shapes.filter((s) => s.kind === 'group');
    if (!groups.length) return;
    commitEdit();
    const page = sel.page, list = doc.pages[page].shapes;
    pushUndo(page);
    const out = sel.shapes.filter((s) => s.kind !== 'group');
    for (const g of groups) {
      ungroupTransform(g);
      const kids = g.children || [];
      for (const c of kids) { if (g.from_master) c.from_master = true; else delete c.from_master; }
      list.splice(list.indexOf(g), 1, ...kids);
      out.push(...kids);
    }
    sel = out.length ? { page, shape: out[out.length - 1], shapes: out } : null;
    textSel = null;
    cellSel = null;
    rerender(page);
    updateButtons();
    syncToolbar();
  }

  function nudge(dx, dy) {
    if (!sel) return;
    commitEdit();
    pushUndo(sel.page);
    for (const sh of sel.shapes) {
      shift(sh, dx, dy);
      fixWraps(sel.page, sh, dx, dy, false);
    }
    rerender(sel.page);
    syncToolbar();
  }

  /** Exact position / size from the ribbon (points). */
  function setGeom(key, v) {
    if (!sel || v == null || !isFinite(v)) return;
    v = Math.max(-14400, Math.min(14400, v)); // (200 inches either way)
    commitEdit();
    const page = sel.page;
    pushUndo(page);
    if (sel.shapes.length > 1) {
      const u = union(sel.shapes.map(aabb));
      for (const s of sel.shapes) {
        if (key === 'x') shift(s, v - u.x, 0);
        if (key === 'y') shift(s, 0, v - u.y);
      }
    } else {
      const sh = sel.shape;
      if (key === 'x') shift(sh, v - sh.x, 0);
      else if (key === 'y') shift(sh, 0, v - sh.y);
      else {
        v = Math.max(sh.kind === 'line' ? 0 : 1, v);
        const o = { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
        setFrame(sh, reframe(o, [0, 0, key === 'w' ? v - o.w : 0, key === 'h' ? v - o.h : 0], sh.rotation || 0));
      }
    }
    rerender(page);
    syncToolbar();
  }
  function setRotation(v) {
    if (v == null || !isFinite(v)) return;
    editShapes((s) => setRot(s, v), true);
  }
  function rotateBy(d) {
    editShapes((s) => setRot(s, (s.rotation || 0) + d), true);
  }
  function setFill(color) {
    editShapes((s) => {
      if (s.kind === 'line') return;
      if (color) {
        const old = s.fill && !s.fill.image ? s.fill : null;
        s.fill = { color, opacity: old && old.opacity != null ? old.opacity : 1 };
        if (old && old.color2) { s.fill.color2 = old.color2; if (old.angle) s.fill.angle = old.angle; }
        if (old && old.pattern) { s.fill.pattern = old.pattern; s.fill.back = old.back || '#ffffff'; }
      }
      else delete s.fill;
    });
  }
  function setTransparency(pct) {
    if (!(pct >= 0 && pct <= 100)) return;
    editShapes((s) => { if (s.fill) s.fill.opacity = Math.round((1 - pct / 100) * 1000) / 1000; });
  }
  function setLine(change) {
    editShapes((s) => {
      if ('width' in change && !change.width) { delete s.line; return; }
      s.line = Object.assign({ color: '#000000', width: 0.75 }, s.line, change);
      if (!s.line.dash) delete s.line.dash;
    });
  }

  // ---- text boxes ----------------------------------------------------------------------------

  function editBodies(fn) {
    if (!sel) return;
    commitEdit();
    pushUndo(sel.page);
    for (const s of leaves(sel.shapes)) if (s.text && s.kind !== 'table') fn(s.text);
    rerender(sel.page);
    syncToolbar();
  }
  function setMargin(i, v) {
    if (v == null || !(v >= 0)) return;
    v = Math.min(v, 720);
    editBodies((b) => { b.margins = (b.margins || [0, 0, 0, 0]).slice(); b.margins[i] = v; });
  }
  const setVAlign = (v) => editBodies((b) => { b.valign = v; });
  function setColumns(n) {
    n = Math.round(n);
    if (!(n >= 1 && n <= 9)) return;
    editBodies((b) => {
      b.columns = n;
      if (n > 1 && !(b.column_gap > 0)) b.column_gap = 0.5 * CM;
    });
  }
  function setColumnGap(v) {
    if (v == null || !(v >= 0)) return;
    v = Math.min(v, 720);
    editBodies((b) => { b.column_gap = v; });
  }

  // ---- tables ------------------------------------------------------------------------------

  function cellAt(t, r, c) {
    return t.cells.find((x) => x.r0 <= r && x.r1 >= r && x.c0 <= c && x.c1 >= c) || null;
  }
  /** Grows a range of the grid until no merged cell sticks out of it. */
  function normRange(t, g) {
    g = { r0: g.r0, r1: g.r1, c0: g.c0, c1: g.c1 };
    for (let changed = true; changed;) {
      changed = false;
      for (const c of t.cells) {
        if (c.r1 < g.r0 || c.r0 > g.r1 || c.c1 < g.c0 || c.c0 > g.c1) continue;
        if (c.r0 < g.r0) { g.r0 = c.r0; changed = true; }
        if (c.r1 > g.r1) { g.r1 = c.r1; changed = true; }
        if (c.c0 < g.c0) { g.c0 = c.c0; changed = true; }
        if (c.c1 > g.c1) { g.c1 = c.c1; changed = true; }
      }
    }
    return g;
  }
  function rangeCells(rg) {
    return rg.shape.table.cells.filter((c) => c.r0 >= rg.r0 && c.r1 <= rg.r1 && c.c0 >= rg.c0 && c.c1 <= rg.c1);
  }
  /** The selected cells of the selected table, or all of it. */
  function tableRange() {
    const sh = selTable();
    if (!sh) return null;
    if (cellSel && cellSel.shape === sh) return cellSel;
    return { page: sel.page, shape: sh, r0: 0, r1: sh.table.rows.length - 1, c0: 0, c1: sh.table.cols.length - 1 };
  }
  function setCells(page, sh, cell) {
    const a = { r0: cell.r0, r1: cell.r1, c0: cell.c0, c1: cell.c1 };
    cellSel = Object.assign({ page, shape: sh, anchor: a }, normRange(sh.table, a));
    textSel = null;
    showSel();
    updateButtons();
    syncToolbar();
  }
  function extendCells(cell) {
    if (!cellSel) return;
    const a = cellSel.anchor;
    Object.assign(cellSel, normRange(cellSel.shape.table, { r0: Math.min(a.r0, cell.r0), r1: Math.max(a.r1, cell.r1), c0: Math.min(a.c0, cell.c0), c1: Math.max(a.c1, cell.c1) }));
    showSel();
    updateButtons();
    syncToolbar();
  }
  /** Selects cells by grid position (r0..r1, c0..c1), as dragging over them would. */
  function selectCells(r0, c0, r1, c1) {
    const sh = selTable();
    if (!sh) return;
    const t = sh.table;
    const a = cellAt(t, r0, c0);
    if (!a) return;
    setCells(sel.page, sh, a);
    const b = cellAt(t, r1 == null ? r0 : r1, c1 == null ? c0 : c1);
    if (b && b !== a) extendCells(b);
  }
  function moveCellSel(dr, dc, extend) {
    const t = cellSel.shape.table;
    const r = Math.max(0, Math.min(t.rows.length - 1, dr > 0 ? cellSel.r1 + 1 : dr < 0 ? cellSel.r0 - 1 : cellSel.r0));
    const c = Math.max(0, Math.min(t.cols.length - 1, dc > 0 ? cellSel.c1 + 1 : dc < 0 ? cellSel.c0 - 1 : cellSel.c0));
    const cell = cellAt(t, r, c);
    if (!cell) return;
    if (extend) extendCells(cell); else setCells(cellSel.page, cellSel.shape, cell);
  }
  function colEdges(t) {
    const xs = [0];
    for (const w of t.cols) xs.push(xs[xs.length - 1] + w);
    return xs;
  }
  /** Bottom edges of the rows as laid out (rows grow to fit their text). */
  function rowEdges(page, sh) {
    const t = sh.table;
    const el = shapeEl(page, sh);
    const tb = el && el.querySelector('table');
    const ys = [0];
    if (tb && tb.rows.length === t.rows.length) for (const tr of tb.rows) ys.push((tr.offsetTop + tr.offsetHeight) * 0.75);
    else for (const h of t.rows) ys.push(ys[ys.length - 1] + h);
    return ys;
  }
  /** The grid line of a table near a point (in the table's own axes), if any. */
  function gridHit(page, sh, p) {
    const t = sh.table, tol = 4 / k();
    const xs = colEdges(t), ys = rowEdges(page, sh);
    const W = xs[xs.length - 1], H = ys[ys.length - 1];
    let best = null, bd = tol;
    if (p.y >= -tol && p.y <= H + tol) {
      for (let i = 1; i < xs.length; i++) {
        const d = Math.abs(p.x - xs[i]);
        if (d < bd) { bd = d; best = { axis: 'col', i: i - 1, pos: xs[i], size: t.cols[i - 1] }; }
      }
    }
    if (p.x >= -tol && p.x <= W + tol) {
      for (let i = 1; i < ys.length; i++) {
        const d = Math.abs(p.y - ys[i]);
        if (d < bd) { bd = d; best = { axis: 'row', i: i - 1, pos: ys[i], size: ys[i] - ys[i - 1] }; }
      }
    }
    return best;
  }
  function fitTable(sh) {
    sh.w = sh.table.cols.reduce((a, b) => a + b, 0);
    sh.h = sh.table.rows.reduce((a, b) => a + b, 0);
  }
  function emptyPara(p) {
    const q = clone(p || DEFAULT_PARA);
    const r = ((p && p.runs) || []).find((x) => !x.object) || DEFAULT_RUN;
    const run = cleanRun(Object.assign({}, r, { text: '' }));
    delete run.field;
    q.runs = [run];
    if (q.bullet) delete q.bullet.start;
    return q;
  }
  const cloneLine = (b) => (b ? Object.assign({}, b) : null);
  function blankCell(ref, area) {
    const c = Object.assign({}, area, {
      margins: ref ? ref.margins.slice() : [5.4, 2.88, 5.4, 2.88],
      valign: ref ? ref.valign || 'top' : 'top',
      borders: ref ? ref.borders.map(cloneLine) : [null, null, null, null],
      paras: [emptyPara(ref && ref.paras[0])],
    });
    if (ref && ref.fill) c.fill = Object.assign({}, ref.fill);
    return c;
  }
  /** Grid positions no cell covers get an empty cell. */
  function fillHoles(t) {
    const tpl = t.cells[0] || null;
    for (let r = 0; r < t.rows.length; r++) {
      for (let c = 0; c < t.cols.length; c++) {
        if (!cellAt(t, r, c)) t.cells.push(blankCell(tpl, { r0: r, r1: r, c0: c, c1: c }));
      }
    }
  }
  /** Changes the selected table's structure or cells: fn(table, range). */
  function tableEdit(fn) {
    const sh = selTable();
    if (!sh) return;
    commitEdit();
    const page = sel.page;
    const rg = tableRange();
    pushUndo(page);
    fn(sh.table, rg, sh);
    fitTable(sh);
    rerender(page);
    updateButtons();
    syncToolbar();
  }
  function moveSel(dr, dc) {
    if (!cellSel) return;
    for (const o of [cellSel, cellSel.anchor]) { o.r0 += dr; o.r1 += dr; o.c0 += dc; o.c1 += dc; }
  }
  function insertRows(below) {
    tableEdit((t, rg) => {
      const n = rg.r1 - rg.r0 + 1;
      const at = below ? rg.r1 + 1 : rg.r0;
      const ref = below ? rg.r1 : rg.r0;
      const refCells = t.cells.filter((c) => c.r0 <= ref && c.r1 >= ref).sort((a, b) => a.c0 - b.c0);
      t.rows.splice(at, 0, ...new Array(n).fill(t.rows[ref]));
      for (const c of t.cells) {
        if (c.r0 >= at) { c.r0 += n; c.r1 += n; } else if (c.r1 >= at) c.r1 += n;
      }
      for (let r = at; r < at + n; r++) {
        for (const rc of refCells) {
          if (rc.r0 <= r && rc.r1 >= r) continue; // a merged cell now runs through the new row
          t.cells.push(blankCell(rc, { r0: r, r1: r, c0: rc.c0, c1: rc.c1 }));
        }
      }
      fillHoles(t);
      if (!below && cellSel) moveSel(n, 0);
    });
  }
  function insertCols(right) {
    tableEdit((t, rg) => {
      const n = rg.c1 - rg.c0 + 1;
      const at = right ? rg.c1 + 1 : rg.c0;
      const ref = right ? rg.c1 : rg.c0;
      const refCells = t.cells.filter((c) => c.c0 <= ref && c.c1 >= ref).sort((a, b) => a.r0 - b.r0);
      t.cols.splice(at, 0, ...new Array(n).fill(t.cols[ref]));
      for (const c of t.cells) {
        if (c.c0 >= at) { c.c0 += n; c.c1 += n; } else if (c.c1 >= at) c.c1 += n;
      }
      for (let k2 = at; k2 < at + n; k2++) {
        for (const rc of refCells) {
          if (rc.c0 <= k2 && rc.c1 >= k2) continue;
          t.cells.push(blankCell(rc, { r0: rc.r0, r1: rc.r1, c0: k2, c1: k2 }));
        }
      }
      fillHoles(t);
      if (!right && cellSel) moveSel(0, n);
    });
  }
  function deleteRows() {
    const sh = selTable();
    if (!sh || !cellSel || cellSel.shape !== sh) return;
    const rg = cellSel;
    if (rg.r0 === 0 && rg.r1 >= sh.table.rows.length - 1) { cellSel = null; removeSelected(); return; }
    tableEdit((t) => {
      const a = rg.r0, b = rg.r1, n = b - a + 1;
      t.cells = t.cells.filter((c) => !(c.r0 >= a && c.r1 <= b));
      for (const c of t.cells) {
        const r0 = c.r0 < a ? c.r0 : c.r0 > b ? c.r0 - n : a;
        const r1 = c.r1 > b ? c.r1 - n : c.r1 >= a ? a - 1 : c.r1;
        c.r0 = r0;
        c.r1 = r1;
      }
      t.rows.splice(a, n);
      cellSel = null;
    });
  }
  function deleteCols() {
    const sh = selTable();
    if (!sh || !cellSel || cellSel.shape !== sh) return;
    const rg = cellSel;
    if (rg.c0 === 0 && rg.c1 >= sh.table.cols.length - 1) { cellSel = null; removeSelected(); return; }
    tableEdit((t) => {
      const a = rg.c0, b = rg.c1, n = b - a + 1;
      t.cells = t.cells.filter((c) => !(c.c0 >= a && c.c1 <= b));
      for (const c of t.cells) {
        const c0 = c.c0 < a ? c.c0 : c.c0 > b ? c.c0 - n : a;
        const c1 = c.c1 > b ? c.c1 - n : c.c1 >= a ? a - 1 : c.c1;
        c.c0 = c0;
        c.c1 = c1;
      }
      t.cols.splice(a, n);
      cellSel = null;
    });
  }
  const hasText = (c) => c.paras.some((p) => p.runs.some((r) => r.object || r.text));
  function mergeCells() {
    if (!cellSel || rangeCells(cellSel).length < 2) return;
    tableEdit((t, rg) => {
      const inside = rangeCells(rg).sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
      const keep = cellAt(t, rg.r0, rg.c0) || inside[0];
      const at = (r, c) => cellAt(t, r, c) || keep;
      const B = [at(rg.r0, rg.c0).borders[0], at(rg.r0, rg.c0).borders[1], at(rg.r0, rg.c1).borders[2], at(rg.r1, rg.c0).borders[3]].map(cloneLine);
      const withText = inside.filter(hasText);
      if (withText.length) keep.paras = withText.flatMap((c) => c.paras);
      keep.borders = B;
      Object.assign(keep, { r0: rg.r0, r1: rg.r1, c0: rg.c0, c1: rg.c1 });
      t.cells = t.cells.filter((c) => c === keep || !inside.includes(c));
    });
  }
  function splitCells() {
    if (!cellSel) return;
    tableEdit((t, rg) => {
      for (const c of rangeCells(rg)) {
        if (c.r0 === c.r1 && c.c0 === c.c1) continue;
        const B = c.borders, vIn = B[0] || B[2], hIn = B[1] || B[3];
        for (let r = c.r0; r <= c.r1; r++) {
          for (let q = c.c0; q <= c.c1; q++) {
            if (r === c.r0 && q === c.c0) continue;
            const n = blankCell(c, { r0: r, r1: r, c0: q, c1: q });
            n.borders = [q === c.c0 ? B[0] : vIn, r === c.r0 ? B[1] : hIn, q === c.c1 ? B[2] : vIn, r === c.r1 ? B[3] : hIn].map(cloneLine);
            t.cells.push(n);
          }
        }
        c.borders = [B[0], B[1], c.c1 === c.c0 ? B[2] : vIn, c.r1 === c.r0 ? B[3] : hIn].map(cloneLine);
        c.r1 = c.r0;
        c.c1 = c.c0;
      }
    });
  }
  function setCellFill(color) {
    tableEdit((t, rg) => {
      for (const c of rangeCells(rg)) {
        if (color) c.fill = { color, opacity: 1 }; else delete c.fill;
      }
    });
  }
  function setCellVAlign(v) {
    tableEdit((t, rg) => { for (const c of rangeCells(rg)) c.valign = v; });
  }
  /** Cells outside the range whose sides lie on the range's outline: [cell, side] pairs. */
  function facing(t, rg, inside) {
    const out = [];
    for (const c of t.cells) {
      if (inside.includes(c)) continue;
      const rows = c.r1 >= rg.r0 && c.r0 <= rg.r1, cols = c.c1 >= rg.c0 && c.c0 <= rg.c1;
      if (rows && c.c1 === rg.c0 - 1) out.push([c, 2]);
      if (rows && c.c0 === rg.c1 + 1) out.push([c, 0]);
      if (cols && c.r1 === rg.r0 - 1) out.push([c, 3]);
      if (cols && c.r0 === rg.r1 + 1) out.push([c, 1]);
    }
    return out;
  }
  /** Borders of the selected cells: 'all', 'outside', 'inside' or 'none', drawn with the pen. */
  function setBorders(mode) {
    tableEdit((t, rg) => {
      const line = () => ({ color: pen.color, width: pen.width });
      const inside = rangeCells(rg);
      for (const c of inside) {
        for (let s = 0; s < 4; s++) {
          const outer = s === 0 ? c.c0 === rg.c0 : s === 1 ? c.r0 === rg.r0 : s === 2 ? c.c1 === rg.c1 : c.r1 === rg.r1;
          if (mode === 'all' || (mode === 'outside' && outer) || (mode === 'inside' && !outer)) c.borders[s] = line();
          else if (mode === 'none') c.borders[s] = null;
        }
      }
      // a shared edge is drawn by whichever cell comes first, so the neighbours must agree
      if (mode !== 'inside') for (const [c, s] of facing(t, rg, inside)) c.borders[s] = mode === 'none' ? null : line();
    });
  }
  /** Sets the border pen; the selected cells' existing borders take it too. */
  function setPen(change) {
    Object.assign(pen, change);
    if (!selTable()) return;
    tableEdit((t, rg) => {
      const inside = rangeCells(rg);
      for (const c of inside) for (const b of c.borders) if (b) Object.assign(b, change);
      for (const [c, s] of facing(t, rg, inside)) if (c.borders[s]) Object.assign(c.borders[s], change);
    });
  }
  function clearCells() {
    tableEdit((t, rg) => { for (const c of rangeCells(rg)) c.paras = [emptyPara(c.paras[0])]; });
  }
  function addTable(rows, cols) {
    if (!doc) return;
    rows = Math.max(1, Math.min(60, Math.round(rows) || 3));
    cols = Math.max(1, Math.min(30, Math.round(cols) || 3));
    const w = Math.min(doc.width * 0.7, cols * 3 * CM), cw = w / cols, rh = 0.8 * CM;
    const line = () => ({ color: '#000000', width: 1 });
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ r0: r, r1: r, c0: c, c1: c, margins: [5.4, 2.88, 5.4, 2.88], valign: 'top', borders: [line(), line(), line(), line()], paras: [Object.assign({}, DEFAULT_PARA, { runs: [Object.assign({ text: '' }, DEFAULT_RUN, { size: 12 })] })] });
      }
    }
    const p = visibleSpot(w, rows * rh);
    addShape({ kind: 'table', shape_type: 201, x: p.x, y: p.y, w, h: rows * rh, table: { cols: new Array(cols).fill(cw), rows: new Array(rows).fill(rh), cells } }, false);
    showTab('table');
  }

  // ---- pictures ----------------------------------------------------------------------------

  function replacePicture() {
    const sh = selPicture();
    if (!sh) return;
    replaceTarget = { page: sel.page, shape: sh };
    if (!quiet) send({ cmd: 'addPicture' });
  }
  /** Puts picture `index` (w × h px) into the frame of the picture being replaced, keeping its centre. */
  function finishReplace(t, index, w, h) {
    commitEdit();
    pushUndo(t.page);
    const sh = t.shape;
    const ar = w > 0 && h > 0 ? h / w : sh.h / Math.max(1, sh.w);
    let nw = sh.w, nh = sh.w * ar;
    if (nh > sh.h) { nh = sh.h; nw = sh.h / ar; }
    const cx = sh.x + sh.w / 2, cy = sh.y + sh.h / 2;
    Object.assign(sh, { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh, image: index });
    delete sh.crop;
    if (sel && sel.page === t.page) sel = { page: t.page, shape: sh, shapes: [sh] };
    cropMode = false;
    rerender(t.page);
    updateButtons();
    syncToolbar();
  }
  function setCropMode(on) {
    if (on && !selPicture()) return;
    commitEdit();
    cropMode = !!on;
    if (cropMode) showTab('picture');
    showSel();
    syncToolbar();
  }
  /** Moves the frame edges of the selected picture so `crop` (image sides) is cut off; the picture stays put. */
  function cropTo(c) {
    const sh = selPicture();
    if (!sh) return;
    c = c.map((v) => Math.max(0, Math.min(0.95, v || 0)));
    for (const [a, b] of [[0, 2], [1, 3]]) if (c[a] + c[b] > 0.95) c[b] = 0.95 - c[a];
    commitEdit();
    pushUndo(sel.page);
    const o = { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
    const v0 = visCrop(sh), v1 = visCrop(sh, c);
    const iw = o.w / Math.max(0.01, 1 - v0[0] - v0[2]), ih = o.h / Math.max(0.01, 1 - v0[1] - v0[3]);
    const d = [(v1[0] - v0[0]) * iw, (v1[1] - v0[1]) * ih, -(v1[2] - v0[2]) * iw, -(v1[3] - v0[3]) * ih];
    Object.assign(sh, reframe(o, d, sh.rotation || 0));
    setCropArr(sh, c);
    rerender(sel.page);
    syncToolbar();
  }
  function setCropSide(i, frac) {
    const sh = selPicture();
    if (!sh || !(frac >= 0)) return;
    const c = (sh.crop || [0, 0, 0, 0]).slice();
    c[i] = frac;
    cropTo(c);
  }

  // ---- adding things -----------------------------------------------------------------------

  function visibleSpot(w, h) {
    const s = sheets[current];
    let cx = doc.width / 2, cy = doc.height / 3;
    if (s) {
      const r = s.el.getBoundingClientRect(), v = view.getBoundingClientRect();
      const top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.bottom);
      if (bottom > top) cy = ((top + bottom) / 2 - r.top) / k();
    }
    return { x: Math.max(0, Math.min(doc.width - w, cx - w / 2)), y: Math.max(0, Math.min(doc.height - h, cy - h / 2)) };
  }

  function addShape(shape, thenEdit) {
    commitEdit();
    pushUndo(current);
    shape.seq = nextSeq++;
    insertShapes(current, [shape]);
    sel = { page: current, shape, shapes: [shape] };
    textSel = null;
    cellSel = null;
    cropMode = false;
    rerender(current);
    updateButtons();
    syncToolbar();
    if (thenEdit) {
      const el = shapeEl(current, shape);
      const flow = el && el.querySelector('.op-flow');
      if (flow) startEdit(current, shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 0, o: 0 } });
    }
  }

  function addText() {
    const p = visibleSpot(220, 60);
    addShape({ kind: 'text', shape_type: 202, x: p.x, y: p.y, w: 220, h: 60, text: newTextBody() }, true);
  }
  function addBasic(type) {
    const line = type === 20;
    const w = line ? 150 : 140, h = line ? 0 : 90;
    const p = visibleSpot(w, h);
    const s = { kind: line ? 'line' : 'shape', shape_type: type, x: p.x, y: p.y, w, h, line: { color: '#000000', width: line ? 1 : 0.75 } };
    if (!line) s.fill = { color: '#ffffff', opacity: 1 };
    addShape(s, false);
  }
  function insertPicture() {
    replaceTarget = null;
    if (!quiet) send({ cmd: 'addPicture' });
  }

  // ---- clipboard ---------------------------------------------------------------------------

  function plainText(list) {
    const out = [];
    for (const s of list) for (const o of owners(s)) for (const p of o.paras) out.push(p.runs.map((r) => (r.object ? '' : r.text)).join(''));
    return out.join('\n').trim();
  }
  /** Copies the selected shapes (and cuts them with `cut`). */
  function copySel(cut) {
    if (!sel) return false;
    commitEdit();
    const list = selOrdered();
    clip = { shapes: clone(list), page: sel.page, text: plainText(list), n: 0, cut: !!cut, time: Date.now() };
    unlinkCopies(list, clip.shapes, sel.page);
    if (cut) removeSelected();
    return true;
  }
  /** Pastes the copied shapes onto the current page; they get new ids. */
  function pasteClip() {
    if (!clip || !doc) return;
    commitEdit();
    const page = current;
    pushUndo(page);
    clip.n++;
    const off = page === clip.page ? 12 * (clip.n - (clip.cut ? 1 : 0)) : 0;
    const copies = clip.shapes.map((s) => {
      const c = clone(s);
      reseq(c);
      if (off) shift(c, off, off);
      return c;
    });
    restory(copies);
    insertShapes(page, copies);
    sel = { page, shape: copies[copies.length - 1], shapes: copies };
    textSel = null;
    cellSel = null;
    cropMode = false;
    rerender(page);
    updateButtons();
    syncToolbar();
  }
  /** Text from another program becomes a new text box. */
  function pasteText(text) {
    text = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!text.trim() || !doc) return;
    const lines = text.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    const w = Math.max(72, Math.min(doc.width * 0.6, longest * 6.4 + 12));
    const perLine = Math.max(1, Math.floor((w - 12) / 6.4));
    const n = lines.reduce((a, l) => a + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const h = Math.min(doc.height * 0.8, n * 15 + 10);
    const p = visibleSpot(w, h);
    addShape({ kind: 'text', shape_type: 202, x: p.x, y: p.y, w, h, text: newTextBody(text) }, false);
  }
  /** Ctrl+V outside text: shapes copied in OpenPub since the clipboard last changed elsewhere, else text. */
  function handlePaste(text) {
    if (editing || !doc) return;
    if (clip && clip.time > extClipTime) pasteClip();
    else if (text && text.trim()) pasteText(text);
    else if (clip) pasteClip();
  }
  let pasteTimer = 0;
  window.addEventListener('copy', (e) => {
    const t = e.target;
    if (editing || (t && (t.isContentEditable || t.tagName === 'INPUT'))) { extClipTime = Date.now(); return; }
    if (clip && Date.now() - clip.time < 1000) {
      // other programs get the text of the copied shapes
      e.clipboardData.setData('text/plain', clip.text);
      e.preventDefault();
    }
  });
  window.addEventListener('cut', (e) => {
    const t = e.target;
    if (editing || (t && (t.isContentEditable || t.tagName === 'INPUT'))) { extClipTime = Date.now(); return; }
    if (clip && Date.now() - clip.time < 1000) {
      e.clipboardData.setData('text/plain', clip.text);
      e.preventDefault();
    }
  });
  window.addEventListener('paste', (e) => {
    const t = e.target;
    if (editing || (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) return;
    e.preventDefault();
    clearTimeout(pasteTimer);
    pasteTimer = 0;
    const cd = e.clipboardData || window.clipboardData;
    const text = cd.getData('text/plain');
    // a picture (a screenshot, a picture copied from a web page): when there's no text with it
    const pic = !text.trim() && doc && !(clip && clip.time > extClipTime) && [...(cd.files || [])].find((f) => /^image\//.test(f.type));
    if (pic) { pastePicture(pic); return; }
    handlePaste(text);
  });
  window.addEventListener('blur', () => { extClipTime = Date.now(); });
  function pasteButton() {
    const fallback = () => handlePaste('');
    // shapes copied here since the clipboard last changed elsewhere: no need to read it
    if (clip && clip.time > extClipTime) { pasteClip(); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(handlePaste, fallback);
      else fallback();
    } catch (_) {
      fallback();
    }
  }
  function copyButton(cut) {
    if (!copySel(cut)) return;
    try { if (navigator.clipboard && clip.text) navigator.clipboard.writeText(clip.text).catch(() => {}); } catch (_) { /* not allowed */ }
  }

  // ---- pages -------------------------------------------------------------------------------

  function afterPages(to) {
    renumber();
    sel = null;
    textSel = null;
    cellSel = null;
    cropMode = false;
    hideSel();
    buildThumbs();
    build();
    goTo(to);
    updateButtons();
  }
  function addPage() {
    commitEdit();
    pushUndo(null);
    const cur = doc.pages[current];
    const master = cur ? clone(cur.shapes.filter((s) => s.from_master)) : [];
    doc.pages.splice(current + 1, 0, { name: '', number: 0, shapes: master });
    afterPages(current + 1);
  }
  function duplicatePage() {
    if (!doc) return;
    commitEdit();
    pushUndo(null);
    const copy = clone(doc.pages[current]);
    // master items stay the master's; the page's own items are new shapes
    for (const s of copy.shapes) if (!s.from_master) reseq(s);
    const own = (pg) => pg.shapes.filter((s) => !s.from_master);
    unlinkCopies(own(doc.pages[current]), own(copy), current);
    doc.pages.splice(current + 1, 0, copy);
    afterPages(current + 1);
  }
  function deletePage() {
    if (doc.pages.length <= 1) return;
    commitEdit();
    pushUndo(null);
    doc.pages.splice(current, 1);
    afterPages(Math.min(current, doc.pages.length - 1));
  }
  function movePage(from, to) {
    if (!doc || from === to || to < 0 || to >= doc.pages.length || from < 0 || from >= doc.pages.length) return;
    commitEdit();
    pushUndo(null);
    const [p] = doc.pages.splice(from, 1);
    doc.pages.splice(to, 0, p);
    afterPages(to);
  }
  function renumber() {
    doc.pages.forEach((p, i) => {
      p.number = i + 1;
      p.name = 'Page ' + (i + 1);
    });
    renumberLabels();
  }
  function renumberLabels() {
    $('pagecount').textContent = 'of ' + doc.pages.length;
  }

  // ---- document ----------------------------------------------------------------------------

  let noteTimer = 0;
  function showNotes(list, ms) {
    const n = $('notes');
    clearTimeout(noteTimer);
    if (!list || !list.length) { n.hidden = true; return; }
    n.textContent = list.join(' ');
    n.hidden = false;
    noteTimer = setTimeout(() => { n.hidden = true; }, ms || 12000);
  }

  // ---- the File screen ----------------------------------------------------------------------

  const fileOpen = () => !$('file').hidden;
  let fileReturn = null;

  function showFile(pane) {
    commitEdit();
    closeMenus();
    if (!fileOpen()) fileReturn = document.activeElement;
    for (const b of document.querySelectorAll('#filenav .needs-doc')) b.disabled = !doc;
    if (!doc && !['new', 'open', 'options', 'help'].includes(pane)) pane = 'open';
    $('fileback').hidden = !doc;
    for (const sec of document.querySelectorAll('#filebody > section')) sec.hidden = sec.id !== 'fp-' + pane;
    let cur = null;
    for (const b of document.querySelectorAll('#filenav [data-pane]')) {
      const on = b.dataset.pane === pane;
      b.setAttribute('aria-pressed', String(on));
      if (on) cur = b;
    }
    if (pane === 'open') fillRecent();
    if (pane === 'new') fillNew();
    if ((pane === 'open' || pane === 'new') && !doc) askAssoc(); else $('assocask').hidden = true;
    if (pane === 'info') fillInfo();
    if (pane === 'print') bookletInfo();
    $('file').hidden = false;
    $('filebody').scrollTop = 0;
    if (cur) cur.focus();
  }

  function hideFile() {
    if (!doc || !fileOpen()) return; // with nothing open it is the start screen
    $('file').hidden = true;
    if (fileReturn && fileReturn.isConnected && fileReturn !== document.body) fileReturn.focus(); else view.focus();
    fileReturn = null;
  }

  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  async function fillRecent() {
    const box = $('recent');
    let list = [];
    try { list = await (await fetch('recent.json?v=' + Date.now())).json(); } catch (e) { list = []; }
    box.textContent = '';
    if (!list.length) {
      box.appendChild(mk('div', 'none', 'Files you open will be listed here.'));
      return;
    }
    for (const f of list) {
      const row = mk('div', 'recent' + (f.exists ? '' : ' gone'));
      row.setAttribute('role', 'listitem');
      const open = mk('button', 'openit');
      open.title = f.path;
      open.appendChild(mk('b', '', f.name));
      open.appendChild(mk('span', '', f.exists ? f.folder : f.folder + '  (not found)'));
      open.addEventListener('click', () => send({ cmd: 'openRecent', path: f.path }));
      const forget = mk('button', 'forget', '×');
      forget.title = 'Remove from this list';
      forget.setAttribute('aria-label', 'Remove ' + f.name + ' from this list');
      forget.addEventListener('click', () => { send({ cmd: 'forgetRecent', path: f.path }); row.remove(); if (!box.children.length) fillRecent(); });
      row.appendChild(open);
      row.appendChild(forget);
      box.appendChild(row);
    }
  }

  const MM = 72 / 25.4;
  const NEW_SIZES = [
    ['A4', 'portrait · 21 × 29.7 cm', 210 * MM, 297 * MM],
    ['A4', 'landscape · 29.7 × 21 cm', 297 * MM, 210 * MM],
    ['A5', 'portrait · 14.8 × 21 cm', 148 * MM, 210 * MM],
    ['A5', 'landscape · 21 × 14.8 cm', 210 * MM, 148 * MM],
    ['A3', 'portrait · 29.7 × 42 cm', 297 * MM, 420 * MM],
    ['A3', 'landscape · 42 × 29.7 cm', 420 * MM, 297 * MM],
    ['Letter', 'portrait · 8.5 × 11 in', 612, 792],
    ['A2 poster', 'portrait · 42 × 59.4 cm', 420 * MM, 594 * MM],
    ['A6 postcard', 'landscape · 14.8 × 10.5 cm', 148 * MM, 105 * MM],
    ['DL leaflet', 'portrait · 9.9 × 21 cm', 99 * MM, 210 * MM],
    ['Business card', 'landscape · 8.5 × 5.5 cm', 85 * MM, 55 * MM],
  ];
  function fillNew() {
    const box = $('newcards');
    fillTemplates();
    if (box.children.length) return;
    for (const [name, what, w, h] of NEW_SIZES) {
      const card = mk('button', 'card');
      const sheet = mk('div', 'sheetbox');
      const mini = mk('div', 'mini');
      const k = 118 / Math.max(420 * MM, w, h); // A3's long side fills the box (larger sizes are scaled down)
      mini.style.width = Math.round(w * k) + 'px';
      mini.style.height = Math.round(h * k) + 'px';
      sheet.appendChild(mini);
      card.appendChild(sheet);
      card.appendChild(mk('b', '', name));
      card.appendChild(mk('span', '', what));
      card.addEventListener('click', () => send({ cmd: 'new', width: w, height: h }));
      box.appendChild(card);
    }
  }

  /** With nothing open: the Open page, or New for someone who hasn't opened anything yet. */
  async function startScreen() {
    let pane = 'open';
    try {
      const list = await (await fetch('recent.json?v=' + Date.now())).json();
      if (Array.isArray(list) && !list.length) pane = 'new';
    } catch (e) { /* the Open page */ }
    if (!doc) showFile(pane);
  }

  /** The first-run question: shown once, on the start screen, when .pub files open elsewhere. */
  async function askAssoc() {
    try {
      const st = await (await fetch('start.json?v=' + Date.now())).json();
      $('assocask').hidden = !st.askAssoc;
    } catch (e) { $('assocask').hidden = true; }
  }

  // ---- ready-made designs ---------------------------------------------------------------------

  const A4W = 210 * MM, A4H = 297 * MM;
  /** Builders of the designs: each returns the pages (lists of shapes) for the given page size. */
  const TEMPLATES = {
    flyer: { name: 'Event flyer', what: 'A4 portrait', w: A4W, h: A4H, colors: ['#0f6e5f', '#f4a261', '#fff8ec'] },
    newsletter: { name: 'Newsletter', what: 'A4 portrait · 2 pages', w: A4W, h: A4H, colors: ['#1f4e79', '#e6eef5', '#ffffff'] },
    certificate: { name: 'Certificate', what: 'A4 landscape', w: A4H, h: A4W, colors: ['#8a6d1d', '#fbf6e6', '#ffffff'] },
    poster: { name: 'Notice or poster', what: 'A4 portrait', w: A4W, h: A4H, colors: ['#b3261e', '#ffffff', '#ffffff'] },
    leaflet: { name: 'Folded leaflet', what: 'A4 landscape · 2 pages · folds in three', w: A4H, h: A4W, colors: ['#0f6e5f', '#e3efec', '#ffffff'] },
    card: { name: 'Greeting card', what: 'A4 landscape · 2 pages · folds in half', w: A4H, h: A4W, colors: ['#c2185b', '#fdd835', '#fff3f7'] },
    cover: { name: 'Project cover', what: 'A4 portrait', w: A4W, h: A4H, colors: ['#3949ab', '#e8eaf6', '#ffffff'] },
  };
  function templatePages(id, W, H) {
    let seq = 1000000;
    const run = (text, o) => ({ text, font: o.font || 'Calibri', size: o.size || 12, color: o.color || '#23211d', bold: !!o.bold, italic: !!o.italic });
    const para = (text, o) => Object.assign({}, DEFAULT_PARA, { align: o.align || 'left', after: o.after == null ? 6 : o.after, spacing: o.spacing || 1.1 }, o.bullet ? { bullet: { text: '•' }, left: 18, first: -18 } : {}, { runs: [run(text, o)] });
    // lines: [text, style] pairs, or one string with a style for all
    const text = (x, y, w, h, lines, o) => ({ seq: seq++, kind: 'text', shape_type: 202, x, y, w, h, text: { margins: [4, 4, 4, 4], valign: (o && o.valign) || 'top', columns: 1, column_gap: 0, story: 0, paras: (Array.isArray(lines) ? lines : [[lines, o || {}]]).map(([t, st]) => para(t, Object.assign({}, o, st))) } });
    const rect = (x, y, w, h, fill, line, type) => Object.assign({ seq: seq++, kind: 'shape', shape_type: type || 1, x, y, w, h, wrap: 'none' }, fill ? { fill: typeof fill === 'string' ? { color: fill, opacity: 1 } : fill } : {}, line ? { line } : {});
    const rule = (x, y, w, color, width) => ({ seq: seq++, kind: 'line', shape_type: 20, x, y, w, h: 0, line: { color, width: width || 1 }, wrap: 'none' });
    const m = 42;
    if (id === 'flyer') {
      const c = TEMPLATES.flyer.colors;
      return [[
        rect(0, 0, W, H, c[2]),
        rect(0, 0, W, H * 0.4, { color: c[0], opacity: 1, color2: '#14937f', angle: 135 }),
        text(m, 60, W - 2 * m, 30, 'COMMUNITY EVENT', { size: 14, color: '#d5ebe6', font: 'Calibri', bold: true }),
        text(m, 92, W - 2 * m - 120, 170, [['Summer', {}], ['Market Day', {}]], { size: 50, color: '#ffffff', font: 'Georgia', bold: true, after: 0, spacing: 1 }),
        Object.assign(rect(W - m - 150, H * 0.4 - 80, 150, 150, c[1], null, 3), { text: { margins: [6, 6, 6, 6], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('SAT', { size: 20, bold: true, color: '#ffffff', align: 'center', after: 0 }), para('14 JUNE', { size: 24, bold: true, color: '#ffffff', align: 'center', after: 0 })] } }),
        text(m, H * 0.4 + 90, W - 2 * m, 90, [['Fresh food, local makers and live music.', {}], ['Bring the whole family for a day outdoors.', {}]], { size: 16 }),
        text(m, H * 0.4 + 190, W / 2 - m, 150, [['Farm stalls', { bullet: true }], ['Craft tables', { bullet: true }], ['Food trucks', { bullet: true }], ["Children's corner", { bullet: true }]], { size: 14, after: 4 }),
        Object.assign(rect(W / 2 + 10, H * 0.4 + 190, W / 2 - m - 10, 110, '#ffffff', { color: c[0], width: 1.5 }, 2), { text: { margins: [8, 8, 8, 8], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('10 am – 4 pm', { size: 16, bold: true, color: c[0], align: 'center', after: 2 }), para('Riverside Park', { size: 16, bold: true, color: c[0], align: 'center', after: 2 }), para('Free entry', { size: 16, bold: true, color: c[0], align: 'center', after: 0 })] } }),
        rect(0, H - 70, W, 70, '#1c2541'),
        text(m, H - 50, W - 2 * m, 30, 'www.example.org  ·  01234 567890', { size: 12, color: '#ffffff', align: 'center' }),
      ]];
    }
    if (id === 'newsletter') {
      const c = TEMPLATES.newsletter.colors;
      const col = (W - 2 * m - 18) / 2;
      const story = (x, y, h, head, body) => [
        text(x, y, col, 30, head, { size: 17, bold: true, color: c[0], font: 'Georgia' }),
        text(x, y + 30, col, h - 30, body.map((t) => [t, {}]), { size: 11, spacing: 1.15 }),
      ];
      const lorem = ['Replace this text with your own news. Keep each story short: two or three paragraphs is plenty.', 'Say what happened, who was involved and what comes next. A quote from someone who was there brings a story to life.'];
      const photo = (x, y, w, h) => Object.assign(rect(x, y, w, h, c[1], { color: '#b7c7d6', width: 0.75 }), { text: { margins: [4, 4, 4, 4], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('Picture', { size: 12, color: '#6d7f90', align: 'center', after: 0 })] } });
      return [[
        rect(0, 0, W, 130, c[0]),
        text(m, 34, W - 2 * m, 56, 'School Newsletter', { size: 40, bold: true, color: '#ffffff', font: 'Georgia' }),
        text(m, 92, W - 2 * m, 24, 'Issue 1  ·  Autumn term', { size: 13, color: '#d7e3ee' }),
        ...story(m, 160, 250, 'Headline of the main story', lorem),
        photo(m + col + 18, 160, col, 170),
        text(m + col + 18, 334, col, 22, 'A caption for the picture', { size: 10, italic: true, color: '#6d685f' }),
        rule(m, 430, W - 2 * m, c[0], 1.5),
        ...story(m, 450, 300, 'Second story', lorem),
        ...story(m + col + 18, 450, 300, 'Dates for your diary', ['Monday 1st – Event name', 'Friday 12th – Event name', 'Wednesday 24th – Event name', 'Thursday 30th – Event name']),
        text(m, H - 50, W - 2 * m, 24, 'School name  ·  Address  ·  www.example.org', { size: 10, color: '#6d685f', align: 'center' }),
      ], [
        rect(0, 0, W, 50, c[0]),
        text(m, 14, W - 2 * m, 24, 'School Newsletter', { size: 14, bold: true, color: '#ffffff', font: 'Georgia' }),
        ...story(m, 80, 320, 'Another story', lorem.concat(lorem)),
        ...story(m + col + 18, 80, 320, 'From the classrooms', lorem.concat(lorem)),
        photo(m, 430, W - 2 * m, 210),
        text(m, 646, W - 2 * m, 22, 'A caption for the picture', { size: 10, italic: true, color: '#6d685f' }),
        Object.assign(rect(m, 690, W - 2 * m, 90, c[1], null, 2), { text: { margins: [10, 8, 10, 8], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('Get in touch', { size: 15, bold: true, color: c[0], after: 3 }), para('office@example.org  ·  01234 567890', { size: 12, after: 0 })] } }),
      ]];
    }
    if (id === 'certificate') {
      const c = TEMPLATES.certificate.colors;
      return [[
        rect(0, 0, W, H, c[1]),
        rect(24, 24, W - 48, H - 48, null, { color: c[0], width: 4 }),
        rect(34, 34, W - 68, H - 68, null, { color: c[0], width: 1 }),
        text(60, 86, W - 120, 70, 'Certificate of Achievement', { size: 44, bold: true, color: c[0], font: 'Georgia', align: 'center' }),
        text(60, 176, W - 120, 30, 'This certificate is awarded to', { size: 16, align: 'center', italic: true }),
        text(60, 216, W - 120, 64, 'Name', { size: 40, bold: true, align: 'center', font: 'Georgia' }),
        rule(W / 2 - 190, 286, 380, c[0], 1),
        text(100, 304, W - 200, 60, 'for outstanding effort and achievement in ...', { size: 16, align: 'center' }),
        rule(110, H - 110, 200, '#23211d', 0.75),
        text(110, H - 104, 200, 24, 'Date', { size: 12, align: 'center', color: '#6d685f' }),
        rule(W - 310, H - 110, 200, '#23211d', 0.75),
        text(W - 310, H - 104, 200, 24, 'Signed', { size: 12, align: 'center', color: '#6d685f' }),
        Object.assign(rect(W / 2 - 38, H - 150, 76, 76, c[0], null, 59), {}),
      ]];
    }

    if (id === 'leaflet') {
      // folded in three: page 1 the outside (inside flap | back | front cover), page 2 the inside
      const c = TEMPLATES.leaflet.colors;
      const P = W / 3, g = 22;
      const box = (x, y, w, h, fill, lines) => Object.assign(rect(x, y, w, h, fill, null, 2), { text: { margins: [10, 8, 10, 8], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: lines } });
      const pic = (x, y, w, h) => box(x, y, w, h, c[1], [para('Picture', { size: 12, color: '#6d7f90', align: 'center', after: 0 })]);
      const panel = (i, head, body) => [
        text(i * P + g, 40, P - 2 * g, 34, head, { size: 18, bold: true, color: c[0], font: 'Georgia' }),
        text(i * P + g, 80, P - 2 * g, H - 130, body.map((t) => [t, typeof t === 'string' && t.startsWith('•') ? {} : {}]), { size: 11, spacing: 1.15 }),
      ];
      return [[
        ...panel(0, 'About us', ['Say who you are and what this leaflet is about.', 'This panel is the flap that folds in: people see it when they open the front.']),
        text(P + g, H - 210, P - 2 * g, 30, 'Contact us', { size: 16, bold: true, color: c[0], align: 'center' }),
        text(P + g, H - 176, P - 2 * g, 110, [['Address line 1', {}], ['Address line 2', {}], ['01234 567890', {}], ['www.example.org', {}]], { size: 11, align: 'center', after: 2 }),
        rect(2 * P, 0, P, H, c[0]),
        text(2 * P + g, 60, P - 2 * g, 120, [['Leaflet', {}], ['title', {}]], { size: 34, bold: true, color: '#ffffff', font: 'Georgia', after: 0, spacing: 1 }),
        text(2 * P + g, 190, P - 2 * g, 40, 'A line about what is inside', { size: 13, color: '#e6f0ef', italic: true }),
        pic(2 * P + g, 250, P - 2 * g, 170),
      ], [
        ...panel(0, 'First heading', ['Write the first part of your information here.', 'Use short paragraphs and clear headings so it is easy to read.']),
        pic(g, H - 200, P - 2 * g, 150),
        ...panel(1, 'Second heading', ['• A key point', '• Another key point', '• One more', 'Add a sentence or two to explain them.']),
        ...panel(2, 'Third heading', ['Finish with what you want readers to do next, and how to find out more.']),
        box(2 * P + g, H - 150, P - 2 * g, 100, c[1], [para('Remember!', { size: 15, bold: true, color: c[0], align: 'center', after: 2 }), para('Something important', { size: 12, align: 'center', after: 0 })]),
      ]];
    }
    if (id === 'card') {
      // folded in half: page 1 the outside (back | front), page 2 the inside (left | right)
      const c = TEMPLATES.card.colors;
      const half = W / 2;
      return [[
        text(40, H - 80, half - 80, 24, 'Made by ...', { size: 11, color: '#6d685f', align: 'center', italic: true }),
        rect(half, 0, half, H, c[2]),
        rect(half + 18, 18, half - 36, H - 36, null, { color: c[0], width: 3 }, 2),
        Object.assign(rect(half + half / 2 - 60, 60, 120, 120, c[1], null, 12), {}),
        text(half + 30, 200, half - 60, 150, [['Happy', {}], ['Birthday!', {}]], { size: 44, bold: true, color: c[0], font: 'Georgia', align: 'center', after: 0, spacing: 1 }),
        text(half + 30, H - 110, half - 60, 40, 'to someone special', { size: 16, italic: true, align: 'center', color: '#6d685f' }),
      ], [
        Object.assign(rect(half / 2 - 50, H / 2 - 50, 100, 100, '#f8bbd0', null, 74), {}),
        text(half + 40, 70, half - 80, H - 140, [['Dear ...,', { after: 18 }], ['Write your message here.', { after: 18 }], ['Best wishes,', { after: 4 }], ['...', {}]], { size: 20, font: 'Georgia', color: '#23211d' }),
      ]];
    }
    if (id === 'cover') {
      const c = TEMPLATES.cover.colors;
      const pic = Object.assign(rect(m + 30, 300, W - 2 * m - 30, 230, c[1], { color: '#b7c7d6', width: 0.75 }), { text: { margins: [4, 4, 4, 4], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('Picture', { size: 14, color: '#6d7f90', align: 'center', after: 0 })] } });
      const line = (y, label) => [text(m + 30, y, 110, 26, label, { size: 14, bold: true, color: c[0] }), rule(m + 140, y + 22, W - 2 * m - 140, '#8a867d', 0.75)];
      return [[
        rect(0, 0, 26, H, c[0]),
        text(m + 30, 90, W - 2 * m - 30, 30, 'SUBJECT', { size: 14, bold: true, color: c[0] }),
        text(m + 30, 124, W - 2 * m - 30, 120, 'Project title', { size: 44, bold: true, font: 'Georgia', color: '#23211d', spacing: 1 }),
        text(m + 30, 230, W - 2 * m - 30, 40, 'A short line about the project', { size: 16, italic: true, color: '#6d685f' }),
        pic,
        ...line(580, 'Name'),
        ...line(630, 'Class'),
        ...line(680, 'Teacher'),
        ...line(730, 'Date'),
        text(m + 30, H - 50, W - 2 * m - 30, 24, 'School name', { size: 11, color: '#6d685f' }),
      ]];
    }
    const c = TEMPLATES.poster.colors;
    return [[
      rect(0, 0, W, 210, c[0]),
      text(m, 50, W - 2 * m, 120, 'NOTICE', { size: 96, bold: true, color: '#ffffff', align: 'center', font: 'Arial Black', spacing: 1 }),
      text(m, 250, W - 2 * m, 130, 'The main message goes here', { size: 40, bold: true, align: 'center', font: 'Georgia' }),
      text(m + 20, 400, W - 2 * m - 40, 160, [['Add the details people need: what is happening, where and when.', {}], ['Keep it short so it can be read from a distance.', {}]], { size: 20, align: 'center', spacing: 1.15 }),
      Object.assign(rect(m, 600, W - 2 * m, 120, null, { color: c[0], width: 3 }, 2), { text: { margins: [10, 10, 10, 10], valign: 'middle', columns: 1, column_gap: 0, story: 0, paras: [para('When:  day, date and time', { size: 20, bold: true, align: 'center', after: 4 }), para('Where:  place', { size: 20, bold: true, align: 'center', after: 0 })] } }),
      text(m, H - 80, W - 2 * m, 30, 'Questions? Contact name  ·  01234 567890', { size: 13, align: 'center', color: '#6d685f' }),
    ]];
  }
  function applyTemplate(id) {
    if (!TEMPLATES[id]) return;
    const pages = templatePages(id, doc.width, doc.height);
    doc.pages = pages.map((shapes, i) => ({ name: 'Page ' + (i + 1), number: i + 1, shapes }));
  }
  function fillTemplates() {
    const box = $('tplcards');
    if (box.children.length) return;
    for (const id of Object.keys(TEMPLATES)) {
      const t = TEMPLATES[id];
      const card = mk('button', 'card');
      const sheet = mk('div', 'sheetbox');
      const mini = mk('div', 'mini tpl');
      const k = 118 / (420 * MM);
      mini.style.width = Math.round(t.w * k) + 'px';
      mini.style.height = Math.round(t.h * k) + 'px';
      mini.style.background = t.colors[2];
      // a sketch of the design: a coloured band and a few lines
      const band = mk('i'); band.style.cssText = `left:0;top:0;width:100%;height:${id === 'certificate' ? 100 : 34}%;background:${id === 'certificate' ? t.colors[1] : t.colors[0]}`;
      mini.appendChild(band);
      for (let n = 0; n < 4; n++) { const ln = mk('i'); ln.style.cssText = `left:14%;top:${46 + n * 11}%;width:${72 - n * 9}%;height:3%;background:${id === 'certificate' ? t.colors[0] : '#c9c5bc'}`; mini.appendChild(ln); }
      const folds = id === 'leaflet' ? [33.3, 66.6] : id === 'card' ? [50] : [];
      for (const f of folds) { const ln = mk('i'); ln.style.cssText = `left:${f}%;top:0;width:0;height:100%;border-left:1px dashed rgba(0,0,0,.35)`; mini.appendChild(ln); }
      sheet.appendChild(mini);
      card.appendChild(sheet);
      card.appendChild(mk('b', '', t.name));
      card.appendChild(mk('span', '', t.what));
      card.addEventListener('click', () => send({ cmd: 'new', width: t.w, height: t.h, template: id }));
      box.appendChild(card);
    }
  }

  // ---- save a page as a picture ---------------------------------------------------------------

  /** Draws a page into a PNG (base64), at `dpi` dots per inch. */
  async function pagePng(index, dpi) {
    const scale = dpi / 96;
    const wrap = OpenPub.renderPage(doc, index, { scale, imageUrl });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;';
    document.body.appendChild(host);
    try {
      host.appendChild(wrap);
      wrap.opFinish();
      // the picture is drawn from a self-contained copy: pictures go in as data
      for (const img of wrap.querySelectorAll('img')) {
        const blob = await (await fetch(img.src)).blob();
        img.src = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      }
      // (a picture page background too)
      for (const bg of wrap.querySelectorAll('.op-pagebg')) {
        const m = /url\("([^"]+)"\)/.exec(bg.style.backgroundImage || '');
        if (!m || m[1].startsWith('data:')) continue;
        const blob = await (await fetch(m[1])).blob();
        const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
        bg.style.backgroundImage = `url("${data}")`;
      }
      const w = Math.round(doc.width * PX * scale), h = Math.round(doc.height * PX * scale);
      const css = (document.getElementById('op-css') || {}).textContent || '';
      const xml = new XMLSerializer().serializeToString(wrap);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css.replace(/</g, '&lt;')}</style>${xml}</div></foreignObject></svg>`;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#ffffff';
      c2.fillRect(0, 0, w, h);
      c2.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    } finally {
      host.remove();
    }
  }
  async function exportPng() {
    if (!doc || busy) return;
    commitEdit();
    try {
      const data = await pagePng(current, 150);
      const base = String(doc.name || 'Publication').replace(/\.[a-z]+$/i, '');
      send({ cmd: 'savePng', data, name: `${base} - page ${current + 1}`, path: exportPng.path });
    } catch (e) {
      showNotes(['The picture could not be made: ' + e]);
    }
  }

  /** Whether the browser has a font of this name (text set in it measures differently from the
   * fallbacks). */
  let fontProbe = null;
  function fontInstalled(name) {
    if (!fontProbe) fontProbe = document.createElement('canvas').getContext('2d');
    const sample = 'mmmmmmmmmmlliWQ@ 0123456789';
    return ['monospace', 'serif', 'sans-serif'].some((base) => {
      fontProbe.font = `72px ${base}`;
      const a = fontProbe.measureText(sample).width;
      fontProbe.font = `72px "${name.replace(/"/g, '')}", ${base}`;
      return Math.abs(fontProbe.measureText(sample).width - a) > 0.01;
    });
  }

  function fillInfo() {
    if (!doc) return;
    const grid = $('infogrid');
    grid.textContent = '';
    const row = (k, v) => { grid.appendChild(mk('dt', '', k)); grid.appendChild(mk('dd', '', v)); };
    const cm = (v) => (Math.round(v / 72 * 2.54 * 10) / 10).toString();
    row('Name', (doc.name || 'Untitled') + (dirty ? '  (unsaved changes)' : ''));
    row('Location', doc.path || 'Not saved yet');
    const kind = /\.pub$/i.test(doc.path || '') ? 'Microsoft Publisher file. Saving makes an OpenPub (.opub) copy; the .pub file is never changed.' : 'OpenPub document';
    row('Type', kind);
    row('Pages', String(doc.pages.length));
    row('Page size', `${cm(doc.width)} × ${cm(doc.height)} cm`);
    let pics = 0;
    const count = (list) => { for (const sh of list) { if (sh.image != null) pics++; if (sh.children) count(sh.children); } };
    for (const pg of doc.pages) count(pg.shapes);
    row('Pictures', String(pics));
    // fonts
    const names = new Set();
    const walk = (sh) => {
      for (const o of owners(sh)) for (const para of o.paras) for (const r of para.runs) if (r.font && (r.text || '').trim()) names.add(r.font);
      if (sh.wordart && sh.wordart.font) names.add(sh.wordart.font);
      for (const c of sh.children || []) walk(c);
    };
    for (const pg of doc.pages) for (const sh of pg.shapes) walk(sh);
    const fonts = $('infofonts');
    fonts.textContent = '';
    if (!names.size) fonts.appendChild(mk('span', 'ok', 'No text yet.'));
    for (const n of [...names].sort((a, b) => a.localeCompare(b))) {
      const ok = fontInstalled(n);
      fonts.appendChild(mk('span', '', n));
      fonts.appendChild(mk('span', ok ? 'ok' : 'bad', ok ? 'Installed on this computer' : 'Not installed · shown with a similar font'));
    }
    const notes = doc.notes || [];
    $('infonotes').hidden = !notes.length;
    const ul = $('infonotelist');
    ul.textContent = '';
    for (const t of notes) ul.appendChild(mk('li', '', t));
  }

  function fillFonts() {
    loadSystemFonts();
  }

  function maxSeq(d) {
    let m = 0;
    const walk = (s) => {
      if (s.seq > m) m = s.seq;
      (s.children || []).forEach(walk);
    };
    for (const p of d.pages) p.shapes.forEach(walk);
    return m;
  }

  async function load() {
    let data;
    try {
      const r = await fetch('doc.json?v=' + Date.now());
      data = await r.json();
    } catch (e) {
      data = { error: 'Could not read the document: ' + e };
    }
    version++;
    if (data.error) {
      showNotes([data.error]);
      return;
    }
    if (!data.pages) {
      doc = null;
      document.body.classList.remove('has-doc');
      build();
      buildThumbs();
      updateButtons();
      startScreen();
      return;
    }
    doc = data;
    if (typeof data.template === 'string' && !doc.path) applyTemplate(data.template);
    delete doc.template;
    sel = null;
    editing = null;
    textSel = null;
    cellSel = null;
    cropMode = false;
    clip = null;
    undoStack.length = 0;
    redoStack.length = 0;
    dirty = false;
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    lastAutosave = 0;
    cancelTool();
    hideCtx();
    hideSwatches();
    borderImages.clear();
    unsavedSince = 0;
    $('savebar').hidden = true;
    if (masterMode) setMasterMode(false);
    nextSeq = Math.max(1000000, maxSeq(doc) + 1);
    hideSel();
    document.body.classList.add('has-doc');
    $('file').hidden = true;
    fileReturn = null;
    $('docname').textContent = data.name || '';
    $('pagecount').textContent = 'of ' + doc.pages.length;
    current = 0;
    fillFonts();
    buildThumbs(); // first: the page list takes width away from the view
    build();
    view.scrollTop = 0;
    setCurrent(0, true);
    if (data.recovered) {
      delete doc.recovered;
      dirty = false;
      setDirty(true);
      showNotes([`Your unsaved changes to ${data.name} were recovered. Save them to keep them.`].concat(doc.notes || []), 10000);
    } else showNotes(doc.notes);
    updateButtons();
    syncToolbar();
    view.focus();
  }

  function docJson() {
    commitEdit();
    return JSON.stringify(doc);
  }
  let pubSaveNoted = false;
  function save(as) {
    if (!doc) return;
    if (!pubSaveNoted && /\.pub$/i.test(doc.path || '')) {
      pubSaveNoted = true;
      showNotes(['OpenPub saves your work as a new OpenPub (.opub) file. Your Publisher file is left as it was.'], 9000);
    }
    send({ cmd: as ? 'saveAs' : 'save', doc: docJson() });
  }

  // Printing and PDF export draw every page at its real size, one per sheet of paper.
  let printRestore = null;
  function preparePrint() {
    commitEdit();
    select(0, null);
    busy = true;
    document.body.classList.remove('master-mode');
    const style = document.createElement('style');
    style.textContent = `@page { size: ${doc.width}pt ${doc.height}pt; margin: 0; }`;
    document.head.appendChild(style);
    const prevMode = zoomMode, prevSpread = $('spread').checked, page = current;
    $('spread').checked = false;
    zoomMode = '1';
    build();
    for (const s of sheets) if (s) renderSheet(s);
    addPrintLinks(pagesEl);
    printRestore = () => {
      printRestore = null;
      busy = false;
      pdfMax = null;
      style.remove();
      document.body.classList.toggle('master-mode', masterMode);
      $('spread').checked = prevSpread;
      zoomMode = prevMode;
      build();
      goTo(page);
      $('zoom').value = zoomMode;
      updateButtons();
    };
    const imgs = [...pagesEl.querySelectorAll('img')];
    return Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
  }
  /** Links on objects become real links while printing, so a PDF keeps them clickable. */
  function addPrintLinks(root) {
    for (const el of root.querySelectorAll('.op-shape')) {
      const url = el.opShape && el.opShape.link;
      if (!url || !/^(https?:\/\/|mailto:)\S+$/i.test(url)) continue;
      const a = document.createElement('a');
      a.href = url;
      a.className = 'op-printlink';
      a.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:5';
      a.addEventListener('click', (e) => e.preventDefault());
      el.appendChild(a);
    }
  }
  function printAll() {
    if (!doc || busy) return;
    preparePrint().then(() => {
      window.addEventListener('afterprint', () => printRestore && printRestore(), { once: true });
      window.print();
    });
  }
  function exportPdf() {
    if (!doc || busy) return;
    // a PDF to send or hand in: pictures at 220 dpi for the size they are shown at, not the
    // camera's full size (a booklet of photos was 40 MB)
    pdfMax = picturePixels(PDF_DPI);
    preparePrint().then(() => send({ cmd: 'pdf', width: doc.width, height: doc.height, path: exportPdf.path }));
  }
  const PDF_DPI = 220;
  /** The most pixels each picture needs on its longer side at `dpi`, for the largest size it is
   * shown at in the publication (a cropped picture: the size of the whole picture). */
  function picturePixels(dpi) {
    const need = new Map();
    const add = (i, wPt, hPt) => {
      if (!Number.isInteger(i) || !(wPt > 0 && hPt > 0)) return;
      const px = Math.ceil(Math.max(wPt, hPt) / 72 * dpi);
      need.set(i, Math.max(need.get(i) || 0, px));
    };
    const inText = (paras) => { for (const p of paras || []) for (const r of p.runs || []) if (r.object) walk([r.object]); };
    const walk = (shapes) => {
      for (const s of shapes || []) {
        if (s.image != null) {
          const c = s.crop || [0, 0, 0, 0];
          add(s.image, s.w / Math.max(0.01, 1 - c[0] - c[2]), s.h / Math.max(0.01, 1 - c[1] - c[3]));
        }
        if (s.fill && s.fill.image != null) add(s.fill.image, s.w, s.h);
        walk(s.children);
        if (s.text) inText(s.text.paras);
        if (s.table) for (const c of s.table.cells) { if (c.fill && c.fill.image != null) add(c.fill.image, s.w, s.h); inText(c.paras); }
      }
    };
    for (const p of doc.pages) {
      walk(p.shapes);
      if (p.background_fill && p.background_fill.image != null) add(p.background_fill.image, doc.width, doc.height);
    }
    return need;
  }


  // ---- booklets ---------------------------------------------------------------------------------
  // Pages two to a side of a sheet, in the order for folding the printed stack in half: sheet i has
  // pages n-1-2i and 2i on its front and 2i+1 and n-2-2i on its back (n: the pages, made up to a
  // multiple of 4 with blanks). Pages bigger than A5 are printed smaller, on A4 paper.
  const A4_LAND = [841.89, 595.28];
  function bookletPlan() {
    const n = Math.ceil(doc.pages.length / 4) * 4;
    const sides = [];
    for (let i = 0; i < n / 4; i++) {
      sides.push([n - 1 - 2 * i, 2 * i]);
      sides.push([2 * i + 1, n - 2 - 2 * i]);
    }
    let pw = 2 * doc.width, ph = doc.height, k = 1;
    if (pw > A4_LAND[0] + 2 || ph > A4_LAND[1] + 2) {
      k = Math.min(A4_LAND[0] / pw, A4_LAND[1] / ph);
      pw = A4_LAND[0];
      ph = A4_LAND[1];
    }
    return { n, sides, paper: [pw, ph], k };
  }
  function bookletInfo() {
    if (!doc) return;
    const b = bookletPlan();
    const blanks = b.n - doc.pages.length;
    const paper = b.k < 1 ? 'A4 paper (landscape), with each page printed smaller' : `paper ${fmtCm(b.paper[0])} × ${fmtCm(b.paper[1])} cm`;
    $('bookinfo').textContent = `${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''} on ${b.n / 4} sheet${b.n > 4 ? 's' : ''} of ${paper}${blanks ? `; ${blanks} blank page${blanks > 1 ? 's' : ''} added at the end` : ''}.`;
  }
  /** Lays the booklet out for printing (off screen until printed); `printRestore` takes it away. */
  function prepareBooklet() {
    commitEdit();
    select(0, null);
    busy = true;
    const b = bookletPlan();
    const style = document.createElement('style');
    style.textContent = `@page { size: ${b.paper[0]}pt ${b.paper[1]}pt; margin: 0; }`;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'printbook-out';
    document.body.appendChild(box);
    const finish = [];
    for (const pair of b.sides) {
      const side = document.createElement('div');
      side.className = 'bside';
      side.style.width = b.paper[0] + 'pt';
      side.style.height = b.paper[1] + 'pt';
      side.dataset.pages = pair.map((i) => i + 1).join(',');
      for (const i of pair) {
        const slot = document.createElement('div');
        slot.className = 'bslot';
        slot.style.width = doc.width * b.k + 'pt';
        slot.style.height = doc.height * b.k + 'pt';
        if (i < doc.pages.length) {
          const wrap = OpenPub.renderPage(doc, i, { scale: b.k, imageUrl });
          slot.appendChild(wrap);
          finish.push(wrap);
        }
        side.appendChild(slot);
      }
      box.appendChild(side);
    }
    for (const w of finish) w.opFinish();
    addPrintLinks(box);
    document.body.classList.add('bookprint');
    printRestore = () => {
      printRestore = null;
      busy = false;
      pdfMax = null;
      style.remove();
      box.remove();
      document.body.classList.remove('bookprint');
      updateButtons();
    };
    const imgs = [...box.querySelectorAll('img')];
    return Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()))).then(() => b);
  }
  function printBooklet() {
    if (!doc || busy) return;
    prepareBooklet().then(() => {
      window.addEventListener('afterprint', () => printRestore && printRestore(), { once: true });
      window.print();
    });
  }
  function exportBookletPdf() {
    if (!doc || busy) return;
    pdfMax = picturePixels(PDF_DPI);
    prepareBooklet().then((b) => send({ cmd: 'pdf', width: b.paper[0], height: b.paper[1], path: exportBookletPdf.path }));
  }

  // ---- events ------------------------------------------------------------------------------

  const on = (id, fn) => $(id).addEventListener('click', fn);
  const num = (id) => parseFloat(String($(id).value).replace(',', '.'));
  const onChange = (id, fn) => $(id).addEventListener('change', (e) => fn(e.target.value, e));
  on('open', () => send({ cmd: 'open' }));
  on('save', () => save(false));
  on('fsave', () => { hideFile(); save(false); });
  on('saveas', () => { hideFile(); save(true); });
  on('pdf', () => { hideFile(); exportPdf(); });
  on('png', () => { hideFile(); exportPng(); });
  on('assocyes', () => { $('assocask').hidden = true; send({ cmd: 'assocAnswer', yes: true }); });
  on('assocno', () => { $('assocask').hidden = true; send({ cmd: 'assocAnswer', yes: false }); });
  on('docx', () => { if (!doc) return; hideFile(); send({ cmd: 'docx', doc: docJson() }); });
  on('print', () => { hideFile(); printAll(); });
  on('printbook', () => { hideFile(); printBooklet(); });
  on('pdfbook', () => { hideFile(); exportBookletPdf(); });
  on('assoc', () => send({ cmd: 'associate' }));
  on('filebtn', () => showFile(doc ? 'info' : 'open'));
  on('fileback', hideFile);
  on('helpbtn', () => showFile('help'));
  for (const b of document.querySelectorAll('#filenav [data-pane]')) b.addEventListener('click', () => showFile(b.dataset.pane));
  on('undo', () => restore(undoStack, redoStack));
  on('redo', () => restore(redoStack, undoStack));
  on('prev', () => doc && goTo(spreadOn() ? spreadStep(current, -1) : current - 1));
  on('next', () => doc && goTo(spreadOn() ? spreadStep(current, 1) : current + 1));
  on('zoomin', () => stepZoom(1));
  on('zoomout', () => stepZoom(-1));
  // Home
  on('paste', pasteButton);
  on('cut', () => copyButton(true));
  on('copy', () => copyButton(false));
  on('bold', () => format({ bold: 'toggle' }));
  on('italic', () => format({ italic: 'toggle' }));
  on('underline', () => format({ underline: 'toggle' }));
  on('strike', () => format({ strike: 'toggle' }));
  on('super', () => toggleScript(1));
  on('sub', () => toggleScript(2));
  on('grow', () => stepSize(1));
  on('shrink', () => stepSize(-1));
  on('findbtn', () => showFind());
  // stage 5: WordArt, gradient, shadow, link, table style, picture adjustments
  on('addwa', addWordArt);
  on('waedit', () => sel && sel.shape && sel.shape.wordart && editWordArt(sel.page, sel.shape));
  on('fitbox', fitBoxToText);
  on('savebarsave', () => { $('savebar').hidden = true; save(false); });
  on('savebarx', () => { $('savebar').hidden = true; remindAfter += 10 * 60000; });
  on('fittext', shrinkTextToFit);
  onChange('wastyle', (v) => setWordArt(null, parseInt(v, 10)));
  onChange('graddir', (v) => setGradient(v === '' ? null : parseFloat(v)));
  onChange('pattern', (v) => setPattern(v));
  onChange('borderart', (v) => setBorderArt(v));
  onChange('bordersize', () => setBorderSize(num('bordersize')));
  $('borderart').addEventListener('focus', fillBorderList);
  onChange('fill2', (v) => setGradient(undefined, v));
  on('shadowbtn', () => setShadow(!$('shadowbtn').classList.contains('on')));
  onChange('shadowcolor', (v) => setShadow(true, v));
  on('linkset', () => { setLink($('linkurl').value); closeMenus(); });
  on('linkdel', () => { setLink(null); closeMenus(); });
  on('linkopen', () => { const u = normalLink($('linkurl').value); if (u) send({ cmd: 'openLink', url: u }); });
  $('linkurl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setLink($('linkurl').value); closeMenus(); } });
  onChange('tblhead', (v) => setTableStyle({ head: v }));
  onChange('tblband', (v) => setTableStyle({ band: v }));
  on('tblplain', () => setTableStyle({ plain: true }));
  onChange('picbri', (v) => setPicture({ brightness: Math.max(-100, Math.min(100, parseFloat(v) || 0)) }));
  onChange('piccon', (v) => setPicture({ contrast: Math.max(-100, Math.min(100, parseFloat(v) || 0)) }));
  on('picgray', () => setPicture({ gray: !$('picgray').classList.contains('on') }));
  onChange('picshape', (v) => setPicture({ shape_type: parseInt(v, 10) }));
  on('picreset', () => setPicture({ brightness: 0, contrast: 0, gray: false, shape_type: 75 }));
  // Shape Format: align and flip
  for (const [id, mode] of [['alnl', 'left'], ['alnc', 'center'], ['alnr', 'right'], ['alnt', 'top'], ['alnm', 'middle'], ['alnb', 'bottom']]) on(id, () => alignSel(mode));
  on('fliph', () => flipSel('h'));
  on('flipv', () => flipSel('v'));
  // Page: setup, background, border
  onChange('pgsize', (v) => { if (v !== 'custom' && doc) { const [a, b] = PAGE_SIZES[v]; const land = doc.width > doc.height; setPageSize(land ? b : a, land ? a : b); } });
  on('pgport', () => doc && doc.width > doc.height && setPageSize(doc.height, doc.width));
  on('pgland', () => doc && doc.height > doc.width && setPageSize(doc.height, doc.width));
  onChange('pgw', () => { const v = num('pgw'); if (doc && v >= 1 && v <= 500) setPageSize(v * CM, doc.height); else syncPageUi(); });
  onChange('pgh', () => { const v = num('pgh'); if (doc && v >= 1 && v <= 500) setPageSize(doc.width, v * CM); else syncPageUi(); });
  $('pgbg').addEventListener('change', (e) => setPageBackground(e.target.value));
  on('pgbgnone', () => setPageBackground(null));
  on('pgbgall', () => setPageBackground(doc && doc.pages[current].background || null, true));
  on('pgborder', addPageBorder);
  buildShapeGallery();
  on('findnext', () => findNext());
  on('findclose', hideFind);
  on('replone', replaceOne);
  on('replall', replaceAll);
  $('findq').addEventListener('input', () => { findLast = null; clearFindMark(); $('findmsg').textContent = ''; });
  $('findbar').addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here is not a command for the page
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); hideFind(); }
    else if (e.key === 'Enter' && e.target.id === 'findr') { e.preventDefault(); replaceOne(); }
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); findNext(); }
    else if (ctrl && (e.key === 'f' || e.key === 'h')) { e.preventDefault(); showFind(e.key === 'h'); }
  });
  on('al', () => format({ align: 'left' }));
  on('ac', () => format({ align: 'center' }));
  on('ar', () => format({ align: 'right' }));
  on('aj', () => format({ align: 'justify' }));
  on('bul', toggleBullets);
  on('num', toggleNumbering);
  on('indl', () => indent(-1));
  on('indr', () => indent(1));
  for (const b of document.querySelectorAll('[data-bullet]')) b.addEventListener('click', () => setBullet(b.dataset.bullet));
  for (const b of document.querySelectorAll('[data-number]')) b.addEventListener('click', () => setNumbering(parseInt(b.dataset.number, 10), parseInt($('numstart').value, 10) || 1));
  for (const b of document.querySelectorAll('[data-spacing]')) b.addEventListener('click', () => setSpacing(parseFloat(b.dataset.spacing), false));
  onChange('numstart', (v) => {
    const st = currentStyle();
    const n = parseInt(v, 10);
    if (n >= 1) setNumbering(st && st.para.bullet && st.para.bullet.number != null ? st.para.bullet.number : lastNumber, n);
  });
  onChange('spexact', (v) => { const x = parseLen(v, 'pt'); if (x > 0) setSpacing(x, true); });
  onChange('spbefore', (v) => setParaSpace('before', parseLen(v, 'pt')));
  onChange('spafter', (v) => setParaSpace('after', parseLen(v, 'pt')));
  on('front', () => reorder(true));
  on('back', () => reorder(false));
  on('group', groupSel);
  on('ungroup', ungroupSel);
  on('dup', duplicate);
  on('del', removeSelected);
  on('selall', selectAll);
  // Insert
  on('inspage', addPage);
  on('tblinsert', () => { closeMenus(); addTable(num('tblrows'), num('tblcols')); });
  // point at the size of the table, then click
  (function tableGrid() {
    const grid = $('tblgrid'), ROWS = 8, COLS = 10;
    const cells = [];
    const mark = (r, c) => {
      for (const b of cells) b.classList.toggle('on', b.opR <= r && b.opC <= c);
      $('tblgridlabel').textContent = r < 0 ? 'Choose the size of the table' : `${r + 1} × ${c + 1} table (rows × columns)`;
    };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const b = document.createElement('button');
      b.opR = r;
      b.opC = c;
      b.setAttribute('aria-label', `${r + 1} rows, ${c + 1} columns`);
      b.addEventListener('mouseenter', () => mark(r, c));
      b.addEventListener('focus', () => mark(r, c));
      b.addEventListener('click', () => { closeMenus(); mark(-1, -1); addTable(r + 1, c + 1); });
      grid.appendChild(b);
      cells.push(b);
    }
    grid.addEventListener('mouseleave', () => mark(-1, -1));
  })();
  on('addpic', insertPicture);
  on('addrect', () => armTool('shape', 1, 'a rectangle'));
  on('addellipse', () => armTool('shape', 3, 'an ellipse'));
  on('addline', () => armTool('line', 20));
  on('addtext', () => armTool('text'));
  on('toolcancel', () => { cancelTool(); view.focus({ preventScroll: true }); });
  onChange('arrows', setArrows);
  // Page
  on('addpage', addPage);
  on('duppage', duplicatePage);
  on('delpage', deletePage);
  on('pageup', () => movePage(current, current - 1));
  on('pagedown', () => movePage(current, current + 1));
  on('mastermode', () => setMasterMode(!masterMode));
  on('mastershut', () => setMasterMode(false));
  // Shape format
  onChange('fill', (v) => setFill(v));
  on('nofill', () => setFill(null));
  onChange('transp', (v) => setTransparency(parseFloat(v)));
  onChange('linecolor', (v) => setLine({ color: v }));
  onChange('linewidth', (v) => setLine({ width: parseFloat(v) }));
  onChange('dash', (v) => setLine({ dash: parseInt(v, 10) }));
  for (const [id, key] of [['gx', 'x'], ['gy', 'y'], ['gw', 'w'], ['gh', 'h']]) onChange(id, (v) => setGeom(key, parseLen(v, 'cm')));
  onChange('grot', (v) => setRotation(parseFloat(String(v).replace(',', '.'))));
  on('rotl', () => rotateBy(-90));
  on('rotr', () => rotateBy(90));
  on('rot0', () => setRotation(0));
  // Text box
  ['ml', 'mt', 'mr', 'mb'].forEach((id, i) => onChange(id, (v) => setMargin(i, parseLen(v, 'cm'))));
  on('vt', () => setVAlign('top'));
  on('vm', () => setVAlign('middle'));
  on('vb', () => setVAlign('bottom'));
  onChange('ncols', (v) => setColumns(parseFloat(v)));
  onChange('colgap', (v) => setColumnGap(parseLen(v, 'cm')));
  // Table
  on('rowabove', () => insertRows(false));
  on('rowbelow', () => insertRows(true));
  on('colleft', () => insertCols(false));
  on('colright', () => insertCols(true));
  on('delrows', deleteRows);
  on('delcols', deleteCols);
  on('merge', mergeCells);
  on('split', splitCells);
  onChange('cellfill', (v) => setCellFill(v));
  on('cellnofill', () => setCellFill(null));
  on('cvt', () => setCellVAlign('top'));
  on('cvm', () => setCellVAlign('middle'));
  on('cvb', () => setCellVAlign('bottom'));
  on('ball', () => setBorders('all'));
  on('bout', () => setBorders('outside'));
  on('bin', () => setBorders('inside'));
  on('bnone', () => setBorders('none'));
  onChange('bcolor', (v) => setPen({ color: v }));
  onChange('bwidth', (v) => setPen({ width: parseFloat(v) }));
  // Picture
  on('replacepic', replacePicture);
  on('crop', () => setCropMode(!cropMode));
  on('resetcrop', () => cropTo([0, 0, 0, 0]));
  ['crl', 'crt', 'crr', 'crb'].forEach((id, i) => onChange(id, (v) => setCropSide(i, parseFloat(String(v).replace(',', '.')) / 100)));

  $('zoom').addEventListener('change', (e) => setZoom(e.target.value));
  // dragging the slider zooms as it goes (not on every pixel: pages are redrawn)
  let sliderTimer = 0;
  const sliderZoom = () => {
    const z = Math.round(sliderToScale(parseFloat($('zoomslider').value)) * 100) / 100;
    if (Math.abs(z - scale) > 0.004) setZoom(z);
  };
  $('zoomslider').addEventListener('input', () => {
    $('zoompct').textContent = Math.round(sliderToScale(parseFloat($('zoomslider').value)) * 100) + '%';
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(sliderZoom, 90);
  });
  $('zoomslider').addEventListener('change', () => { clearTimeout(sliderTimer); sliderZoom(); $('zoomslider').blur(); });
  $('zoompct').addEventListener('dblclick', () => setZoom(1));
  // Two pages side by side are only useful when the whole spread is on screen: "Fit width" turns
  // into "Whole page" while the two-page view is on (and back again after)
  let spreadZoomed = false;
  $('spread').addEventListener('change', () => {
    commitEdit();
    if (spreadOn() && zoomMode === 'fit-width') { zoomMode = 'fit-page'; spreadZoomed = true; }
    else if (!spreadOn() && spreadZoomed && zoomMode === 'fit-page') zoomMode = 'fit-width';
    if (!spreadOn()) spreadZoomed = false;
    relayout(true);
  });

  $('color').addEventListener('change', (e) => format({ color: e.target.value }));
  $('pageno').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1) goTo(v - 1); else setCurrent(current);
  });
  $('pageno').addEventListener('focus', (e) => e.target.select());
  view.addEventListener('scroll', onScroll, { passive: true });
  // Enter in a ribbon field applies it (the field's change event) and goes back to the page
  $('bar').addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key !== 'Enter' || t.tagName !== 'INPUT' || !t.closest('.ribbon')) return;
    if (t.id === 'tblrows' || t.id === 'tblcols') { e.preventDefault(); $('tblinsert').click(); return; }
    if (t.closest('.pop')) t.blur();
    else view.focus({ preventScroll: true });
  });

  // toolbar buttons must not take the focus away from text being edited
  for (const id of ['bar', 'status']) {
    $(id).addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
  }
  // Enter in the page number box goes to the page and back to the publication
  $('pageno').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); view.focus({ preventScroll: true }); } });

  // drop-down menus
  for (const [btn, menu] of [['linkbtn', 'linkpop'], ['shapesbtn', 'shapepop'], ['bulmenu', 'bulpop'], ['nummenu', 'numpop'], ['spbtn', 'sppop'], ['addtable', 'tblpop']]) {
    $(btn).addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(menu).hidden;
      closeMenus();
      $(menu).hidden = !open;
      $(btn).setAttribute('aria-expanded', String(open));
      if (open) syncToolbar();
    });
  }
  function closeMenus() {
    for (const m of document.querySelectorAll('.pop')) m.hidden = true;
    for (const b of document.querySelectorAll('[aria-haspopup]')) b.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', (e) => {
    // fields inside a menu keep it open
    if (e.target.closest && e.target.closest('.pop') && e.target.closest('label, input')) return;
    closeMenus();
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!doc || busy || (zoomMode !== 'fit-width' && zoomMode !== 'fit-page')) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { commitEdit(); relayout(true); }, 120);
  });

  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'F1') { e.preventDefault(); showFile('help'); return; }
    if (e.key === 'Escape' && document.querySelector('.pop:not([hidden])')) { closeMenus(); return; }
    if (ctrl && key === 'o') { e.preventDefault(); send({ cmd: 'open' }); return; }
    if (ctrl && key === 'n') { e.preventDefault(); showFile('new'); return; }
    if (ctrl && (key === 'f' || key === 'h') && doc && !fileOpen()) { e.preventDefault(); showFind(key === 'h'); return; }
    if (ctrl && e.shiftKey && (e.key === '>' || e.key === '<') && doc && !fileOpen()) { e.preventDefault(); stepSize(e.key === '>' ? 1 : -1); return; }
    if (fileOpen()) {
      // the File screen is in front: only its own keys work
      if (e.key === 'Escape' && doc) { e.preventDefault(); hideFile(); }
      if (ctrl && (key === 's' || key === 'p' || key === 'z' || key === 'y')) e.preventDefault();
      return;
    }
    if (ctrl && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (ctrl && key === 'p') { e.preventDefault(); printAll(); return; }
    if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); stepZoom(1); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); stepZoom(-1); return; }
    if (ctrl && e.key === '0') { e.preventDefault(); setZoom('fit-width'); return; }
    if (ctrl && key === 'r') e.preventDefault(); // not "reload"
    const t = e.target;
    if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    // keys typed on a ribbon button (reached with Tab) are for the ribbon, not the page
    if (!ctrl && t.closest && t.closest('#bar')) return;
    if (ctrl && key === 'z') { e.preventDefault(); restore(e.shiftKey ? redoStack : undoStack, e.shiftKey ? undoStack : redoStack); return; }
    if (ctrl && key === 'y') { e.preventDefault(); restore(redoStack, undoStack); return; }
    if (ctrl && key === 'd') { e.preventDefault(); duplicate(); return; }
    if (ctrl && key === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSel(); else groupSel(); return; }
    if (ctrl && key === 'a') { e.preventDefault(); selectAll(); return; }
    if (ctrl && key === 'c') { if (sel) copySel(false); return; } // the copy event that follows fills the system clipboard
    if (ctrl && key === 'x') { if (sel) copySel(true); return; }
    if (ctrl && key === 'v') {
      // the paste event normally follows; without one, paste the copied shapes
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => { pasteTimer = 0; handlePaste(''); }, 150);
      return;
    }
    if (ctrl && 'biu'.includes(key) && key.length === 1) { e.preventDefault(); format({ [{ b: 'bold', i: 'italic', u: 'underline' }[key]]: 'toggle' }); return; }
    if (ctrl && key in ALIGN_KEYS && key.length === 1 && !e.shiftKey) { e.preventDefault(); if (sel) format({ align: ALIGN_KEYS[key] }); return; }
    // Tab steps through the objects on the page, Shift+Tab back (as in Publisher), so a page can
    // be worked with the keyboard alone: Enter then types in the object, the arrows move it.
    // From the page area with nothing selected Tab selects the first object; after Esc has let
    // go of an object, the next Tab leaves the page area as usual.
    if (e.key === 'Tab' && !ctrl && !e.altKey && doc && (t === view || t === document.body) && !(tabOut && !sel)) {
      const page = sel ? sel.page : current;
      const list = (doc.pages[page] ? doc.pages[page].shapes : []).filter((s) => (masterMode ? s.from_master : !s.from_master));
      if (list.length) {
        e.preventDefault();
        const i = sel ? list.indexOf(sel.shape) : -1;
        const n = list.length;
        const next = list[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n];
        select(page, next);
        view.focus({ preventScroll: true });
        announce(`${describeShape(next)}. ${list.indexOf(next) + 1} of ${n} on page ${page + 1}.`);
        return;
      }
    }
    if (e.key === 'Tab') tabOut = false;
    const arrow = e.key.startsWith('Arrow');
    const adx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const ady = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (e.key === 'PageDown') { e.preventDefault(); goTo(current + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); goTo(current - 1); }
    else if (e.key === 'Home' && ctrl) { e.preventDefault(); goTo(0); }
    else if (e.key === 'End' && ctrl && doc) { e.preventDefault(); goTo(doc.pages.length - 1); }
    else if (e.key === 'Escape') {
      if (cancelTool()) return;
      if (cropMode) setCropMode(false);
      else if (cellSel) { cellSel = null; showSel(); updateButtons(); syncToolbar(); }
      else if (sel) { select(0, null); tabOut = true; announce('Nothing selected.'); }
      else if (masterMode) setMasterMode(false);
    } else if (cellSel && sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); clearCells(); }
    else if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeSelected(); }
    else if (sel && e.key === 'Enter' && single() && sel.shape.wordart) { e.preventDefault(); editWordArt(sel.page, sel.shape); }
    else if (sel && single() && !cellSel && !ctrl && !e.altKey && e.key.length === 1 && e.key !== ' ' && (sel.shape.wordart || sel.shape.kind === 'text' || sel.shape.kind === 'shape')) {
      // a letter typed with a box selected goes into it (WordArt: its words are replaced)
      e.preventDefault();
      if (sel.shape.wordart) { editWordArt(sel.page, sel.shape, e.key); return; }
      const page = sel.page, shape = sel.shape;
      if (!shape.text) {
        pushUndo(page);
        shape.text = newTextBody();
        rerender(page);
      }
      const el = shapeEl(page, shape);
      const flow = el && el.querySelector('.op-flow');
      if (flow && flow.opOwner) {
        startEdit(page, shape, flow, null, { a: { p: 1e6, o: 1e9 }, b: { p: 1e6, o: 1e9 } });
        document.execCommand('insertText', false, e.key);
      }
    }
    else if (sel && e.key === 'Enter' && single()) {
      const target = cellSel ? rangeCells(cellSel)[0] : null;
      const el = shapeEl(sel.page, sel.shape);
      let flow = el && el.querySelector('.op-flow');
      if (target) flow = findFlow(sel.page, sel.shape, target) || flow;
      if (flow && flow.opOwner) { e.preventDefault(); startEdit(sel.page, sel.shape, flow, null, { a: { p: 0, o: 0 }, b: { p: 1e6, o: 1e9 } }); }
    } else if (cellSel && sel && arrow) { e.preventDefault(); moveCellSel(ady, adx, e.shiftKey); }
    else if (sel && arrow) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      nudge(adx * step, ady * step);
    }
  });

  view.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  window.OpenPubApp = {
    reload: load,
    drag: (v) => {
      document.body.classList.toggle('drag', !!v);
      document.body.classList.toggle('dragpics', v === 2 && !!doc);
    },
    picturesAdded,
    imagesAdded,
    error: (msg) => showNotes([msg]),
    note: (msg) => showNotes([msg], 6000),
    saved: (name, path) => {
      if (doc) { doc.name = name; if (path) doc.path = path; }
      dirty = true; // force the title refresh below
      setDirty(false);
      showNotes(['Saved ' + name], 3000);
    },
    printDone: (msg) => {
      if (printRestore) printRestore();
      if (msg) showNotes([msg], 6000);
    },
    pictureAdded: (index, w, h) => {
      if (!doc) return;
      version++;
      if (replaceTarget) {
        const t = replaceTarget;
        replaceTarget = null;
        if (doc.pages[t.page] && doc.pages[t.page].shapes.includes(t.shape)) { finishReplace(t, index, w, h); return; }
      }
      let pw = w * 0.75, ph = h * 0.75;
      const f = Math.min(1, (doc.width * 0.6) / pw, (doc.height * 0.6) / ph);
      pw *= f;
      ph *= f;
      const p = visibleSpot(pw, ph);
      addShape({ kind: 'picture', shape_type: 75, x: p.x, y: p.y, w: pw, h: ph, image: index }, false);
    },
    /** Asked by the window before closing or opening another file. */
    isDirty: () => dirty,
    docJson,
    /** Internals for automated checks (see tools/apptest.js and tools/edittest.js). */
    test: {
      doc: () => doc, sheets: () => sheets, select, selectMany, selectAll, startEdit, commitEdit, format, addText, addBasic, addTable, addPage, deletePage, duplicatePage, movePage, duplicate, removeSelected,
      shapeEl, goTo, undo: () => restore(undoStack, redoStack), redo: () => restore(redoStack, undoStack), send, exportPdf,
      state: () => ({ sel, editing: !!editing, textSel, cellSel, dirty, undo: undoStack.length, masterMode, cropMode, tab: activeTab, current, busy }),
      reorder, groupSel, ungroupSel, nudge, setGeom, setRotation, rotateBy, setFill, setTransparency, setLine,
      setMargin, setVAlign, setColumns, setColumnGap,
      setBullet, setNumbering, clearList, toggleBullets, toggleNumbering, indent, setSpacing, setParaSpace,
      selectCells, insertRows, insertCols, deleteRows, deleteCols, mergeCells, splitCells, setCellFill, setCellVAlign, setBorders, setPen, clearCells,
      addWordArt, setWordArt, setGradient, setShadow, setLink, normalLink, setTableStyle, setPicture, pagePng, exportPng, applyTemplate, templatePages,
      alignSel, flipSel, setPageSize, setPageBackground, addPageBorder,
      findMatches, findNext, replaceOne, replaceAll, showFind, hideFind, stepSize, toggleScript, replaceRange,
      replacePicture, setCropMode, cropTo, setCropSide, copySel, pasteClip, handlePaste, setMasterMode, showTab, syncToolbar,
      quiet: (v) => { quiet = !!v; }, toLocal, gridHit, rowEdges,
      clean: () => setDirty(false),
      setBorderArt, setBorderSize, docBorders,
      bookletPlan, prepareBooklet, exportBookletPdf, printRestore: () => printRestore && printRestore(),
      setPattern,
      armTool, cancelTool, tool: () => tool, snapTargets, snap1, showCtx, hideCtx, openSwatches, hideSwatches, setArrows, picturesAdded,
      autosaveNow, docJsonLive, checkUnsaved, setUnsavedSince: (t) => { unsavedSince = t; },
      editWordArt, endWordArt, fitBoxToText, shrinkTextToFit, overflowing, openPick, closePick, applyPick,
      pickRows: () => pick.rows.map((d) => d.dataset.v), systemFonts: () => systemFonts, loadSystemFonts,
    },
  };

  updateButtons();
  load();
  send({ cmd: 'ready' });
})();
