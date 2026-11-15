"""Finds the drawings in an exported .docx that make Word refuse to open it.

python docx-bisect.py <file.docx> <work-dir>

The exporter puts every drawing in its own anchor paragraph; this keeps subsets of those
paragraphs, opens each trial document in Word (tools/docx-check.ps1) and narrows the failing set
down to single paragraphs, whose XML it writes to <work-dir>/bad-N.xml.
"""
import os, re, subprocess, sys, zipfile

src, work = sys.argv[1:3]
os.makedirs(work, exist_ok=True)
CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'docx-check.ps1')
z = zipfile.ZipFile(src)
parts = {n: z.read(n) for n in z.namelist()}
doc = parts['word/document.xml'].decode('utf-8')
head, rest = doc.split('<w:body>', 1)
body, tail = rest.rsplit('<w:sectPr>', 1)
# top-level paragraphs (anchor paragraphs never nest a <w:p> outside txbxContent at top level,
# so split on the paragraphs that start right after the previous one ends)
paras, depth, start = [], 0, 0
for m in re.finditer(r'<w:p>|<w:p [^>]*>|</w:p>', body):
    if m.group(0) == '</w:p>':
        depth -= 1
        if depth == 0:
            paras.append(body[start:m.end()])
    else:
        if depth == 0:
            start = m.start()
        depth += 1
print(len(paras), 'top-level paragraphs')
trial = [0]


def ok(idx):
    trial[0] += 1
    path = os.path.join(work, f'trial-{trial[0]}.docx')
    keep = ''.join(paras[i] for i in idx) or '<w:p/>'
    out = zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED)
    for n, d in parts.items():
        if n == 'word/document.xml':
            d = (head + '<w:body>' + keep + '<w:sectPr>' + tail).encode('utf-8')
        out.writestr(n, d)
    out.close()
    r = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CHECK, '-Docx', path, '-Pdf', path + '.pdf'], capture_output=True, text=True)
    good = r.returncode == 0
    print(f'  trial {trial[0]}: {len(idx)} paragraphs -> {"ok" if good else "FAIL"}', flush=True)
    return good


def bad_ones(idx):
    if ok(idx):
        return []
    if len(idx) == 1:
        return idx
    mid = len(idx) // 2
    return bad_ones(idx[:mid]) + bad_ones(idx[mid:])


bad = bad_ones(list(range(len(paras))))
for k, i in enumerate(bad):
    with open(os.path.join(work, f'bad-{k}.xml'), 'w', encoding='utf-8') as f:
        f.write(paras[i])
print('failing paragraphs:', bad)
