"""Counts outlines marked inset, by shape type, across all samples: python tools/insetcount.py"""
import collections, json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402

cnt = collections.Counter()
ex = {}
for slug, path in samples():
    out = subprocess.run([str(ROOT / 'target' / 'debug' / 'pubdump.exe'), 'json', str(path)], capture_output=True, text=True, encoding='utf-8').stdout
    m = json.loads(out)

    def walk(lst, pi):
        for s in lst:
            walk(s.get('children', []), pi)
            ln = s.get('line')
            if ln:
                key = (s['shape_type'], bool(ln.get('inset')))
                cnt[key] += 1
                ex.setdefault(key, []).append((slug, pi, s['seq'], ln['width']))

    for i, p in enumerate(m['pages'], 1):
        walk(p['shapes'], i)
for k, v in sorted(cnt.items()):
    print(k, v, ex[k][:3])
