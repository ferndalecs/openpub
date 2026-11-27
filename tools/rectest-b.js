// Recovery test, part 2 (run by tools/rectest.ps1 after part 1 was killed): opening the same
// publication offers the copy (the test answers "Recover"); saving removes it.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const state = async () => (await fetch('state.json?v=' + Date.now())).json();
const allText = () => JSON.stringify(T.doc().pages);
(async () => {
  try {
    await wait(500);
    check('the changes made before the crash are back', allText().includes('RECOVER-ME LIVE'), allText().includes('RECOVER-ME'));
    let st = await state();
    check('...marked as not saved', T.state().dirty && st.dirty);
    check('...and this window keeps the copy from now on', !!st.recovery && /~\$rectest\.pub\.recovery\.opub$/.test(st.recovery), st.recovery);
    check('...the publication is still the original file', /rectest\.pub$/.test(st.path || ''), st.path);
    T.send({ cmd: 'save', doc: OpenPubApp.docJson(), path: OPENPUB_OUT + 'rec/rectest-saved.opub' });
    await wait(1500);
    st = await state();
    check('saving lets the copy go', !st.recovery && !st.dirty, st);
  } catch (e) { check('no error', false, String(e)); }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
