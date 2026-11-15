"""Scores Word PDF exports against Publisher's page images: mean absolute difference per page
(grey levels at 36 dpi; 0 = identical), for one or more PDFs of the same sample side by side.

python docx-score.py <slug> <a.pdf> [<b.pdf> ...]
"""
import json, pathlib, sys
import numpy as np, pymupdf
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = pathlib.Path(__file__).resolve().parent.parent
slug, pdfs = sys.argv[1], sys.argv[2:]
truth = ROOT / 'truth' / slug
info = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
aspect = info['pageWidth'] / info['pageHeight']
docs = [pymupdf.open(p) for p in pdfs]
DPI = 36
tot = [0.0] * len(docs)
n = min(len(d) for d in docs)
for k in range(1, n + 1):
    tp = truth / f'page-{k:03d}.png'
    if not tp.exists():
        continue
    t = Image.open(tp).convert('L')
    if t.width / t.height > aspect * 1.5:
        half = t.width // 2
        t = t.crop((0, 0, half, t.height)) if k % 2 == 0 else t.crop((half, 0, t.width, t.height))
    row = []
    for i, d in enumerate(docs):
        pix = d[k - 1].get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
        w = Image.frombytes('L', (pix.width, pix.height), pix.samples)
        tt = t.resize(w.size, Image.BOX)
        s = float(np.abs(np.asarray(w, float) - np.asarray(tt, float)).mean())
        tot[i] += s
        row.append(s)
    flag = ''
    if len(row) > 1 and abs(row[-1] - row[0]) > 0.5:
        flag = '  <-- better' if row[-1] < row[0] else '  <-- WORSE'
    print(f'page {k:3d}: ' + '  '.join(f'{s:6.2f}' for s in row) + flag)
print('total   : ' + '  '.join(f'{s:6.1f}' for s in tot))
