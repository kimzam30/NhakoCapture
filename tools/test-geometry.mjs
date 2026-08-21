/* Unit tests for src/lib/geometry.js
 *
 *   node tools/test-geometry.mjs
 *
 * geometry.js is a content-script IIFE, not an ES module, so it is loaded the
 * same way the browser loads it: evaluated against a globalThis that already
 * carries the namespace. No build step, no test framework, no dependencies.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { console };
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(readFileSync(join(root, 'src/lib/namespace.js'), 'utf8'), sandbox);
runInContext(readFileSync(join(root, 'src/lib/geometry.js'), 'utf8'), sandbox);

const G = sandbox.globalThis.NhakoCapture.require('geometry');

let pass = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

function throws(label, fn) {
  try {
    fn();
    failures.push(`${label}\n      expected a throw, got none`);
  } catch {
    pass++;
  }
}

/* --- normalizeDrag: a drag may start at any corner ---------------------- */
eq('drag down-right', G.normalizeDrag(10, 20, 110, 220), { x: 10, y: 20, w: 100, h: 200 });
eq('drag up-left',    G.normalizeDrag(110, 220, 10, 20), { x: 10, y: 20, w: 100, h: 200 });
eq('drag up-right',   G.normalizeDrag(10, 220, 110, 20), { x: 10, y: 20, w: 100, h: 200 });
eq('drag zero',       G.normalizeDrag(50, 50, 50, 50),   { x: 50, y: 50, w: 0, h: 0 });

/* --- measure ------------------------------------------------------------ */
const dpr1 = G.measure(1280, 720, 1280, 720);
eq('dpr 1 scaleX', dpr1.scaleX, 1);
eq('dpr 1 scaleY', dpr1.scaleY, 1);

const dpr2 = G.measure(2560, 1440, 1280, 720);
eq('dpr 2 scaleX', dpr2.scaleX, 2);

const dpr125 = G.measure(1600, 900, 1280, 720);
eq('dpr 1.25 scaleX', dpr125.scaleX, 1.25);

throws('measure rejects zero-area bitmap',   () => G.measure(0, 720, 1280, 720));
throws('measure rejects zero-area viewport', () => G.measure(1280, 720, 0, 720));

/* --- toDevice: the core correctness property ---------------------------- */
eq('dpr 1 is identity',
  G.toDevice({ x: 100, y: 50, w: 300, h: 200 }, dpr1),
  { x: 100, y: 50, w: 300, h: 200 });

eq('dpr 2 doubles',
  G.toDevice({ x: 100, y: 50, w: 300, h: 200 }, dpr2),
  { x: 200, y: 100, w: 600, h: 400 });

eq('dpr 1.25 scales and rounds',
  G.toDevice({ x: 100, y: 50, w: 300, h: 200 }, dpr125),
  { x: 125, y: 63, w: 375, h: 250 });

/* Fractional DPR must not let a rect drift by a pixel depending on where it
 * starts. Rounding both edges and subtracting is what guarantees this;
 * rounding origin and size independently does not. */
{
  const m = G.measure(1600, 900, 1280, 720);
  const a = G.toDevice({ x: 10.4, y: 0, w: 100, h: 10 }, m);
  const b = G.toDevice({ x: 10.6, y: 0, w: 100, h: 10 }, m);
  eq('sub-pixel origin shift keeps width within 1px',
    Math.abs(a.w - b.w) <= 1, true);
}

/* Adjacent selections must tile seamlessly -- no gap, no overlap. */
{
  const m = G.measure(1600, 900, 1280, 720);
  const left  = G.toDevice({ x: 0,   y: 0, w: 333, h: 10 }, m);
  const right = G.toDevice({ x: 333, y: 0, w: 333, h: 10 }, m);
  eq('adjacent rects tile seamlessly', left.x + left.w, right.x);
}

/* --- clamping: a selection dragged past the edge ------------------------ */
eq('clamps past right edge',
  G.toDevice({ x: 1200, y: 0, w: 400, h: 100 }, dpr1),
  { x: 1200, y: 0, w: 80, h: 100 });

eq('clamps past bottom edge',
  G.toDevice({ x: 0, y: 700, w: 100, h: 400 }, dpr1),
  { x: 0, y: 700, w: 100, h: 20 });

eq('clamps negative origin',
  G.toDevice({ x: -50, y: -50, w: 100, h: 100 }, dpr1),
  { x: 0, y: 0, w: 50, h: 50 });

eq('fully offscreen yields no area',
  G.toDevice({ x: 5000, y: 5000, w: 100, h: 100 }, dpr1),
  { x: 1280, y: 720, w: 0, h: 0 });

eq('clamps at dpr 2 too',
  G.toDevice({ x: 1200, y: 0, w: 400, h: 100 }, dpr2),
  { x: 2400, y: 0, w: 160, h: 200 });

/* --- clampToViewport ---------------------------------------------------- */
eq('clampToViewport trims overhang',
  G.clampToViewport({ x: 1200, y: 700, w: 400, h: 400 }, 1280, 720),
  { x: 1200, y: 700, w: 80, h: 20 });

/* --- output is always integral and in-bounds ---------------------------- */
{
  const m = G.measure(1600, 900, 1280, 720);
  let clean = true;
  for (let i = 0; i < 400; i++) {
    const r = G.normalizeDrag(
      Math.random() * 1400 - 60, Math.random() * 800 - 60,
      Math.random() * 1400 - 60, Math.random() * 800 - 60,
    );
    const d = G.toDevice(r, m);
    if (!Number.isInteger(d.x) || !Number.isInteger(d.y) ||
        !Number.isInteger(d.w) || !Number.isInteger(d.h) ||
        d.x < 0 || d.y < 0 ||
        d.x + d.w > m.bitmapWidth || d.y + d.h > m.bitmapHeight) {
      clean = false;
      failures.push(`fuzz: ${JSON.stringify(r)} -> ${JSON.stringify(d)}`);
      break;
    }
  }
  eq('400 random drags stay integral and in-bounds', clean, true);
}

/* --- misclick threshold -------------------------------------------------- */
eq('9x9 drag is a misclick',      G.isMeaningfulDrag({ x: 0, y: 0, w: 9, h: 9 }), false);
eq('10x10 drag is a selection',   G.isMeaningfulDrag({ x: 0, y: 0, w: 10, h: 10 }), true);
eq('wide but flat is a misclick', G.isMeaningfulDrag({ x: 0, y: 0, w: 500, h: 2 }), false);

/* --- fullViewport -------------------------------------------------------- */
eq('fullViewport is the whole bitmap',
  G.fullViewport(dpr2), { x: 0, y: 0, w: 2560, h: 1440 });

/* --- report -------------------------------------------------------------- */
console.log(`\ngeometry: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
