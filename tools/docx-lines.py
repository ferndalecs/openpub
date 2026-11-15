"""Prints the y positions (pt) of long horizontal rules on a page: truth vs the Word PDF.
Usage: python docx-lines.py <word.pdf> <truth-dir> <page> [min-fraction]"""
import sys, os
import numpy as np, pymupdf
from PIL import Image

pdf, truth, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
frac = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25
t = Image.open(os.path.join(truth, "page-%03d.png" % n))
if t.width > t.height:
    half = t.width // 2
    t = t.crop((0, 0, half, t.height)) if n % 2 == 0 else t.crop((half, 0, t.width, t.height))
pix = pymupdf.open(pdf)[n - 1].get_pixmap(dpi=300)
w = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
for name, im in (("truth", t), ("word ", w)):
    a = np.asarray(im.convert("L")) < 140
    sc = a.shape[0] / 841.89
    cnt = a.sum(axis=1)
    ys = [y for y in range(a.shape[0]) if cnt[y] > a.shape[1] * frac]
    out = []
    for y in ys:
        if not out or y - out[-1][1] > 2:
            out.append([y, y])
        else:
            out[-1][1] = y
    print(name, [round((a_ + b_) / 2 / sc, 1) for a_, b_ in out])
