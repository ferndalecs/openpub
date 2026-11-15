"""Ranks autoshapes by how much our picture differs from Publisher's.

python tools/shapediff.py <slug> <page> [--no-shot]   (uses out/shapes/<slug>-p<page>-300.png made by shapegrid.py)
Prints, per shape, the mean grey-level difference inside its box (worst first).
"""
import json, pathlib, subprocess, sys
from PIL import Image, ImageChops, ImageFilter, ImageStat

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402
Image.MAX_IMAGE_PIXELS = None
slug, page = sys.argv[1], int(sys.argv[2])
path = dict(samples())[slug]
model = json.loads(subprocess.run([str(ROOT / 'target' / 'debug' / 'pubdump.exe'), 'json', str(path)], capture_output=True, check=True).stdout)
truth = ROOT / 'truth' / slug
info = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
t = Image.open(truth / f'page-{page:03d}.png').convert('L')
aspect = info['pageWidth'] / info['pageHeight']
if t.width / t.height > aspect * 1.5:
    half = t.width // 2
    t = t.crop((0, 0, half, t.height)) if page % 2 == 0 else t.crop((half, 0, t.width, t.height))
tk = t.width / info['pageWidth']
o = Image.open(ROOT / 'out' / 'shapes' / f'{slug}-p{page}-300.png').convert('L')
K = 300 / 72
rows = []
for s in model['pages'][page - 1]['shapes']:
    if s['kind'] not in ('shape', 'line'):
        continue
    x0, y0, x1, y1 = s['x'] - 4, s['y'] - 4, s['x'] + s['w'] + 4, s['y'] + s['h'] + 4
    a = o.crop((round(x0 * K), round(y0 * K), round(x1 * K), round(y1 * K)))
    b = t.crop((round(x0 * tk), round(y0 * tk), round(x1 * tk), round(y1 * tk))).resize(a.size)
    # blur a little so one-pixel offsets of thin lines don't dominate
    d = ImageChops.difference(a.filter(ImageFilter.GaussianBlur(3)), b.filter(ImageFilter.GaussianBlur(3)))
    rows.append((ImageStat.Stat(d).mean[0], s['shape_type'], s['seq']))
for v, ty, seq in sorted(rows, reverse=True):
    print(f'{v:6.2f}  type {ty:3d}  seq {seq}')
