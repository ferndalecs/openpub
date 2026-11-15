"""Side-by-side comparison sheets: Publisher's truth image (left) and the Word PDF page (right).
Usage: python docx-pages.py <word.pdf> <truth-dir> <out-dir> [pages...]"""
import sys, os
import pymupdf
from PIL import Image

pdf, truth, out = sys.argv[1:4]
pages = [int(p) for p in sys.argv[4:]]
os.makedirs(out, exist_ok=True)
doc = pymupdf.open(pdf)
print("pdf pages:", len(doc))
for n in pages or range(1, len(doc) + 1):
    pix = doc[n - 1].get_pixmap(dpi=110)
    w = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    t = Image.open(os.path.join(truth, "page-%03d.png" % n)).convert("RGB")
    if t.width > t.height:  # a spread: even pages on the left
        half = t.width // 2
        t = t.crop((0, 0, half, t.height)) if n % 2 == 0 else t.crop((half, 0, t.width, t.height))
    t = t.resize(w.size, Image.LANCZOS)
    sheet = Image.new("RGB", (w.width * 2 + 10, w.height), (255, 0, 0))
    sheet.paste(t, (0, 0))
    sheet.paste(w, (w.width + 10, 0))
    sheet.save(os.path.join(out, "cmp-%03d.png" % n))
