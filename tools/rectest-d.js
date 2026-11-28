// Recovery test, part 4 (run by tools/rectest.ps1): a publication opened from a folder the
// person can't write to (a teacher's read-only share): its recovery copy goes to the user's own
// OpenPub folder instead, and nothing is written next to the publication.
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const state = async () => (await fetch('state.json?v=' + Date.now())).json();
(async () => {
  try {
    check('a publication in a read-only folder opens', !!T.doc() && T.doc().pages.length > 0);
    T.send({ cmd: 'autosaveTest' });
    T.addBasic(1); await wait(200);
    T.autosaveNow(); await wait(2000);
    const st = await state();
    check('its recovery copy goes to the user\'s own folder', !!st.recovery && /OpenPub[\\/]recovery[\\/]/.test(st.recovery), st.recovery);
    log('COPY ' + st.recovery);
  } catch (e) { check('no error', false, String(e)); }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
