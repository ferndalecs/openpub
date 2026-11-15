"""Compares where the first line of text starts in each text frame, ours vs Publisher's, using the
screenshots made by check.py (out/shots-<slug>/page-NNN-ours.png / -truth.png, 144 dpi).

python tools/firstline.py <slug> [page ...]
Prints per frame: font, size, line spacing, and the vertical offset (pt) of the first ink row
(ours - Publisher's), then the median offset per font.
"""
import collections, json, pathlib, subprocess, sys
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402

slug = sys.argv[1]
pages = [int(a) for a in sys.argv[2:]]
path = dict(samples())[slug]
m = json.loads(subprocess.run([str(ROOT / 'target' / 'debug' / 'pubdump.exe'), 'json', str(path)], capture_output=True, text=True, encoding='utf-8').stdout)
K = 2.0  # px per pt at 144 dpi
shots = ROOT / 'out' / f'shots-{slug}'
per_font = collections.defaultdict(list)


def first_ink(im, box):
    x0, y0, x1, y1 = [int(v * K) for v in box]
    x0, x1 = max(0, x0), min(im.width, x1)
    y0, y1 = max(0, y0), min(im.height, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    reg = im.crop((x0, y0, x1, y1)).load()
    for y in range(y1 - y0):
        dark = sum(1 for x in range(x1 - x0) if reg[x, y] < 110)
        if dark >= 2:
            return y / K
    return None


for i, page in enumerate(m['pages'], 1):
    if pages and i not in pages:
        continue
    o, t = shots / f'page-{i:03d}-ours.png', shots / f'page-{i:03d}-truth.png'
    if not o.exists() or not t.exists():
        continue
    ours, truth = Image.open(o).convert('L'), Image.open(t).convert('L')
    for s in page['shapes']:
        tx = s.get('text')
        if not tx or s.get('rotation') or s.get('fill') or s.get('line') or tx['valign'] != 'top':
            continue
        p = next((p for p in tx['paras'] if any(r['text'].strip() for r in p['runs'])), None)
        if not p or p is not tx['paras'][0] or p.get('before'):
            continue
        r = next(r for r in p['runs'] if r['text'].strip())
        mg = tx['margins']
        # only the first 3 lines' worth of height, away from other shapes as far as possible
        box = (s['x'] + mg[0] + 1, s['y'] + 1, s['x'] + s['w'] - mg[2] - 1, s['y'] + mg[1] + r['size'] * 2.5)
        a, b = first_ink(ours, box), first_ink(truth, box)
        if a is None or b is None:
            continue
        sp = ('%.2fpt' % p['spacing']) if p.get('spacing_exact') else ('%.2f' % p['spacing'])
        print(f"p{i} seq {s['seq']:5} {r['font'][:20]:20} {r['size']:5.1f} sp {sp:7} ours {a:6.1f} pub {b:6.1f} diff {a - b:+5.1f}")
        per_font[(r['font'], sp)].append(a - b)
print()
for k, v in sorted(per_font.items(), key=lambda kv: -len(kv[1])):
    v.sort()
    print(f'{k[0][:24]:24} sp {k[1]:7} n={len(v):3} median diff {v[len(v) // 2]:+5.2f} pt')
