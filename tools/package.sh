#!/usr/bin/env bash
# Build the store uploads.
#   ./tools/package.sh            -> dist/NhakoCapture-<version>.zip          (Chrome Web Store)
#   ./tools/package.sh firefox    -> dist/NhakoCapture-<version>-firefox.zip  (addons.mozilla.org)
#   ./tools/package.sh all        -> both
#
# Only what the extension runs is shipped: the manifest, the icons and src/.
# docs/, tools/ and the design notes stay out of the zip -- the store would
# accept them, but every user would download them for nothing.
#
# manifest.json is the Chrome manifest. The Firefox one is derived from it by
# tools/firefox-manifest.py, so there is one source of truth for the version,
# permissions and commands.
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-chrome}"
case "$target" in chrome|firefox|all) ;; *) echo "usage: $0 [chrome|firefox|all]" >&2; exit 2 ;; esac

version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")

./tools/test.sh >/dev/null || { echo "checks failed; run ./tools/test.sh to see why" >&2; exit 1; }

mkdir -p dist

list() { unzip -l "$1" | tail -n +4 | head -n -2 | awk '{print "  " $4}'; }

build_chrome() {
  local out="dist/NhakoCapture-${version}.zip"
  rm -f "$out"
  zip -qr -X "$out" manifest.json icons src -x '*.DS_Store'
  echo "wrote $out ($(du -h "$out" | cut -f1))"
  list "$out"
}

build_firefox() {
  local out="dist/NhakoCapture-${version}-firefox.zip"
  local stage; stage=$(mktemp -d)
  trap 'rm -rf "$stage"' RETURN
  cp -r icons src "$stage"/
  # Chrome-only: the offscreen document. Firefox runs its jobs in the background page.
  rm -f "$stage/src/offscreen.html"
  python3 tools/firefox-manifest.py > "$stage/manifest.json"
  rm -f "$out"
  (cd "$stage" && zip -qr -X - manifest.json icons src -x '*.DS_Store') > "$out"
  echo "wrote $out ($(du -h "$out" | cut -f1))"
  list "$out"
}

[ "$target" = chrome ]  || [ "$target" = all ] && build_chrome
[ "$target" = firefox ] || [ "$target" = all ] && build_firefox
exit 0
