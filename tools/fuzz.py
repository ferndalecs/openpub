"""Stress test of the .pub and .opub readers: damages copies of sample files in many ways and
checks that the reader either opens them or reports an error - no crash (panic), no hang, no
runaway memory.

python tools/fuzz.py [runs per sample, default 150] [seed] [slug,slug,...]

Uses target/debug/pubdump.exe (cargo build -p openpub-core first). Files that made the reader
crash or hang are kept in out/fuzz/ for investigation. Without a list of samples it takes the
smaller ones and the shapes probe (WordArt gradients, textures, transparent pictures).
"""
import pathlib, random, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from samples import samples  # noqa: E402
import quiet  # noqa: E402,F401  (pubdump starts without a console window)

runs = int(sys.argv[1]) if len(sys.argv) > 1 else 150
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 20261115
only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
rng = random.Random(seed)
exe = ROOT / 'target' / 'debug' / 'pubdump.exe'
out = ROOT / 'out' / 'fuzz'
out.mkdir(parents=True, exist_ok=True)
work = out / 'case.pub'
TIMEOUT = 40

# the smaller samples: quick to read, so many cases can be tried
if only:
    picked = [(slug, pathlib.Path(p)) for slug, p in samples() if slug in only]
else:
    picked = [(slug, pathlib.Path(p)) for slug, p in samples() if pathlib.Path(p).stat().st_size < 3_000_000][:6]
    picked += [(slug, pathlib.Path(p)) for slug, p in samples() if slug == 'probe-shapes' and slug not in [s for s, _ in picked]]


def damage(data: bytearray) -> str:
    kind = rng.choice(['flip', 'flip', 'burst', 'truncate', 'zero', 'ff', 'dup', 'ints', 'header'])
    n = len(data)
    if kind == 'flip':
        for _ in range(rng.choice([1, 2, 5, 20, 100])):
            data[rng.randrange(n)] ^= 1 << rng.randrange(8)
    elif kind == 'burst':
        at = rng.randrange(n)
        for i in range(at, min(n, at + rng.choice([4, 16, 64, 512]))):
            data[i] = rng.randrange(256)
    elif kind == 'truncate':
        del data[rng.randrange(max(1, n // 20), n):]
    elif kind == 'zero':
        at = rng.randrange(n)
        for i in range(at, min(n, at + rng.choice([8, 64, 4096]))):
            data[i] = 0
    elif kind == 'ff':
        at = rng.randrange(n)
        for i in range(at, min(n, at + rng.choice([4, 8, 64]))):
            data[i] = 0xFF
    elif kind == 'dup':
        a, b = rng.randrange(n), rng.randrange(n)
        ln = rng.choice([16, 256, 4096])
        data[b:b + ln] = data[a:a + ln]
    elif kind == 'ints':
        # sizes and offsets are 32-bit numbers: make some of them huge or negative
        for _ in range(rng.choice([1, 3, 10])):
            at = rng.randrange(max(1, n - 4))
            data[at:at + 4] = rng.choice([b'\xff\xff\xff\x7f', b'\xff\xff\xff\xff', b'\x00\x00\x00\x80', b'\x01\x00\x00\x00', b'\x00\x00\x00\x00'])
    else:
        # the compound-file header and its sector tables
        for _ in range(rng.choice([1, 4])):
            data[rng.randrange(min(n, 1024))] = rng.randrange(256)
    return kind


stats = {'opened': 0, 'error': 0, 'crash': 0, 'hang': 0}
slowest = 0.0
start = time.time()
for slug, path in picked:
    original = path.read_bytes()
    for i in range(runs):
        data = bytearray(original)
        kind = damage(data)
        work.write_bytes(data)
        t = time.time()
        try:
            r = subprocess.run([str(exe), 'json', str(work)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            stats['hang'] += 1
            shutil.copy(work, out / f'hang-{slug}-{i}-{kind}.pub')
            print(f'HANG  {slug} case {i} ({kind})')
            continue
        took = time.time() - t
        slowest = max(slowest, took)
        err = r.stderr.decode('utf-8', 'replace')
        if r.returncode != 0 or 'panicked' in err:
            stats['crash'] += 1
            keep = out / f'crash-{slug}-{i}-{kind}.pub'
            shutil.copy(work, keep)
            where = next((ln for ln in err.splitlines() if 'panicked at' in ln), err.strip()[:160])
            print(f'CRASH {slug} case {i} ({kind}): {where.strip()[:170]}')
        elif err.strip():
            stats['error'] += 1
        else:
            stats['opened'] += 1
work.unlink(missing_ok=True)
total = sum(stats.values())
print(f"{total} damaged files from {len(picked)} samples in {time.time() - start:.0f}s: {stats['opened']} opened, {stats['error']} reported an error, {stats['crash']} crashed, {stats['hang']} hung; slowest {slowest:.1f}s")
sys.exit(1 if stats['crash'] or stats['hang'] else 0)
