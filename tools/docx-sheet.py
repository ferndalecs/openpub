"""Contact sheets of the comparison images made by docx-pages.py.
Usage: python docx-sheet.py <cmp-dir> [per-sheet]"""
import sys, os, glob
from PIL import Image

d = sys.argv[1]
per = int(sys.argv[2]) if len(sys.argv) > 2 else 6
files = sorted(glob.glob(os.path.join(d, "cmp-*.png")))
for i in range(0, len(files), per):
    ims = [Image.open(f) for f in files[i:i + per]]
    w, h = ims[0].width // 2, ims[0].height // 2
    cols = 2
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 8), rows * (h + 8)), (40, 40, 200))
    for k, im in enumerate(ims):
        sheet.paste(im.resize((w, h), Image.LANCZOS), ((k % cols) * (w + 8), (k // cols) * (h + 8)))
    sheet.save(os.path.join(d, "sheet-%02d.png" % (i // per + 1)))
