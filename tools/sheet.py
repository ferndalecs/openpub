"""Contact sheet of side-by-side comparisons: python sheet.py <shots dir> <out.png> page..."""
import sys, pathlib
from PIL import Image
d = pathlib.Path(sys.argv[1]); pages = [int(p) for p in sys.argv[3:]]
ims = [Image.open(d / f'page-{n:03d}-side.png') for n in pages]
W = 1150
ims = [im.resize((W, round(im.height * W / im.width)), Image.LANCZOS) for im in ims]
cols = 2
rows = (len(ims) + cols - 1) // cols
h = max(im.height for im in ims)
sheet = Image.new('RGB', (cols * W + (cols - 1) * 12, rows * h + (rows - 1) * 12), (40, 40, 40))
for i, im in enumerate(ims):
    sheet.paste(im, ((i % cols) * (W + 12), (i // cols) * (h + 12)))
sheet.save(sys.argv[2])
