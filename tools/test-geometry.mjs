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

const ok = (label, cond) => eq(label, !!cond, true);

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
/* --- full-page: the scroll plan ------------------------------------------ */
{
  const P = (d, v, m = Infinity) => G.planStops(d, v, m);

  eq('exact multiple: three stops, no redundant fourth', P(2700, 900), [0, 900, 1800]);
  eq('non-multiple: last stop clamped to the end of the page', P(2500, 900), [0, 900, 1600]);
  eq('shorter than the viewport: a single stop', P(400, 900), [0]);
  eq('exactly one viewport: a single stop', P(900, 900), [0]);
  eq('one pixel taller: a second, heavily overlapping stop', P(901, 900), [0, 1]);
  eq('ceiling truncates the plan', P(90000, 900, 2700), [0, 900, 1800]);

  /* The clamped final stop overlaps its predecessor on purpose. If it were a
     full step instead, it would ask for a scroll the page cannot perform and
     the tile would silently repeat the one before it. */
  const stops = P(2500, 900);
  ok('final stop overlaps rather than overshoots',
     stops.at(-1) < stops.at(-2) + 900 && stops.at(-1) === 1600);

  throws('a zero-height viewport is refused, not divided by', () => P(2700, 0));
}

/* --- full-page: the ceiling ---------------------------------------------- */
{
  eq('ceiling at 1x', G.heightCeiling(1), 16384);
  eq('ceiling at 2x is half the CSS height', G.heightCeiling(2), 8192);
  eq('ceiling at 1.5x', G.heightCeiling(1.5), 10922);
  eq('a nonsense scale does not divide by zero', G.heightCeiling(0), 16384);

  const under = G.planFullPage({ docHeight: 5000, viewHeight: 900, scaleY: 1 });
  ok('a normal page is not capped', under.capped === false);
  eq('and keeps its full height', under.cssHeight, 5000);

  const over = G.planFullPage({ docHeight: 40000, viewHeight: 900, scaleY: 1 });
  ok('an over-tall page is capped', over.capped === true);
  eq('capped to the ceiling', over.cssHeight, 16384);
  eq('the true height is still reported', over.fullCssHeight, 40000);
  ok('the plan stops at the cap', over.stops.at(-1) + 900 <= 16384 + 900);

  const retina = G.planFullPage({ docHeight: 12000, viewHeight: 900, scaleY: 2 });
  ok('dpr is applied to the ceiling', retina.capped === true);
  eq('capped to half the CSS height', retina.cssHeight, 8192);

  /* The ceiling must be decided from measurements, before any allocation --
     Chromium answers an oversized canvas with a blank one rather than an
     error, and finding that out afterwards discards a capture the user
     already waited for. */
  ok('capped is known from the plan alone', typeof over.capped === 'boolean');
}

/* --- full-page: turning observed tiles into draws ------------------------- */
{
  const T = (y) => ({ y, width: 1200, height: 900 });

  {
    const p = G.planStitch([T(0), T(900), T(1800)], { scaleY: 1, cssHeight: 2700 });
    eq('exact multiple: canvas is the document', [p.width, p.height], [1200, 2700]);
    eq('one draw per tile', p.draws.length, 3);
    eq('tiles land at their offsets', p.draws.map((d) => d.dstY), [0, 900, 1800]);
    ok('every tile drawn whole', p.draws.every((d) => d.srcH === 900));
  }

  {
    // The clamped final tile overlaps. It must be drawn whole, at its own
    // offset -- the overlap rewrites identical pixels, which is the point.
    const p = G.planStitch([T(0), T(900), T(1600)], { scaleY: 1, cssHeight: 2500 });
    eq('non-multiple: canvas is the document', p.height, 2500);
    eq('overlapping tile keeps its offset', p.draws.at(-1).dstY, 1600);
    eq('and is drawn in full', p.draws.at(-1).srcH, 900);
    eq('bottom edge lands exactly on the document end',
       p.draws.at(-1).dstY + p.draws.at(-1).srcH, 2500);
  }

  {
    // A page shorter than the viewport: the tile contains 400px of document
    // and 500px of whatever the browser paints under a short body.
    const p = G.planStitch([T(0)], { scaleY: 1, cssHeight: 400 });
    eq('short page: canvas is the document, not the tile', p.height, 400);
    eq('the tile is cropped, not stretched', p.draws[0].srcH, 400);
    eq('source and destination heights agree', p.draws[0].dstH, p.draws[0].srcH);
  }

  {
    // A page that refused to scroll claims 2700px but only ever gave us one
    // tile. Trusting the document would leave 1800px of blank canvas.
    const p = G.planStitch([T(0)], { scaleY: 1, cssHeight: 2700 });
    eq('frozen page: canvas is what the tiles cover', p.height, 900);
    eq('no blank strip below', p.draws[0].dstY + p.draws[0].srcH, 900);
  }

  {
    /* Tile width/height are DEVICE pixels, so at 2x a 900px CSS viewport
       arrives as an 1800px-tall bitmap. Passing 900 here instead is what a
       caller who confused the two spaces would do, and the case below asserts
       that planStitch refuses to invent the missing half rather than
       stretching to the height the document claims. */
    const R = (y) => ({ y, width: 2400, height: 1800 });
    const p = G.planStitch([R(0), R(900)], { scaleY: 2, cssHeight: 1800 });
    eq('dpr scales the canvas', [p.width, p.height], [2400, 3600]);
    eq('and the offsets', p.draws.map((d) => d.dstY), [0, 1800]);
    ok('tiles are drawn at device size', p.draws.every((d) => d.srcH === 1800));
  }

  {
    // Tiles that do not cover what the document claims are never stretched to
    // fill it. A short canvas is honest; a stretched one is a lie at every
    // pixel.
    const p = G.planStitch([T(0), T(900)], { scaleY: 2, cssHeight: 1800 });
    eq('under-covering tiles shrink the canvas rather than stretch',
       p.height, 2700);
    ok('and are still drawn at their own size',
       p.draws.every((d) => d.srcH === d.dstH));
  }

  {
    // Tiles past the ceiling are dropped rather than drawn off-canvas.
    const tall = [];
    for (let y = 0; y < 20000; y += 900) tall.push(T(y));
    const p = G.planStitch(tall, { scaleY: 1, cssHeight: 16384 });
    eq('canvas never exceeds the ceiling', p.height, 16384);
    ok('no draw starts past the ceiling', p.draws.every((d) => d.dstY < 16384));
    ok('no draw ends past the ceiling',
       p.draws.every((d) => d.dstY + d.srcH <= 16384));
    ok('the last tile is cropped to fit', p.draws.at(-1).srcH < 900);
  }

  {
    throws('stitching nothing is refused',
           () => G.planStitch([], { scaleY: 1, cssHeight: 900 }));
  }
}

console.log(`\ngeometry: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
