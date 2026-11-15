#!/bin/sh
# Exports the samples that exercise the newer model features to .docx, opens each in Word
# (tools/docx-check.ps1 -> PDF) and makes side-by-side sheets against truth/ (tools/docx-cmp.py).
# Usage: tools/docx-feat.sh [slug ...]   (default: all the feature samples)
# Output: out/docx-feat/<slug>.docx, .pdf, cmp-<slug>-NNN.png
cd "$(dirname "$0")/.." || exit 1
cargo build -q -p openpub-core 2>&1 | grep -E "^error" -A8
out=out/docx-feat
mkdir -p "$out"
[ $# -eq 0 ] && set -- year7-booklet cymru-textbook-1-9-and-10 christmas-wordgame-sheet appendix-4-flowchart-for-schools-suspect publication1 probe-linked probe-shapes
for slug in "$@"; do
    src=$(python tools/samples.py "$slug") || continue
    ./target/debug/pubdump docx "$src" "$out/$slug.docx" || { echo "$slug: export failed"; continue; }
    printf '%s: ' "$slug"
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/docx-check.ps1 -Docx "$out/$slug.docx" -Pdf "$out/$slug.pdf"
done
