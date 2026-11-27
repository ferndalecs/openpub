"""Screenshot pages of an HTML export with headless Edge and put them next to Publisher's own
rendering.

python shot.py <export dir> <truth dir> <out dir> page [page ...]

For each page writes <out>/page-NNN-ours.png, -truth.png (cropped to the single page) and
-side.png (ours | truth), all at 144 dpi, and prints a difference score (0 = identical).
"""
import concurrent.futures, json, os, pathlib, subprocess, sys, tempfile
from PIL import Image, ImageChops, ImageStat
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quiet  # noqa: E402,F401  (Edge starts without a console window)

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not os.path.exists(EDGE):
    EDGE = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

export, truth, out = map(pathlib.Path, sys.argv[1:4])
pages = [int(p) for p in sys.argv[4:]]
out.mkdir(parents=True, exist_ok=True)
SCALE = 1.5  # 96 css px/in * 1.5 = 144 dpi
DPI = 300    # truth.ps1 saves pictures at 300 dpi
Image.MAX_IMAGE_PIXELS = None
info = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
aspect = info['pageWidth'] / info['pageHeight']


def one(n):
    t = Image.open(truth / f'page-{n:03d}.png').convert('RGB')
    # Publisher saves facing pages as one picture: even pages on the left, odd on the right
    if t.width / t.height > aspect * 1.5:
        half = t.width // 2
        t = t.crop((0, 0, half, t.height)) if n % 2 == 0 else t.crop((half, 0, t.width, t.height))
    w, h = round(t.width * 144 / DPI), round(t.height * 144 / DPI)
    t = t.resize((w, h), Image.LANCZOS)
    ours_path = out / f'page-{n:03d}-ours.png'
    url = (export / 'index.html').resolve().as_uri() + f'?page={n}&scale={SCALE}'
    with tempfile.TemporaryDirectory() as profile:  # separate profiles so runs can overlap
        subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', f'--user-data-dir={profile}',
                        f'--window-size={w},{h}', f'--screenshot={ours_path.resolve()}', '--virtual-time-budget=5000', url],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    o = Image.open(ours_path).convert('RGB')
    if o.size != (w, h):
        c = Image.new('RGB', (w, h), 'white')
        c.paste(o, (0, 0))
        o = c
    t.save(out / f'page-{n:03d}-truth.png')
    side = Image.new('RGB', (w * 2 + 10, h), (255, 0, 255))
    side.paste(o, (0, 0))
    side.paste(t, (w + 10, 0))
    side.save(out / f'page-{n:03d}-side.png')
    diff = ImageChops.difference(o.convert('L').resize((w // 4, h // 4), Image.BOX), t.convert('L').resize((w // 4, h // 4), Image.BOX))
    return n, ImageStat.Stat(diff).mean[0]


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    for n, d in pool.map(one, pages):
        print(f'page {n}: diff {d:.2f}', flush=True)
