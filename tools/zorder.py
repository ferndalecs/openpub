"""Checks that shapes are stacked in the same order as in Publisher, for every sample.

python tools/zorder.py
"""
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402

exe = str(ROOT / 'target' / 'debug' / 'pubdump.exe')
bad = tot = 0
for slug, path in samples():
    t = ROOT / 'truth' / slug / 'truth.json'
    if not t.exists():
        continue
    tj = json.loads(t.read_text(encoding='utf-8-sig'))
    m = json.loads(subprocess.run([exe, 'json', str(path)], capture_output=True, text=True, encoding='utf-8').stdout)
    for tp in tj['pages']:
        mp = m['pages'][tp['index'] - 1]
        own = [s for s in mp['shapes'] if not s.get('from_master')]
        order = []
        for ts in sorted(tp['shapes'], key=lambda s: s.get('z') or 0):
            best = min(own, key=lambda s: abs(s['x'] - ts['left']) + abs(s['y'] - ts['top']) + abs(s['w'] - ts['width']) + abs(s['h'] - ts['height']), default=None)
            if best is not None:
                order.append(own.index(best))
        tot += 1
        if order != sorted(order):
            bad += 1
            print(slug, 'page', tp['index'], order[:16])
print('pages stacked differently:', bad, 'of', tot)
