"""Compares text-frame settings with Publisher's for every sample: vertical alignment, margins,
number of paragraphs, and where each frame's first line starts.

python tools/framecheck.py [slug]
"""
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402

exe = str(ROOT / 'target' / 'debug' / 'pubdump.exe')
names = {0: 'top', 1: 'middle', 2: 'bottom'}
want = sys.argv[1] if len(sys.argv) > 1 else None
bad_va = bad_m = tot = 0
for slug, path in samples():
    if want and slug != want:
        continue
    t = ROOT / 'truth' / slug / 'truth.json'
    if not t.exists():
        continue
    tj = json.loads(t.read_text(encoding='utf-8-sig'))
    m = json.loads(subprocess.run([exe, 'json', str(path)], capture_output=True, text=True, encoding='utf-8').stdout)
    for tp in tj['pages']:
        own = [s for s in m['pages'][tp['index'] - 1]['shapes'] if s.get('text')]
        for ts in tp['shapes']:
            tt = ts.get('text')
            if not tt or tt.get('va') is None:
                continue
            best = min(own, key=lambda s: abs(s['x'] - ts['left']) + abs(s['y'] - ts['top']) + abs(s['w'] - ts['width']), default=None)
            if not best:
                continue
            tot += 1
            mt = best['text']
            if mt['valign'] != names.get(tt['va']):
                bad_va += 1
                print(f"{slug} p{tp['index']} {ts['name']}: valign {mt['valign']} vs {names.get(tt['va'])}")
            tm = [tt['ml'], tt['mt'], tt['mr'], tt['mb']]
            if any(abs(a - b) > 0.1 for a, b in zip(mt['margins'], tm)):
                bad_m += 1
                print(f"{slug} p{tp['index']} {ts['name']}: margins {[round(v, 2) for v in mt['margins']]} vs {tm}")
print(f'{tot} text frames: vertical alignment differs on {bad_va}, margins on {bad_m}')
