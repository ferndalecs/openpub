"""Sample publications and their short names (slugs) used for output folders.

python samples.py            -> prints "slug<TAB>path" for every distinct sample
python samples.py <slug>     -> prints the path of that sample
"""
import hashlib, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SAMPLES = ROOT / 'samples'


def slug(path):
    s = re.sub(r'[^a-z0-9]+', '-', path.stem.lower()).strip('-')
    return s[:40].rstrip('-')


def samples():
    seen, out = set(), []
    files = sorted(SAMPLES.glob('*.pub'), key=lambda p: p.name.lower())
    files += sorted((SAMPLES / 'probe').glob('*.pub'))  # made by tools/makeprobe.ps1
    for p in files:
        h = hashlib.md5(p.read_bytes()).hexdigest()
        if h in seen:
            continue  # byte-identical copy
        seen.add(h)
        out.append((slug(p), p))
    return out


if __name__ == '__main__':
    sys.stdout.reconfigure(newline=chr(10))
    all_ = samples()
    if len(sys.argv) > 1:
        for s, p in all_:
            if s == sys.argv[1]:
                print(p)
                break
        else:
            sys.exit('no sample ' + sys.argv[1])
    else:
        for s, p in all_:
            print(f'{s}\t{p}')
