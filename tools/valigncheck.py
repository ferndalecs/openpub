"""Where the text of middle/bottom-aligned frames starts, ours vs Publisher's (pt, ours - theirs),
next to the extra line spacing of the frame's last line, from check.py's screenshots.

python tools/valigncheck.py <slug> [...]
"""
import json, pathlib, subprocess, sys
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402
K = 2.0


def first_ink(im, box):
    x0, y0, x1, y1 = [int(v * K) for v in box]
    x0, x1, y0, y1 = max(0, x0), min(im.width, x1), max(0, y0), min(im.height, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    px = im.load()
    for y in range(y0, y1):
        if sum(1 for x in range(x0, x1) if px[x, y] < 110) >= 2:
            return y / K
    return None


paths = dict(samples())
for slug in sys.argv[1:]:
    m = json.loads(subprocess.run([str(ROOT / 'target' / 'debug' / 'pubdump.exe'), 'json', str(paths[slug])], capture_output=True, text=True, encoding='utf-8').stdout)
    fonts = m.get('fonts', {})
    for i, page in enumerate(m['pages'], 1):
        o, t = ROOT / 'out' / f'shots-{slug}' / f'page-{i:03d}-ours.png', ROOT / 'out' / f'shots-{slug}' / f'page-{i:03d}-truth.png'
        if not o.exists():
            continue
        ours, truth = None, None
        for s in page['shapes']:
            tx = s.get('text')
            if not tx or tx['valign'] == 'top' or s.get('rotation') or tx.get('wrap'):
                continue
            paras = [p for p in tx['paras'] if any(r['text'].strip() for r in p['runs'])]
            if not paras:
                continue
            last = tx['paras'][-1]
            r = last['runs'][0] if last['runs'] else None
            f = fonts.get(r['font']) if r else None
            if not f or last.get('spacing_exact'):
                continue
            extra = (last['spacing'] - 1) * (f['ascent'] + f['descent'] + f['gap']) * r['size']
            if ours is None:
                ours, truth = Image.open(o).convert('L'), Image.open(t).convert('L')
            mg = tx['margins']
            box = (s['x'] + mg[0] + 1, s['y'] + 1, s['x'] + s['w'] - mg[2] - 1, s['y'] + s['h'] - 1)
            a, b = first_ink(ours, box), first_ink(truth, box)
            if a is None or b is None:
                continue
            print(f"{slug[:14]} p{i} seq {s['seq']:5} {tx['valign']:6} lines-extra {extra:5.2f}  ours-pub {a - b:+5.1f}")
