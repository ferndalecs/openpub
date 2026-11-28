// Shared folders (0.3.21): saving over a publication someone else saved since this window opened
// it asks first - keep both (yours goes to "name (2).opub") or replace. The test answers the
// question through testAnswer (true: keep both, false: replace). Run inside a debug build:
//   openpub.exe samples/Worksheet_8.pub --eval=tools/sharetest.js
// (the runner deletes out/share-poster*.opub first)
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const state = async () => (await fetch('state.json?v=' + Date.now())).json();
const save = async (path) => { T.send({ cmd: 'save', doc: OpenPubApp.docJson(), path }); await wait(1200); };
(async () => {
  try {
    const P = OPENPUB_OUT + 'share-poster.opub';
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    await save(P);
    check('saved as an OpenPub document', norm((await state()).path).endsWith('share-poster.opub'));
    T.addBasic(1); await wait(200);
    await save(P);
    let st = await state();
    check('saving again, when nobody else has saved it, just saves', norm(st.path).endsWith('share-poster.opub') && !st.dirty, st);

    // someone else saves it; this window keeps both
    T.send({ cmd: 'otherSaveTest' }); await wait(200);
    T.send({ cmd: 'testAnswer', value: true });
    T.addBasic(3); await wait(200);
    await save(P);
    st = await state();
    check('after someone else saved it, "keep both" saves yours as "share-poster (2).opub"', /share-poster \(\d+\)\.opub$/.test(norm(st.path)) && !st.dirty, st.path);
    const copy = st.path;
    check('...and says so', /Saved your version as share-poster \(\d+\)\.opub/.test(document.body.textContent), document.getElementById('notes') && document.getElementById('notes').textContent);

    // someone saves the copy too; this time replace theirs
    T.send({ cmd: 'otherSaveTest' }); await wait(200);
    T.send({ cmd: 'testAnswer', value: false });
    T.addBasic(1); await wait(200);
    await save(copy);
    st = await state();
    check('"replace" saves over it under the same name', norm(st.path) === norm(copy) && !st.dirty, st.path);

    // and nothing asks when the file is unchanged
    T.send({ cmd: 'testAnswer', value: true });
    T.addBasic(1); await wait(200);
    await save(copy);
    st = await state();
    check('...after which saving is quiet again', norm(st.path) === norm(copy), st.path);
  } catch (e) { check('no error', false, String(e && e.stack || e)); }
  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
