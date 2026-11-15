// Automated check of the File screen (info, recent files, new publication), run inside a debug build:
//   openpub.exe <file.pub> --eval=tools/filetest.js
// Prints "[page] OK ..." / "[page] FAIL ..." lines and a SUMMARY line, then quits. Set
// window.FILETEST_STAY = 'info' | 'new' | 'open' to stop on that pane instead (for screenshots).
const T = OpenPubApp.test;
const log = (t) => window.ipc.postMessage(JSON.stringify({ cmd: 'log', text: String(t) }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let okN = 0, failN = 0;
const check = (name, cond, detail) => {
  if (cond) okN++; else failN++;
  log((cond ? 'OK   ' : 'FAIL ') + name + (!cond && detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
};
const shown = (id) => !$(id).hidden;
const key = (k, opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
const pane = (name) => document.querySelector(`#filenav [data-pane="${name}"]`).click();

(async () => {
  const first = T.doc();
  check('a document is open and the File screen is hidden', !!first && !shown('file'));

  $('filebtn').click();
  check('File opens on Info', shown('file') && shown('fp-info') && !shown('fp-open'));
  const info = [...$('infogrid').querySelectorAll('dt')].map((e) => e.textContent);
  check('Info lists name, location, pages and page size', ['Name', 'Location', 'Pages', 'Page size'].every((k) => info.includes(k)), info);
  check('Info shows where the file is', $('infogrid').textContent.includes(first.path || '???'), first.path);
  check('Info lists the fonts with their status', $('infofonts').children.length >= 2 && /Installed|Not installed/.test($('infofonts').textContent), $('infofonts').textContent.slice(0, 80));
  if (window.FILETEST_STAY === 'info') return;

  pane('new');
  check('New shows page-size cards', shown('fp-new') && $('newcards').children.length >= 5, $('newcards').children.length);
  if (window.FILETEST_STAY === 'new') return;

  pane('open');
  await wait(500);
  check('Open shows Browse and the recent list', shown('fp-open') && !!$('open') && $('recent').children.length >= 1);
  if (window.FILETEST_STAY === 'open') return;

  pane('export');
  check('Export offers PDF and Word', shown('fp-export') && !!$('pdf') && !!$('docx'));

  key('Escape');
  check('Esc goes back to the publication', !shown('file'));

  key('n', { ctrlKey: true });
  check('Ctrl+N opens New', shown('file') && shown('fp-new'));

  // a new A5 landscape publication (nothing to lose: the document is unchanged)
  const card = [...$('newcards').children].find((c) => /A5/.test(c.textContent) && /landscape/.test(c.textContent));
  card.click();
  await wait(1800);
  const d = T.doc();
  check('New makes a blank one-page publication', d && d !== first && d.pages.length === 1 && d.pages[0].shapes.length === 0, d && d.pages.length);
  check('with the chosen page size', d && Math.abs(d.width - 595.28) < 0.5 && Math.abs(d.height - 419.53) < 0.5, d && [d.width, d.height]);
  check('named PublicationN, not saved yet', d && /^Publication\d+$/.test(d.name) && !d.path, d && d.name);
  check('and shown (File screen closed)', !shown('file') && T.sheets().length === 1);

  T.addText();
  await wait(300);
  check('a text box can be added to it', T.doc().pages[0].shapes.length === 1 && T.state().dirty);

  $('filebtn').click();
  check('Info of an unsaved publication says so', /Not saved yet/.test($('infogrid').textContent));
  check('Save is available', !$('fsave').disabled && !$('saveas').disabled);

  log(`SUMMARY ${okN} OK, ${failN} FAIL`);
  window.ipc.postMessage(JSON.stringify({ cmd: 'dirty', value: false }));
  window.ipc.postMessage(JSON.stringify({ cmd: 'quit' }));
})();
