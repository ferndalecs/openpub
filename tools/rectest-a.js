// Recovery test, part 1 (run by tools/rectest.ps1): changes a publication, has a recovery copy
// written - also while text is still being typed - then waits to be killed (a "crash").
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const state = async () => (await fetch('state.json?v=' + Date.now())).json();
(async () => {
  try {
    T.send({ cmd: 'autosaveTest' });
    check('no copy while nothing has changed', !(await state()).recovery);
    T.addText(); await wait(200);
    document.execCommand('insertText', false, 'RECOVER-ME');
    T.commitEdit(); await wait(200);
    T.autosaveNow(); await wait(2000);
    let st = await state();
    check('a change makes a recovery copy next to the publication', !!st.recovery && /~\$rectest\.pub\.recovery\.opub$/.test(st.recovery) && st.autosaves === 1, st);
    // text still being typed goes into the copy, and the typing carries on
    const page = T.state().current;
    const box = T.doc().pages[page].shapes[T.doc().pages[page].shapes.length - 1];
    const flow = T.shapeEl(page, box).querySelector('.op-flow');
    T.startEdit(page, box, flow, null, { a: { p: 0, o: 1e9 }, b: { p: 0, o: 1e9 } });
    await wait(100);
    document.execCommand('insertText', false, ' LIVE');
    T.autosaveNow(); await wait(2000);
    st = await state();
    check('a copy can be written while typing, without stopping it', st.autosaves === 2 && T.state().editing, [st.autosaves, T.state().editing]);
    log(`SUMMARY ${okN} OK, ${failN} FAIL`);
    log('KILL-ME');
  } catch (e) { check('no error', false, String(e)); log(`SUMMARY ${okN} OK, ${failN} FAIL`); log('KILL-ME'); }
})();
