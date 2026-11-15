"""Compare our model (pubdump json) with Publisher's ground truth (truth.ps1).

python compare.py model.json truth.json [-v] [page ...]
Reports, per page, shapes whose geometry or text don't match.
"""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
args = [a for a in sys.argv[1:] if a != '-v']
verbose = '-v' in sys.argv
model = json.load(open(args[0], encoding='utf-8-sig'))
truth = json.load(open(args[1], encoding='utf-8-sig'))
want = [int(a) for a in args[2:]]


def flat_truth(shapes, out):
    for s in shapes:
        if s.get('children'):
            flat_truth(s['children'], out)
        else:
            out.append(s)
    return out


def flat_model(shapes, out):
    for s in shapes:
        if s.get('children'):
            flat_model(s['children'], out)
        elif s['kind'] != 'group':
            out.append(s)
    return out


def model_text(s):
    if s.get('text'):
        return '\r'.join(''.join(r['text'] for r in p['runs']) for p in s['text']['paras'])
    return None


def norm(t):
    return (t or '').replace('\x0b', '\n').replace('\r', ' ').replace('\n', ' ').strip()


tot_bad = tot = 0
for tp in truth['pages']:
    idx = tp['index']
    if want and idx not in want:
        continue
    mp = model['pages'][idx - 1] if idx - 1 < len(model['pages']) else {'shapes': []}
    ts = flat_truth(tp['shapes'], [])
    ms = [s for s in flat_model(mp['shapes'], []) if not s.get('from_master')]
    used = set()
    lines = []
    for t in ts:
        best, bd = None, 1e9
        for i, m in enumerate(ms):
            if i in used:
                continue
            d = abs(m['x'] - t['left']) + abs(m['y'] - t['top']) + abs(m['w'] - t['width']) + abs(m['h'] - t['height'])
            if d < bd:
                best, bd = i, d
        tot += 1
        issues = []
        if best is None or bd > 3:
            tot_bad += 1
            near = ms[best] if best is not None else None
            issues.append(f"NO MATCH (nearest d={bd:.1f}: {near and [round(near[k], 1) for k in 'xywh']} seq={near and near['seq']})")
        else:
            used.add(best)
            m = ms[best]
            if abs((m.get('rotation') or 0) % 360 - (t.get('rotation') or 0) % 360) > 0.5:
                issues.append(f"rot {m.get('rotation')} vs {t.get('rotation')}")
            if bool(m.get('fill')) != bool(t.get('fillBGR')) and not t.get('table'):
                issues.append(f"fill {m.get('fill')} vs {t.get('fillBGR')}")
            if bool(m.get('line')) != bool(t.get('line')) and not t.get('table'):
                issues.append(f"line {m.get('line')} vs {t.get('line')}")
            if t.get('text') is not None:
                a, b = norm(model_text(m)), norm(t['text']['text'])
                if a != b:
                    issues.append(f"text {a[:40]!r} vs {b[:40]!r}")
            if t.get('table'):
                tt, mt = t['table'], m.get('table')
                if not mt:
                    issues.append('table missing')
                else:
                    if len(mt['cols']) != len(tt['cols']) or any(abs(a - b) > 0.5 for a, b in zip(mt['cols'], tt['cols'])):
                        issues.append(f"cols {mt['cols']} vs {tt['cols']}")
                    if len(mt['rows']) != len(tt['rows']) or any(abs(a - b) > 0.5 for a, b in zip(mt['rows'], tt['rows'])):
                        issues.append(f"rows {[round(r, 1) for r in mt['rows']]} vs {tt['rows']}")
                    tc = {(c['r'] - 1, c['c'] - 1): c for c in tt['cells']}
                    bad = 0
                    for c in mt['cells']:
                        ref = tc.get((c['r0'], c['c0']))
                        if not ref:
                            continue
                        a = norm('\r'.join(''.join(r['text'] for r in p['runs']) for p in c['paras']))
                        if a != norm(ref['text']):
                            bad += 1
                            if bad <= 2:
                                issues.append(f"cell r{c['r0']}c{c['c0']} {a[:30]!r} vs {norm(ref['text'])[:30]!r}")
                    if bad > 2:
                        issues.append(f"... {bad} cells differ")
        if issues or verbose:
            lines.append(f"   {t['name'][:20]:20} [{t['left']},{t['top']} {t['width']}x{t['height']}] " + '; '.join(issues))
    extra = [m for i, m in enumerate(ms) if i not in used]
    for m in extra:
        lines.append(f"   EXTRA in model: seq={m['seq']} {m['kind']} [{m['x']:.1f},{m['y']:.1f} {m['w']:.1f}x{m['h']:.1f}] {norm(model_text(m))[:30]!r}")
    print(f"PAGE {idx}: truth {len(ts)} shapes, model {len(ms)}" + ('' if lines else '  OK'))
    for l in lines:
        print(l)
print(f"unmatched {tot_bad}/{tot}")
