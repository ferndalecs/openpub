// Converting a whole folder (0.3.23): File > Open > Convert a whole folder starts another OpenPub
// (openpub.exe --convert <folder> --to ...) in the background and says how it went. The test names
// the folders instead of choosing them in a folder window. Run inside a debug build:
//   openpub.exe samples/Worksheet_8.pub --eval=tools/converttest.js
// (the runner makes out/conv/src first: two publications, one in a subfolder, and a damaged one;
// afterwards it checks the files made)
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let okN = 0, failN = 0;
const check = (name, cond, detail) => { if (cond) okN++; else failN++; log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); };
const notes = () => (document.getElementById('notes') || document.body).textContent;
const until = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(notes())) return true; await wait(250); } return false; };
const clearNotes = () => { const n = document.getElementById('notes'); if (n) n.textContent = ''; };
(async () => {
  try {
    const SRC = OPENPUB_OUT + 'conv/src';
    check('the buttons are in File > Open', ['convpdf', 'convdocx', 'convopub'].every((id) => document.getElementById(id) && document.getElementById(id).closest('#fp-open')));

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'docx', path: SRC, out: OPENPUB_OUT + 'conv/word' });
    // (a few small files can be done before the test looks)
    check('says it has started', await until(/Converting 3 Publisher files to Word|Done: /, 5000), notes());
    check('the page can still be used meanwhile', !T.state().busy);
    check('Word: says how it went', await until(/Done: 2 files converted, 1 couldn't be converted/, 60000), notes());
    check('...and where the list of what was done is', /openpub-convert\.log/.test(notes()), notes());

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'docx', path: SRC, out: OPENPUB_OUT + 'conv/word' });
    check('again: the files already made are left alone', await until(/Done: 0 files converted, 1 couldn't be converted, 2 already there/, 60000), notes());

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'pdf', path: SRC, out: OPENPUB_OUT + 'conv/pdf' });
    check('PDF: says how it went', await until(/Done: 2 files converted, 1 couldn't be converted/, 120000), notes());

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'opub', path: SRC + '/Year 7', out: OPENPUB_OUT + 'conv/opub' });
    check('OpenPub: one subfolder', await until(/Done: 1 file converted/, 60000), notes());

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'pdf', path: OPENPUB_OUT + 'conv/empty' });
    check('a folder with no Publisher files says so', await until(/There are no Publisher \(\.pub\) files/, 5000), notes());

    clearNotes();
    T.send({ cmd: 'convertFolder', to: 'png', path: SRC });
    await wait(1500);
    check('other formats are refused', !/Converting/.test(notes()), notes());

    check('the open publication is unchanged', !T.state().dirty && T.doc().pages.length === 2);
  } catch (e) {
    check('no error', false, String(e) + ' ' + (e.stack || ''));
  }
  log(`SUMMARY ${okN} ok, ${failN} failed`);
  T.send({ cmd: 'quit' });
})();
