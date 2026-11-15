#!/bin/sh
# Build, export the sample and screenshot the given pages next to Publisher's rendering.
# usage: tools/check.sh [sample-name] page...
name=year7-booklet
case "$1" in *[!0-9]*) name=$1; shift;; esac
cargo build -q -p openpub-core 2>&1 | grep -E "^error" -A12 | head -60
./target/debug/pubdump html samples/$name.pub out/html-$name && python tools/shot.py out/html-$name truth/$name out/shots-$name "$@"
