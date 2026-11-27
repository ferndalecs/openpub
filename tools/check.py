"""Renders samples with OpenPub and compares them with Publisher's own pictures of the pages.

python tools/check.py [--no-build] [--geom] <slug|all> [page ...]

For each sample: exports HTML (out/html-<slug>), screenshots the pages next to Publisher's
(out/shots-<slug>/page-NNN-side.png), prints a difference score per page (0 = identical) and
writes out/scores.json. With --geom it also runs the shape/geometry comparison (compare.py).
Needs truth/<slug>/ from tools/truth-all.ps1.
"""
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402
import quiet  # noqa: E402,F401  (programs it starts open no console windows)

args = sys.argv[1:]
build = '--no-build' not in args
geom = '--geom' in args
args = [a for a in args if not a.startswith('--')]
which = args[0] if args else 'all'
pages = [int(a) for a in args[1:]]

exe = ROOT / 'target' / 'debug' / 'pubdump.exe'
if build:
    r = subprocess.run(['cargo', 'build', '-q', '-p', 'openpub-core'], cwd=ROOT)
    if r.returncode:
        sys.exit('build failed')

scores_path = ROOT / 'out' / 'scores.json'
scores = json.loads(scores_path.read_text()) if scores_path.exists() else {}
for slug, path in samples():
    if which not in ('all', slug):
        continue
    truth = ROOT / 'truth' / slug
    if not (truth / 'truth.json').exists():
        print(f'{slug}: no ground truth yet')
        continue
    html = ROOT / 'out' / f'html-{slug}'
    subprocess.run([str(exe), 'html', str(path), str(html)], check=True)
    t = json.loads((truth / 'truth.json').read_text(encoding='utf-8-sig'))
    want = pages or list(range(1, t['pageCount'] + 1))
    if geom:
        model = ROOT / 'out' / f'model-{slug}.json'
        with open(model, 'w', encoding='utf-8') as f:
            subprocess.run([str(exe), 'json', str(path)], stdout=f, check=True)
        print(subprocess.run([sys.executable, str(ROOT / 'tools' / 'compare.py'), str(model), str(truth / 'truth.json')], capture_output=True, text=True, encoding='utf-8').stdout.strip().splitlines()[-1])
    out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'shot.py'), str(html), str(truth), str(ROOT / 'out' / f'shots-{slug}')] + [str(p) for p in want],
                         capture_output=True, text=True)
    vals = {}
    for line in out.stdout.splitlines():
        if line.startswith('page '):
            n, d = line[5:].split(': diff ')
            vals[n] = float(d)
    if out.returncode:
        print(out.stderr[-2000:])
    scores.setdefault(slug, {}).update(vals)
    mean = sum(vals.values()) / max(1, len(vals))
    worst = sorted(vals.items(), key=lambda kv: -kv[1])[:6]
    print(f'{slug}: {len(vals)} pages, mean diff {mean:.2f}; worst ' + ', '.join(f'p{k} {v:.1f}' for k, v in worst))
scores_path.write_text(json.dumps(scores, indent=1))
