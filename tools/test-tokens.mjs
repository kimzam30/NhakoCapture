/* Token drift guard.
 *
 *   node tools/test-tokens.mjs
 *
 * The action badge is browser chrome, painted through chrome.action.set*, from
 * a service worker that has no CSS and cannot read tokens.css. Its colours
 * therefore exist in two files by necessity — which is exactly how a token
 * system rots: one is changed, the other is not, and nothing says so until
 * somebody notices a badge that no longer matches anything else.
 *
 * A comment asking the next person to keep them in step would not hold. This
 * does. It resolves the var() chains in tokens.css and compares the result
 * against the constants in background.js, in both directions, and additionally
 * refuses to let a raw colour literal reappear anywhere else in that file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
const failures = [];
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (label, cond) => eq(label, !!cond, true);

const tokensCss = read('src/overlay/tokens.css');
const backgroundJs = read('src/background.js');

/* --- every custom property in tokens.css, with var() chains resolved ------ */
const declared = new Map();
for (const m of tokensCss.matchAll(/(--nc-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
  // First declaration wins: later ones are the forced-colors and
  // reduced-motion overrides, which are not what the worker paints with.
  if (!declared.has(m[1])) declared.set(m[1], m[2].trim());
}

function resolve(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = declared.get(name);
  if (raw === undefined) return undefined;
  const ref = raw.match(/^var\(\s*(--nc-[a-z0-9-]+)\s*\)$/i);
  return ref ? resolve(ref[1], seen) : raw.replace(/\s*\/\*[\s\S]*?\*\/\s*/g, '').trim();
}

ok('tokens.css parsed', declared.size > 20);
eq('var() chains resolve', resolve('--nc-badge-progress'), resolve('--nc-accent'));

/* --- the BADGE constants in background.js -------------------------------- */
const badgeBlock = backgroundJs.match(/const BADGE = \{([\s\S]*?)\};/);
ok('background.js declares a BADGE block', !!badgeBlock);

const constants = new Map();
if (badgeBlock) {
  for (const m of badgeBlock[1].matchAll(/(\w+)\s*:\s*'(#[0-9a-f]{3,8})'/gi)) {
    constants.set(m[1], m[2].toLowerCase());
  }
}
eq('four badge constants', constants.size, 4);

/* The mapping is spelled out rather than derived from the names: a rule that
 * turns `progressText` into `--nc-badge-progress-text` would also silently
 * accept a fifth constant nobody declared a token for. */
const MAPPING = {
  progress: '--nc-badge-progress',
  progressText: '--nc-badge-progress-text',
  error: '--nc-badge-error',
  errorText: '--nc-badge-error-text',
};

for (const [key, token] of Object.entries(MAPPING)) {
  const fromCss = (resolve(token) || '').toLowerCase();
  const fromJs = constants.get(key);
  ok(`${token} exists in tokens.css`, !!fromCss);
  ok(`BADGE.${key} exists in background.js`, !!fromJs);
  eq(`BADGE.${key} still equals ${token}`, fromJs, fromCss);
}

/* Both directions. Adding a --nc-badge-* token without wiring it into the
 * worker leaves a token nothing paints with, which is its own kind of rot. */
const badgeTokens = [...declared.keys()].filter((n) => n.startsWith('--nc-badge-'));
eq('no badge token is left unwired', badgeTokens.sort(),
   Object.values(MAPPING).sort());
eq('no badge constant is left unmapped', [...constants.keys()].sort(),
   Object.keys(MAPPING).sort());

/* --- no colour may reappear as a literal elsewhere in the worker ---------- */
{
  const withoutBadge = backgroundJs.replace(/const BADGE = \{[\s\S]*?\};/, '');
  const strays = [...withoutBadge.matchAll(/'(#[0-9a-f]{3,8})'/gi)].map((m) => m[1]);
  eq('the worker paints only through BADGE, never a literal', strays, []);
}

console.log(`\ntokens: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
