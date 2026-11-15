"""Measures Publisher's line pitch per font (from truth.json paragraph boxes) and compares it with
the font files' vertical metrics, to find how Publisher spaces lines.

python tools/linepitch.py
"""
import collections, glob, json, os, struct, winreg

FONTS = os.path.join(os.environ['WINDIR'], 'Fonts')


def font_files():
    out = {}
    for hive, key in [(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'),
                      (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts')]:
        try:
            k = winreg.OpenKey(hive, key)
        except OSError:
            continue
        i = 0
        while True:
            try:
                name, val, _ = winreg.EnumValue(k, i)
            except OSError:
                break
            i += 1
            path = val if os.path.isabs(val) else os.path.join(FONTS, val)
            base = name.split(' (')[0]
            for part in base.split(' & '):
                out.setdefault(part.strip().lower(), path)
    return out


def metrics(path):
    data = open(path, 'rb').read()
    if data[:4] == b'ttcf':
        off = struct.unpack('>I', data[12:16])[0]
    else:
        off = 0
    n = struct.unpack('>H', data[off + 4:off + 6])[0]
    tables = {}
    for i in range(n):
        tag, _, o, l = struct.unpack('>4sIII', data[off + 12 + i * 16: off + 28 + i * 16])
        tables[tag.decode('latin1')] = o
    head = tables['head']
    upem = struct.unpack('>H', data[head + 18:head + 20])[0]
    hhea = tables['hhea']
    asc, desc, gap = struct.unpack('>hhh', data[hhea + 4:hhea + 10])
    os2 = tables['OS/2']
    typo_asc, typo_desc, typo_gap, win_asc, win_desc = struct.unpack('>hhhHH', data[os2 + 68:os2 + 78])
    return dict(upem=upem, hhea=(asc - desc + gap) / upem, hhea_ng=(asc - desc) / upem, win=(win_asc + win_desc) / upem,
                typo=(typo_asc - typo_desc + typo_gap) / upem, win_asc=win_asc / upem, win_desc=win_desc / upem)


files = font_files()
pitch = collections.defaultdict(list)
for f in glob.glob('truth/*/truth.json'):
    t = json.load(open(f, encoding='utf-8-sig'))

    def walk(ss):
        for s in ss:
            walk(s.get('children') or [])
            tx = s.get('text')
            if not tx:
                continue
            for p in tx.get('paras') or []:
                if not p.get('font') or not p.get('size') or p['size'] <= 0 or not p.get('lines') or p['lines'] < 2:
                    continue
                if p.get('lsRule') != 5 and p.get('lsRule') != 0:
                    continue
                sp = p['ls'] if p.get('lsRule') == 5 else 1.0
                h = (p['bh'] - (p.get('after') or 0) - (p.get('before') or 0)) / p['lines']
                pitch[p['font']].append(h / p['size'] / sp)
    for p in t['pages']:
        walk(p['shapes'])

print(f"{'font':24} {'n':>4} {'measured':>9} {'win':>6} {'hhea':>6} {'hhea-gap':>8} {'typo':>6}")
for font, v in sorted(pitch.items(), key=lambda kv: -len(kv[1])):
    v.sort()
    med = v[len(v) // 2]
    path = files.get(font.lower())
    m = metrics(path) if path and os.path.exists(path) else None
    if m:
        print(f"{font[:24]:24} {len(v):4} {med:9.3f} {m['win']:6.3f} {m['hhea']:6.3f} {m['hhea_ng']:8.3f} {m['typo']:6.3f}")
    else:
        print(f"{font[:24]:24} {len(v):4} {med:9.3f}  (font file not found)")
