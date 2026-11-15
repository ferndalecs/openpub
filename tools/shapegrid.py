"""Close-up comparison of autoshapes: ours next to Publisher's, one cell per shape.

python tools/shapegrid.py <slug> <page> <out.png> [--types 1,2,3] [--zoom 1.0] [--pad 10] [--all] [--cols N] [--no-shot]

Renders the page of out/html-<slug> (run tools/check.py first) at 300 dpi with headless Edge,
crops every autoshape (kind "shape" or "line", not text boxes and pictures unless --all) from it
and from truth/<slug>/page-NNN.png, and lays the pairs out in a grid labelled with the shape
type (ours left, Publisher right).
"""
import json, os, pathlib, subprocess, sys, tempfile
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not os.path.exists(EDGE):
    EDGE = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
Image.MAX_IMAGE_PIXELS = None

args = sys.argv[1:]
opts = {}
pos = []
i = 0
while i < len(args):
    a = args[i]
    if a in ('--types', '--zoom', '--pad', '--cols'):
        opts[a] = args[i + 1]
        i += 2
        continue
    if a.startswith('--'):
        opts[a] = True
    else:
        pos.append(a)
    i += 1
slug, page, outp = pos[0], int(pos[1]), pathlib.Path(pos[2])
types = set(int(t) for t in opts['--types'].split(',')) if '--types' in opts else None
zoom = float(opts.get('--zoom', 1.0))
pad = float(opts.get('--pad', 8))
cols = int(opts.get('--cols', 8))
DPI = 300
K = DPI / 72

path = dict(samples())[slug]
exe = ROOT / 'target' / 'debug' / 'pubdump.exe'
model = json.loads(subprocess.run([str(exe), 'json', str(path)], capture_output=True, check=True).stdout)
truth = ROOT / 'truth' / slug
info = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
t = Image.open(truth / f'page-{page:03d}.png').convert('RGB')
aspect = info['pageWidth'] / info['pageHeight']
if t.width / t.height > aspect * 1.5:
    half = t.width // 2
    t = t.crop((0, 0, half, t.height)) if page % 2 == 0 else t.crop((half, 0, t.width, t.height))
tk = t.width / info['pageWidth']  # truth px per pt

shot = ROOT / 'out' / 'shapes' / f'{slug}-p{page}-300.png'
shot.parent.mkdir(parents=True, exist_ok=True)
w, h = round(model['width'] * K), round(model['height'] * K)
if '--no-shot' not in opts or not shot.exists():
    url = (ROOT / 'out' / f'html-{slug}' / 'index.html').resolve().as_uri() + f'?page={page}&scale={DPI / 96}'
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', f'--user-data-dir={profile}',
                        f'--window-size={w},{h}', f'--screenshot={shot.resolve()}', '--virtual-time-budget=5000', url],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
o = Image.open(shot).convert('RGB')


def walk(shapes):
    for s in shapes:
        if s['kind'] == 'group':
            yield from walk(s.get('children', []))
        else:
            yield s


cells = []
for s in walk(model['pages'][page - 1]['shapes']):
    if types is not None and s['shape_type'] not in types:
        continue
    if types is None and not opts.get('--all') and s['kind'] not in ('shape', 'line'):
        continue
    x0, y0, x1, y1 = s['x'] - pad, s['y'] - pad, s['x'] + s['w'] + pad, s['y'] + s['h'] + pad
    if s.get('rotation'):
        cx, cy, r = s['x'] + s['w'] / 2, s['y'] + s['h'] / 2, max(s['w'], s['h']) / 2 + pad
        x0, y0, x1, y1 = cx - r, cy - r, cx + r, cy + r
    a = o.crop((round(x0 * K), round(y0 * K), round(x1 * K), round(y1 * K)))
    b = t.crop((round(x0 * tk), round(y0 * tk), round(x1 * tk), round(y1 * tk))).resize(a.size, Image.LANCZOS)
    if zoom != 1:
        a = a.resize((round(a.width * zoom), round(a.height * zoom)), Image.LANCZOS)
        b = b.resize(a.size, Image.LANCZOS)
    adj = s.get('adjust')
    label = f"{s['shape_type']} seq{s['seq']}" + (f" {adj}" if adj else '')
    cells.append((label, a, b))

if not cells:
    sys.exit('no shapes')
cw = max(a.width for _, a, _ in cells) * 2 + 6
ch = max(a.height for _, a, _ in cells) + 18
cols = min(cols, len(cells))
rows = (len(cells) + cols - 1) // cols
sheet = Image.new('RGB', (cols * (cw + 8), rows * (ch + 8)), (60, 60, 60))
d = ImageDraw.Draw(sheet)
for i, (label, a, b) in enumerate(cells):
    x, y = (i % cols) * (cw + 8), (i // cols) * (ch + 8)
    sheet.paste(a, (x, y + 16))
    sheet.paste(b, (x + a.width + 6, y + 16))
    d.text((x + 2, y + 2), label[:60], fill=(255, 255, 0))
outp.parent.mkdir(parents=True, exist_ok=True)
sheet.save(outp)
print(f'{len(cells)} shapes -> {outp}')
