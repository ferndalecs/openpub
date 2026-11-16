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
  const imageUrl = (i) => 'img/' + i + '?v=' + version;
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
    const wrap = OpenPub.renderPage(doc, s.index, { scale, imageUrl, editable: true });
    s.clip.appendChild(wrap);
    wrap.opFinish();
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

  function setDirty(v) {
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
    redoStack = [];
    setDirty(true);
    updateButtons();
  }
  function restore(from, to) {
    const e = from.pop();
    if (!e) return;
    commitEdit();
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
    if (masterMode) t = 'Master page' + (t ? ' · ' + t : '');
    $('selinfo').textContent = t;
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
      d.dx = dx;
      d.dy = dy;
      for (const el of d.els) if (el) el.style.translate = `${dx}pt ${dy}pt`;
      for (const b of selBoxes) b.style.translate = `${dx * k()}px ${dy * k()}px`;
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
    if (r.kerning) o.kerning = r.kerning;
    if (r.field) o.field = r.field;
    if (r.object) o.object = r.object;
    return o;
  }
  const sameStyle = (a, b) => a.font === b.font && a.size === b.size && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && a.color === b.color && (a.script || 0) === (b.script || 0) && !!a.strike === !!b.strike && (a.effect || 0) === (b.effect || 0) && (a.caps || 0) === (b.caps || 0) && (a.tracking || 0) === (b.tracking || 0) && (a.kerning || 0) === (b.kerning || 0);

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
          if (c.classList.contains('op-obj') || (c.dataset && c.dataset.field)) {
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
    editing = { flow, owner: flow.opOwner, shape, page, before: JSON.stringify(flow.opOwner.paras) };
    for (const e of flow.querySelectorAll('.op-empty')) {
      e.textContent = '';
      e.appendChild(document.createElement('br'));
    }
    // a page number is one unit: text typed next to it must not go inside it
    for (const f of flow.querySelectorAll('[data-field]')) f.contentEditable = 'false';
    flow.contentEditable = 'true';
    flow.spellcheck = false;
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
    showSel();
    updateButtons();
    syncToolbar();
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
    ed.flow.contentEditable = 'false';
    const paras = readFlow(ed.flow, ed.owner.paras);
    const after = JSON.stringify(paras);
    if (after !== ed.read) {
      // record the page as it was before typing started
      ed.owner.paras = JSON.parse(ed.before);
      pushUndo(ed.page);
      ed.owner.paras = paras;
    }
    rerender(ed.page);
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
    for (const s of sel.shapes) out.push(...owners(s));
    return out;
  }

  function applyRuns(para, s, e, fn) {
    const out = [];
    let pos = 0;
    for (const r of para.runs) {
      const len = r.object ? 1 : r.text.length;
      const a = Math.max(s, pos), b = Math.min(e, pos + len);
      if (r.object || b <= a) {
        // an empty paragraph still takes the formatting so typing into it uses it
        if (!r.object && len === 0 && s <= pos && e >= pos) fn(r);
        out.push(r);
      } else {
        if (a > pos) out.push(Object.assign({}, r, { text: r.text.slice(0, a - pos) }));
        const mid = Object.assign({}, r, { text: r.text.slice(a - pos, b - pos) });
        fn(mid);
        out.push(mid);
        if (b < pos + len) out.push(Object.assign({}, r, { text: r.text.slice(b - pos) }));
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
    const target = textSel || (sel && { page: sel.page });
    if (!target) return;
    const paraFn = change.para || ('align' in change ? (p) => { p.align = change.align; } : null);
    const runKeys = Object.keys(change).filter((key) => key !== 'para' && key !== 'align');
    pushUndo(target.page);
    const ranged = textSel && (textSel.a.p !== textSel.b.p || textSel.a.o !== textSel.b.o);
    const toggleState = currentStyle() || {};
    const apply = (r) => {
      for (const key of runKeys) r[key] = change[key] === 'toggle' ? !toggleState[key] : typeof change[key] === 'function' ? change[key](r[key], r) : change[key];
    };
    if (textSel && (ranged || paraFn)) {
      const ps = textSel.owner.paras;
      const last = Math.min(textSel.b.p, ps.length - 1);
      for (let p = textSel.a.p; p <= last; p++) {
        if (paraFn) paraFn(ps[p], p, ps, p === textSel.a.p);
        if (runKeys.length) applyRuns(ps[p], p === textSel.a.p ? textSel.a.o : 0, p === textSel.b.p ? textSel.b.o : 1e9, apply);
      }
    } else {
      const list = textSel ? [textSel.owner] : targetOwners();
      list.forEach((o, n) => o.paras.forEach((p, i) => {
        if (paraFn) paraFn(p, i, o.paras, n === 0 && i === 0);
        if (runKeys.length) applyRuns(p, 0, 1e9, apply);
      }));
    }
    rerender(target.page);
    if (resume) {
      const flow = findFlow(resume.page, resume.shape, resume.owner);
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
        b.addEventListener('click', () => addBasic(type));
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
    $('watext').focus();
    $('watext').select();
  }
  function setWordArt(change, type) {
    editShapes((s) => {
      if (!s.wordart) return;
      if (change) Object.assign(s.wordart, change);
      if (type) s.shape_type = type;
    }, true);
  }
  /** dir: null = no gradient, a number = its angle; color2: the second colour. */
  function setGradient(dir, color2) {
    editShapes((s) => {
      if (!s.fill || s.fill.image != null || s.kind === 'line') return;
      if (dir === null) { delete s.fill.color2; delete s.fill.angle; return; }
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

  const PAGE_SIZES = { a4: [210 * 72 / 25.4, 297 * 72 / 25.4], a5: [148 * 72 / 25.4, 210 * 72 / 25.4], a3: [297 * 72 / 25.4, 420 * 72 / 25.4], letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224] };
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

  // ---- find and replace -----------------------------------------------------------------------

  /** The text of a paragraph as searched: one character per text character; objects and fields
   * can't match. */
  const paraText = (para) => para.runs.map((r) => (r.object ? '\uFFFC' : r.field ? '\uFFFC'.repeat(r.text.length) : r.text)).join('');

  /** Every match in the publication, in reading order: { page, shape, oi, owner, p, o, len }. */
  function findMatches(q, matchCase) {
    const out = [];
    if (!q || !doc) return out;
    const needle = matchCase ? q : q.toLowerCase();
    doc.pages.forEach((pg, page) => {
      let oi = 0;
      for (const shape of pg.shapes) {
        const own = owners(shape);
        // master-page items are edited on the master page
        const skip = !!shape.from_master !== !!masterMode;
        for (const owner of own) {
          if (!skip) {
            owner.paras.forEach((para, p) => {
              const hay = matchCase ? paraText(para) : paraText(para).toLowerCase();
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
    const picked = editing && s.rangeCount && editing.flow.contains(s.anchorNode) ? String(s).trim() : '';
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
  function showMatch(m) {
    commitEdit();
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
    findLast = m;
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
      const n = r.object ? 1 : r.text.length;
      const a = Math.max(o, pos), b = Math.min(o + len, pos + n);
      if (!r.object && !r.field && b > a) {
        out.push(Object.assign({}, r, { text: r.text.slice(0, a - pos) + (put ? '' : text) + r.text.slice(b - pos) }));
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
    return matchCase ? t === q : t.toLowerCase() === q.toLowerCase();
  };

  function replaceOne() {
    const q = $('findq').value, matchCase = $('findcase').checked;
    if (!q) return;
    if (!findLast || !stillThere(findLast, q, matchCase)) { findLast = null; findNext(); return; }
    const m = findLast, text = $('findr').value;
    pushUndo(m.page);
    replaceRange(m.owner.paras[m.p], m.o, m.len, text);
    rerender(m.page);
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
      if (first && start > 1) p.bullet.start = start;
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
    format({ para: (p) => {
      p.spacing = v;
      if (exact) p.spacing_exact = true; else delete p.spacing_exact;
    } });
  }
  function setParaSpace(key, v) {
    if (!(v >= 0)) return;
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
    // gradient, shadow, link, WordArt
    const grad = f && f.fill.color2 ? f.fill : null;
    setv('graddir', grad ? String(grad.angle || 0) : '');
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
    if (wa) { setv('watext', wa.wordart.text.replace(/\n/g, ' / ')); setv('wafont', wa.wordart.font); setv('wastyle', String(wa.shape_type)); }
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
    en(['fill', 'nofill', 'transp', 'graddir', 'fill2'], s && lv.some((x) => x.kind !== 'line'));
    en(['shadowbtn', 'shadowcolor', 'linkbtn'], s);
    en(['addwa'], has);
    en(['linecolor', 'linewidth', 'dash'], s && lv.length > 0);
    en(['gx', 'gy', 'grot', 'rotl', 'rotr', 'rot0'], s);
    en(['gw', 'gh'], s && n === 1);
    en(['ml', 'mt', 'mr', 'mb', 'vt', 'vm', 'vb', 'ncols', 'colgap'], s && lv.some((x) => x.text));
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
    const copies = selOrdered().map((s) => {
      const c = clone(s);
      reseq(c);
      shift(c, 12, 12);
      return c;
    });
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
    handlePaste((e.clipboardData || window.clipboardData).getData('text/plain'));
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
    if (!doc && !['new', 'open', 'options'].includes(pane)) pane = 'open';
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
    if (pane === 'open' && !doc) askAssoc();
    if (pane === 'info') fillInfo();
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
  ];
  function fillNew() {
    const box = $('newcards');
    fillTemplates();
    if (box.children.length) return;
    for (const [name, what, w, h] of NEW_SIZES) {
      const card = mk('button', 'card');
      const sheet = mk('div', 'sheetbox');
      const mini = mk('div', 'mini');
      const k = 118 / (420 * MM); // A3's long side fills the box
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

  /** The first-run question: shown once, on the start screen, when .pub files open elsewhere. */
  async function askAssoc() {
    try {
      const st = await (await fetch('start.json?v=' + Date.now())).json();
      $('assocask').hidden = !st.askAssoc;
    } catch (e) { $('assocask').hidden = true; }
  }

  // ---- ready-made designs ---------------------------------------------------------------------

  let pendingTemplate = null;
  const A4W = 210 * MM, A4H = 297 * MM;
  /** Builders of the designs: each returns the pages (lists of shapes) for the given page size. */
  const TEMPLATES = {
    flyer: { name: 'Event flyer', what: 'A4 portrait', w: A4W, h: A4H, colors: ['#0f6e5f', '#f4a261', '#fff8ec'] },
    newsletter: { name: 'Newsletter', what: 'A4 portrait · 2 pages', w: A4W, h: A4H, colors: ['#1f4e79', '#e6eef5', '#ffffff'] },
    certificate: { name: 'Certificate', what: 'A4 landscape', w: A4H, h: A4W, colors: ['#8a6d1d', '#fbf6e6', '#ffffff'] },
    poster: { name: 'Notice or poster', what: 'A4 portrait', w: A4W, h: A4H, colors: ['#b3261e', '#ffffff', '#ffffff'] },
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
      sheet.appendChild(mini);
      card.appendChild(sheet);
      card.appendChild(mk('b', '', t.name));
      card.appendChild(mk('span', '', t.what));
      card.addEventListener('click', () => { pendingTemplate = id; send({ cmd: 'new', width: t.w, height: t.h }); });
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
    const names = new Set(['Arial', 'Calibri', 'Cambria', 'Century Gothic', 'Comic Sans MS', 'Consolas', 'Cooper Black', 'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana']);
    const walk = (s) => {
      for (const o of owners(s)) for (const p of o.paras) for (const r of p.runs) if (r.font) names.add(r.font);
    };
    for (const p of doc.pages) for (const s of p.shapes) walk(s);
    const dl = $('fontlist');
    dl.textContent = '';
    for (const n of [...names].sort((a, b) => a.localeCompare(b))) {
      const o = document.createElement('option');
      o.value = n;
      dl.appendChild(o);
    }
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
      showFile('open'); // the start screen
      return;
    }
    doc = data;
    if (pendingTemplate) {
      if (!doc.path) applyTemplate(pendingTemplate);
      pendingTemplate = null;
    }
    sel = null;
    editing = null;
    textSel = null;
    cellSel = null;
    cropMode = false;
    clip = null;
    undoStack = [];
    redoStack = [];
    dirty = false;
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
    showNotes(doc.notes);
    updateButtons();
    syncToolbar();
    view.focus();
  }

  function docJson() {
    commitEdit();
    return JSON.stringify(doc);
  }
  function save(as) {
    if (!doc) return;
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
    printRestore = () => {
      printRestore = null;
      busy = false;
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
  function printAll() {
    if (!doc || busy) return;
    preparePrint().then(() => {
      window.addEventListener('afterprint', () => printRestore && printRestore(), { once: true });
      window.print();
    });
  }
  function exportPdf() {
    if (!doc || busy) return;
    preparePrint().then(() => send({ cmd: 'pdf', width: doc.width, height: doc.height, path: exportPdf.path }));
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
  on('assoc', () => send({ cmd: 'associate' }));
  on('filebtn', () => showFile(doc ? 'info' : 'open'));
  on('fileback', hideFile);
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
  onChange('watext', (v) => setWordArt({ text: v.split(/\s*\/\s*/).join('\n') || ' ' }));
  onChange('wafont', (v) => v.trim() && setWordArt({ font: v.trim() }));
  onChange('wastyle', (v) => setWordArt(null, parseInt(v, 10)));
  onChange('graddir', (v) => setGradient(v === '' ? null : parseFloat(v)));
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
  on('addpic', insertPicture);
  on('addrect', () => addBasic(1));
  on('addellipse', () => addBasic(3));
  on('addline', () => addBasic(20));
  on('addtext', addText);
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
  $('font').addEventListener('change', (e) => e.target.value.trim() && format({ font: e.target.value.trim() }));
  $('size').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v >= 1 && v <= 999) format({ size: v }); });
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
    const arrow = e.key.startsWith('Arrow');
    const adx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const ady = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (e.key === 'PageDown') { e.preventDefault(); goTo(current + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); goTo(current - 1); }
    else if (e.key === 'Home' && ctrl) { e.preventDefault(); goTo(0); }
    else if (e.key === 'End' && ctrl && doc) { e.preventDefault(); goTo(doc.pages.length - 1); }
    else if (e.key === 'Escape') {
      if (cropMode) setCropMode(false);
      else if (cellSel) { cellSel = null; showSel(); updateButtons(); syncToolbar(); }
      else if (sel) select(0, null);
      else if (masterMode) setMasterMode(false);
    } else if (cellSel && sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); clearCells(); }
    else if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeSelected(); }
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
    drag: (v) => document.body.classList.toggle('drag', !!v),
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
      state: () => ({ sel, editing: !!editing, textSel, cellSel, dirty, undo: undoStack.length, masterMode, cropMode, tab: activeTab, current }),
      reorder, groupSel, ungroupSel, nudge, setGeom, setRotation, rotateBy, setFill, setTransparency, setLine,
      setMargin, setVAlign, setColumns, setColumnGap,
      setBullet, setNumbering, clearList, toggleBullets, toggleNumbering, indent, setSpacing, setParaSpace,
      selectCells, insertRows, insertCols, deleteRows, deleteCols, mergeCells, splitCells, setCellFill, setCellVAlign, setBorders, setPen, clearCells,
      addWordArt, setWordArt, setGradient, setShadow, setLink, normalLink, setTableStyle, setPicture, pagePng, exportPng, applyTemplate, templatePages,
      alignSel, flipSel, setPageSize, setPageBackground, addPageBorder,
      findMatches, findNext, replaceOne, replaceAll, showFind, hideFind, stepSize, toggleScript, replaceRange,
      replacePicture, setCropMode, cropTo, setCropSide, copySel, pasteClip, handlePaste, setMasterMode, showTab, syncToolbar,
      quiet: (v) => { quiet = !!v; }, toLocal, gridHit, rowEdges,
    },
  };

  updateButtons();
  load();
  send({ cmd: 'ready' });
})();
