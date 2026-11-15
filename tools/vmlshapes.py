"""Turns Office's VML shapetype definitions (from tools/vmlshapes.ps1) into the data table in
web/shapes.js.

python tools/vmlshapes.py out/shapes/vml.docx            # prints the table
python tools/vmlshapes.py out/shapes/vml.docx --write    # replaces it in web/shapes.js

Each entry: Escher type: [default adjust values, path, formulas (';'-separated), text
rectangle, flags ('l' = limo: the shape keeps its proportions, 'o' = one-dimensional/no fill)].
"""
import pathlib, re, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1])
xml = zipfile.ZipFile(src).read('word/document.xml').decode('utf8')
types = {}
for st in re.findall(r'<v:shapetype .*?</v:shapetype>', xml, re.S):
    attr = lambda name, s=st: (re.search(r'\s' + name + r'="([^"]*)"', s) or [None, None])[1]
    spt = int(attr('o:spt'))
    if attr('coordsize') != '21600,21600' or attr('coordorigin'):
        print(f'warning: {spt} has coordsize {attr("coordsize")} origin {attr("coordorigin")}', file=sys.stderr)
    path_el = re.search(r'<v:path [^>]*>', st)
    pel = path_el.group(0) if path_el else ''
    tb = attr('textboxrect', pel) or ''
    tb = tb.split(';')[0]
    flags = ''
    if attr('limo', pel):
        flags += 'l'
    if attr('fillok', pel) == 'f':
        flags += 'o'
    if 'joinstyle="miter"' not in st:
        flags += 'r'
    formulas = re.findall(r'<v:f eqn="([^"]*)"', st)
    types[spt] = [attr('adj') or '', attr('path'), ';'.join(formulas), tb, flags]

lines = []
for spt in sorted(types):
    v = types[spt]
    lines.append(f"    {spt}: [{', '.join(repr(x) for x in v)}],")
table = '\n'.join(lines)
if '--write' in sys.argv:
    p = ROOT / 'web' / 'shapes.js'
    js = p.read_text(encoding='utf8')
    a = js.index('// BEGIN VML DATA')
    b = js.index('// END VML DATA')
    a = js.index('\n', a) + 1
    b = js.rindex('\n', 0, b) + 1
    js = js[:a] + table + '\n' + js[b:]
    p.write_text(js, encoding='utf8')
    print(f'{len(types)} shape types written to {p}')
else:
    print(table)
