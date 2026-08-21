#!/usr/bin/env bash
# Every check that can run without a browser.
#   ./tools/test.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

step "manifest + referenced paths"
python3 - <<'PY' || fail=1
import json, os, sys
m = json.load(open('manifest.json'))
paths = [m['background']['service_worker']]
paths += m['action']['default_icon'].values()
paths += m['icons'].values()
bad = [p for p in sorted(set(paths)) if not os.path.isfile(p)]
print(f"  {len(set(paths))} referenced paths, {len(bad)} missing")
if bad: print("  MISSING:", bad); sys.exit(1)
PY

step "js syntax"
for f in $(find src tools -name '*.js' -o -name '*.mjs' | sort); do
  if node --check "$f" 2>/dev/null; then printf '  ok   %s\n' "$f"
  else printf '  FAIL %s\n' "$f"; node --check "$f"; fail=1; fi
done

step "internal paths resolve"
python3 - <<'PY' || fail=1
import re, os, sys
bad = []
for f in ('src/background.js',):
    s = open(f).read()
    for p in re.findall(r"'(src/[^']+\.(?:js|html|css))'", s):
        if not os.path.isfile(p): bad.append((f, p))
print(f"  {len(bad)} broken")
if bad: print("  BROKEN:", bad); sys.exit(1)
PY

step "unit tests"
node tools/test-geometry.mjs   || fail=1
node tools/test-background.mjs || fail=1
node tools/test-modules.mjs    || fail=1
node tools/test-selection.mjs  || fail=1
node tools/test-ops.mjs        || fail=1

step "browser integration (real Chromium, real input)"
if command -v google-chrome >/dev/null || command -v chromium >/dev/null; then
  node tools/preview.mjs "${NC_PREVIEW_DIR:-preview}" || fail=1
else
  echo "  skipped — no Chromium-based browser on PATH"
fi

if [ "$fail" -eq 0 ]; then printf '\n\033[32mall checks passed\033[0m\n'
else printf '\n\033[31mFAILURES\033[0m\n'; fi
exit $fail
