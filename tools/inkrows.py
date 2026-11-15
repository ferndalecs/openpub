"""Prints where lines of ink start and end (pt) in a region of a page, ours and Publisher's,
from the screenshots made by check.py (144 dpi).

python tools/inkrows.py <slug> <page> <x0> <y0> <x1> <y1>      (region in points)
"""
import pathlib, sys
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
slug, page = sys.argv[1], int(sys.argv[2])
x0, y0, x1, y1 = [float(v) for v in sys.argv[3:7]]
K = 2.0
for n in ('ours', 'truth'):
    im = Image.open(ROOT / 'out' / f'shots-{slug}' / f'page-{page:03d}-{n}.png').convert('L')
    px = im.load()
    bands, start = [], None
    for y in range(int(y0 * K), int(y1 * K)):
        c = sum(1 for x in range(int(x0 * K), int(x1 * K), 2) if px[x, y] < 120)
        if c > 3 and start is None:
            start = y
        elif c <= 3 and start is not None:
            bands.append((start / K, y / K))
            start = None
    if start is not None:
        bands.append((start / K, y1))
    print(n.ljust(5), ' '.join(f'{a:.1f}-{b:.1f}' for a, b in bands))
