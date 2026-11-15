#!/bin/sh
# Builds, exports the sample to .docx, opens it in Word (-> PDF) and makes comparison sheets.
# Usage: tools/docx-check.sh [sample-name] [pages...]
cd "$(dirname "$0")/.." || exit 1
name=${1:-year7-booklet}; [ $# -gt 0 ] && shift
cargo build -p openpub-core 2>&1 | grep -E "^error" -A8
./target/debug/pubdump docx "samples/$name.pub" "out/$name.docx" || exit 1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/docx-check.ps1 -Docx "out/$name.docx" -Pdf "out/$name.pdf" || exit 1
python tools/docx-pages.py "out/$name.pdf" "truth/$name" "out/docxcmp-$name" "$@"
