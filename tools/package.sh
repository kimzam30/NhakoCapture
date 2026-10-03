#!/usr/bin/env bash
# Build the Chrome Web Store upload.
#   ./tools/package.sh            -> dist/NhakoCapture-<version>.zip
#
# Only what the extension runs is shipped: the manifest, the icons and src/.
# docs/, tools/ and the design notes stay out of the zip -- the store would
# accept them, but every user would download them for nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/NhakoCapture-${version}.zip"

./tools/test.sh >/dev/null || { echo "checks failed; run ./tools/test.sh to see why" >&2; exit 1; }

mkdir -p dist
rm -f "$out"
zip -qr -X "$out" manifest.json icons src -x '*.DS_Store'

echo "wrote $out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
