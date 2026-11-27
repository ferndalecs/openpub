// Recovery test, part 3 (run by tools/rectest.ps1): a copy goes when the window closes
// normally; a new publication left unsaved gets a reminder.
const T = OpenPubApp.test;
const $ = (id) => document.getElementById(id);
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const state = async () => (await fetch('state.json?v=' + Date.now())).json();
(async () => {
  try {
    T.send({ cmd: 'autosaveTest' });
    T.addBasic('rect'); await wait(200);
    T.autosaveNow(); await wait(2000);
    check('a copy is kept', !!(await state()).recovery);
    // a new publication, unsaved for a while
    T.send({ cmd: 'new', width: 595.276, height: 841.89 });
    await wait(1500);
    check('starting a new publication lets the old copy go', !(await state()).recovery);
    T.addBasic('rect'); await wait(200);
    T.checkUnsaved();
    check('no reminder straight away', $('savebar').hidden);
    T.setUnsavedSince(Date.now() - 6 * 60000);
    T.checkUnsaved();
    check('after 5 minutes unsaved, a reminder to save', !$('savebar').hidden);
    $('savebarx').click();
    T.checkUnsaved();
    check('"later" puts it off', $('savebar').hidden);
    T.autosaveNow(); await wait(2000);
    const st = await state();
    check('a new publication keeps its copy in the user\'s own folder', !!st.recovery && /OpenPub[\\/]recovery[\\/]/.test(st.recovery), st.recovery);
    log('COPY ' + st.recovery);
  } catch (e) { check('no error', false, String(e)); }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
