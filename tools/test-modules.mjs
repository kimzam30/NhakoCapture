/* Injection-order and module-graph checks for the overlay files.
 *
 *   node tools/test-modules.mjs
 *
 * There is no bundler, so nothing verifies that a file's NC.require() calls are
 * satisfied by a file injected before it. Get that order wrong and the failure
 * is a runtime throw on a real page, in front of the user. This checks it
 * statically, from the single source of truth: OVERLAY_FILES in background.js.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
const failures = [];
const eq = (label, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else failures.push(`${label}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

const bg = read('src/background.js');

const overlayFiles = [...bg.matchAll(/'(src\/(?:lib|overlay)\/[^']+\.js)'/g)]
  .map((m) => m[1])
  .filter((f, i, a) => a.indexOf(f) === i);

ok('OVERLAY_FILES was found in background.js', overlayFiles.length > 0);
eq('namespace.js is first', overlayFiles[0], 'src/lib/namespace.js');
eq('inject.js is last', overlayFiles.at(-1), 'src/overlay/inject.js');

/* --- the module graph respects injection order --------------------------- */
const definedBy = new Map(); // module name -> index of the file defining it

overlayFiles.forEach((file, index) => {
  const src = read(file);
  for (const m of src.matchAll(/NC\.define\(\s*'([^']+)'/g)) {
    if (definedBy.has(m[1])) {
      failures.push(`module "${m[1]}" is defined twice (${overlayFiles[definedBy.get(m[1])]} and ${file})`);
    }
    definedBy.set(m[1], index);
  }
});

overlayFiles.forEach((file, index) => {
  const src = read(file);
  for (const m of src.matchAll(/NC\.require\(\s*'([^']+)'\s*\)/g)) {
    const name = m[1];
    if (!definedBy.has(name)) {
      failures.push(`${file} requires "${name}", which no injected file defines`);
      continue;
    }
    const at = definedBy.get(name);
    if (at >= index) {
      failures.push(
        `${file} (position ${index}) requires "${name}", defined later in ` +
        `${overlayFiles[at]} (position ${at}) — it will throw at runtime`
      );
    } else pass++;
  }
});

/* --- every overlay file is re-injection safe ------------------------------ */
for (const file of overlayFiles.slice(1)) {
  const src = read(file);
  ok(`${file} guards against double definition`,
    /if \(!NC \|\| NC\.modules\./.test(src) || /if \(!NC\) return/.test(src));
  ok(`${file} is wrapped in an IIFE`, /^\(\(\) => \{/m.test(src));
  ok(`${file} is strict`, /'use strict';/.test(src));
}

/* --- stylesheets ---------------------------------------------------------- */
const styleFiles = [...bg.matchAll(/'(src\/overlay\/[^']+\.css)'/g)].map((m) => m[1]);
eq('two stylesheets are shipped', styleFiles.length, 2);
eq('tokens.css is first (overlay.css consumes its properties)', styleFiles[0], 'src/overlay/tokens.css');

const tokens = read(styleFiles[0]);
const overlayCss = read(styleFiles[1]);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

for (const [name, css] of [['tokens.css', tokens], ['overlay.css', overlayCss]]) {
  const s = strip(css);
  let depth = 0, broke = false;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) { broke = true; break; }
  }
  ok(`${name} braces balanced`, depth === 0 && !broke);
  ok(`${name} parens balanced`, (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length);
}

/* Every --nc-* the overlay uses must be declared by tokens.css. A typo here is
 * an invisible failure: the property silently resolves to nothing. */
const declared = new Set([...strip(tokens).matchAll(/(--nc-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = new Set([...strip(overlayCss).matchAll(/var\((--nc-[a-z0-9-]+)/g)].map((m) => m[1]));
const undeclared = [...used].filter((t) => !declared.has(t));
eq('every token overlay.css uses is declared', undeclared, []);
ok('overlay.css actually uses the token system', used.size > 20);

/* The accessibility rule that the brief calls load-bearing: the base accent is
 * 2.80:1 on the dark chrome and must never be a border or outline. */
const accentAsBorder = [...strip(overlayCss).matchAll(/(?:border|outline)[^;:]*:\s*[^;]*var\(--nc-accent\)/g)];
eq('--nc-accent is never used as a border or outline', accentAsBorder.map((m) => m[0]), []);

console.log(`\nmodules: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
