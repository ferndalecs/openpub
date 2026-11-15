"""Compact summary of truth.json: python truthsum.py truth.json [page ...]"""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
d = json.load(open(sys.argv[1], encoding='utf-8-sig'))
want = [int(a) for a in sys.argv[2:]]
def short(t, n=50):
    t = (t or '').replace('\r', '¶').replace('\n', '↵').replace('\x0b', '↓').replace('\t', '→')
    return t[:n] + ('…' if len(t) > n else '')
def shape(s, ind):
    line = f"{ind}{s['name'][:22]:22} t{s['type']} a{s.get('auto')} [{s['left']},{s['top']} {s['width']}x{s['height']}] rot={s.get('rotation')} z={s.get('z')}"
    if s.get('fillBGR'): line += f" fill={s['fillBGR']}"
    if s.get('line'): line += f" line={s['line']}"
    print(line)
    for c in s.get('children') or []: shape(c, ind + '    ')
    t = s.get('table')
    if t:
        print(f"{ind}   TABLE cols={t['cols']} rows={t['rows']}")
        for c in t['cells']:
            print(f"{ind}     r{c['r']}c{c['c']} {c['w']}x{c['h']} m={c['ml']},{c['mt']},{c['mr']},{c['mb']} va={c['va']} mg={c.get('merged')} {c['font']} {c['size']} al={c['align']} '{short(c['text'],40)}'")
    t = s.get('text')
    if t:
        print(f"{ind}   TEXT m={t['ml']},{t['mt']},{t['mr']},{t['mb']} va={t['va']} cols={t['cols']} fit={t['autofit']} or={t['orient']}")
        for p in t['paras']:
            print(f"{ind}     {p['font']} {p['size']} b{p['bold']} al={p['align']} ind={p['first']}/{p['left']}/{p['right']} sp={p['before']}/{p['after']} ls={p['ls']}r{p['lsRule']} list={p['list']} @({p['bleft']},{p['top']} {p['bw']}x{p['bh']}) L{p['lines']} '{short(p['text'])}'")
print(f"page {d['pageWidth']}x{d['pageHeight']} count={d['pageCount']}")
if not want:
    for m in d['masters']:
        print(f"MASTER {m['index']} {m['name']}")
        for s in m['shapes']: shape(s, '  ')
for p in d['pages']:
    if want and p['index'] not in want: continue
    print(f"PAGE {p['index']} num={p['number']} {p['width']}x{p['height']} master={p['master']}")
    for s in p['shapes']: shape(s, '  ')
