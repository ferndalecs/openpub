"""Side-by-side comparison of a Word PDF export with Publisher's own page images.

python docx-cmp.py <word.pdf> <slug> <out-dir> [page ...]

Writes <out-dir>/cmp-<slug>-NNN.png: Publisher (truth/<slug>/page-NNN.png, cropped to the single
page when it is a two-page spread) on the left, Word's PDF page on the right, both at 100 dpi.
"""
import json, os, pathlib, sys
import pymupdf
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = pathlib.Path(__file__).resolve().parent.parent
pdf, slug, out = sys.argv[1:4]
pages = [int(p) for p in sys.argv[4:]]
truth = ROOT / 'truth' / slug
info = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
aspect = info['pageWidth'] / info['pageHeight']
os.makedirs(out, exist_ok=True)
doc = pymupdf.open(pdf)
print('pdf pages:', len(doc), ' publisher pages:', info.get('pageCount'))
DPI = 100
for n in pages or range(1, len(doc) + 1):
    if n > len(doc):
        print('no page', n)
        continue
    pix = doc[n - 1].get_pixmap(dpi=DPI)
    w = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    tp = truth / f'page-{n:03d}.png'
    if tp.exists():
        t = Image.open(tp).convert('RGB')
        if t.width / t.height > aspect * 1.5:  # a spread: even pages on the left
            half = t.width // 2
            t = t.crop((0, 0, half, t.height)) if n % 2 == 0 else t.crop((half, 0, t.width, t.height))
        t = t.resize(w.size, Image.LANCZOS)
    else:
        t = Image.new('RGB', w.size, (200, 200, 200))
    sheet = Image.new('RGB', (w.width * 2 + 10, w.height), (255, 0, 0))
    sheet.paste(t, (0, 0))
    sheet.paste(w, (w.width + 10, 0))
    p = os.path.join(out, f'cmp-{slug}-{n:03d}.png')
    sheet.save(p)
    print(p)
