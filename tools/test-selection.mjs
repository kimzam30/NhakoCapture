/* Unit tests for src/overlay/selection.js
 *
 *   node tools/test-selection.mjs
 *
 * selection.js needs a DOM, so it gets a deliberately tiny one -- just the
 * surface the module actually touches. That is enough to drive real pointer
 * sequences through the module and assert on the resulting geometry, which is
 * where the interaction bugs live: clamping at the edges, flipping a handle
 * past its opposite side, and the misclick threshold.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
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
const ok = (label, c) => eq(label, !!c, true);

/* --- the smallest DOM that selection.js can run against ------------------ */
function makeEl(tag) {
  const e = {
    tagName: tag, children: [], parentNode: null,
    style: {}, dataset: {}, attrs: {},
    className: '', textContent: '', hidden: false,
    offsetWidth: 60, offsetHeight: 20,
    classList: { contains: (c) => String(e.className).split(/\s+/).includes(c) },
    appendChild(c) { e.children.push(c); c.parentNode = e; return c; },
    setAttribute(k, v) { e.attrs[k] = v; },
    getAttribute(k) { return e.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    closest(sel) {
      const want = sel.replace(/^\./, '');
      let n = e;
      while (n) {
        if (String(n.className).split(/\s+/).includes(want)) return n;
        n = n.parentNode;
      }
      return null;
    },
  };
  return e;
}

const sandbox = {
  console: { warn() {}, info() {}, error() {} },
  document: { createElement: makeEl },
  Math, JSON, Number, String, Object, Array, Error, RangeError,
};
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(read('src/lib/namespace.js'), sandbox);
runInContext(read('src/lib/geometry.js'), sandbox);
runInContext(read('src/overlay/selection.js'), sandbox);

const NC = sandbox.globalThis.NhakoCapture;
const geometry = NC.require('geometry');
const selectionModule = NC.require('selection');

const VIEW = { width: 1280, height: 720 };

function harness(bitmapW = 1280, bitmapH = 720) {
  const layer = makeEl('div');
  const holes = [];
  const changes = [];
  const metrics = geometry.measure(bitmapW, bitmapH, VIEW.width, VIEW.height);
  const sel = selectionModule.create({
    layer, view: VIEW, metrics,
    setHole: (r) => holes.push(r ? { ...r } : null),
    onChange: (r, m) => changes.push({ rect: r ? { ...r } : null, mode: m }),
  });
  const marquee = layer.children.find((c) => c.className === 'nc-marquee');
  const badge = layer.children.find((c) => c.className === 'nc-badge');
  return { sel, layer, marquee, badge, holes, changes };
}

const capture = { setPointerCapture() {}, releasePointerCapture() {} };
const evt = (x, y, target, extra = {}) => ({
  button: 0, pointerId: 1, clientX: x, clientY: y,
  composedPath: () => [target],
  currentTarget: capture,
  preventDefault() {}, stopPropagation() {},
  ...extra,
});

function drag(h, from, to, target) {
  const t = target ?? makeEl('div');
  h.sel.onPointerDown(evt(from[0], from[1], t));
  h.sel.onPointerMove(evt(to[0], to[1], t));
  h.sel.onPointerUp(evt(to[0], to[1], t));
}

/* --- drawing -------------------------------------------------------------- */
{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  eq('drag produces the expected frame', h.sel.rect, { x: 100, y: 100, w: 300, h: 200 });
  eq('frame is committed for adjustment', h.sel.mode, 'adjusting');
  ok('marquee became visible', h.marquee.hidden === false);
}

{
  const h = harness();
  drag(h, [400, 300], [100, 100]);
  eq('dragging up-left gives the same frame', h.sel.rect, { x: 100, y: 100, w: 300, h: 200 });
}

{
  const h = harness();
  drag(h, [100, 100], [105, 105]);
  eq('a 5px drag is discarded as a misclick', h.sel.rect, null);
  eq('and returns to idle', h.sel.mode, 'idle');
  ok('marquee hidden again', h.marquee.hidden === true);
}

{
  const h = harness();
  drag(h, [100, 100], [600, 108]);
  eq('a wide but flat drag is also a misclick', h.sel.rect, null);
}

/* --- drawing past the viewport edge -------------------------------------- */
{
  const h = harness();
  drag(h, [1200, 650], [1500, 900]);
  eq('drag past the corner clamps to the viewport',
    h.sel.rect, { x: 1200, y: 650, w: 80, h: 70 });
}

/* --- moving --------------------------------------------------------------- */
{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  h.sel.onPointerDown(evt(200, 200, h.marquee));
  h.sel.onPointerMove(evt(250, 260, h.marquee));
  h.sel.onPointerUp(evt(250, 260, h.marquee));
  eq('marquee drag moves the frame without resizing it',
    h.sel.rect, { x: 150, y: 160, w: 300, h: 200 });
}

{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  h.sel.onPointerDown(evt(200, 200, h.marquee));
  h.sel.onPointerMove(evt(5000, 5000, h.marquee));
  h.sel.onPointerUp(evt(5000, 5000, h.marquee));
  eq('pushing the frame off-screen slides it to the edge, keeping its size',
    h.sel.rect, { x: 980, y: 520, w: 300, h: 200 });
}

/* --- resizing ------------------------------------------------------------- */
{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  const se = h.marquee.children.find((c) => c.dataset.dir === 'se');
  h.sel.onPointerDown(evt(400, 300, se));
  h.sel.onPointerMove(evt(500, 400, se));
  h.sel.onPointerUp(evt(500, 400, se));
  eq('se handle grows the frame', h.sel.rect, { x: 100, y: 100, w: 400, h: 300 });
}

{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  const nw = h.marquee.children.find((c) => c.dataset.dir === 'nw');
  h.sel.onPointerDown(evt(100, 100, nw));
  h.sel.onPointerMove(evt(150, 150, nw));
  h.sel.onPointerUp(evt(150, 150, nw));
  eq('nw handle moves the origin and shrinks', h.sel.rect, { x: 150, y: 150, w: 250, h: 150 });
}

{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  const e = h.marquee.children.find((c) => c.dataset.dir === 'e');
  // drag the east edge past the west edge: the frame should flip, not collapse
  h.sel.onPointerDown(evt(400, 200, e));
  h.sel.onPointerMove(evt(50, 200, e));
  h.sel.onPointerUp(evt(50, 200, e));
  eq('dragging a handle past its opposite edge flips the frame',
    h.sel.rect, { x: 50, y: 100, w: 50, h: 200 });
}

/* --- keyboard -------------------------------------------------------------- */
{
  const h = harness();
  drag(h, [100, 100], [400, 300]);

  ok('arrow nudges by 1', h.sel.onKeyDown({ key: 'ArrowRight' }));
  eq('nudged right', h.sel.rect.x, 101);

  h.sel.onKeyDown({ key: 'ArrowRight', shiftKey: true });
  eq('shift nudges by 10', h.sel.rect.x, 111);

  h.sel.onKeyDown({ key: 'ArrowDown', altKey: true });
  eq('alt+arrow resizes rather than moves', h.sel.rect.h, 201);

  eq('unrelated keys are not claimed', h.sel.onKeyDown({ key: 'a' }), false);
}

{
  const h = harness();
  eq('arrows do nothing with no frame', h.sel.onKeyDown({ key: 'ArrowRight' }), false);
}

/* --- selectAll and clear ---------------------------------------------------- */
{
  const h = harness();
  h.sel.selectAll();
  eq('capture full screen selects the whole viewport',
    h.sel.rect, { x: 0, y: 0, w: 1280, h: 720 });
  eq('and is immediately adjustable', h.sel.mode, 'adjusting');

  h.sel.clear();
  eq('clear empties the frame', h.sel.rect, null);
  eq('and returns to idle', h.sel.mode, 'idle');
  eq('scrim hole is removed', h.holes.at(-1), null);
}

/* --- the badge reports OUTPUT pixels, not CSS pixels ----------------------- */
{
  const h = harness(1280, 720); // dpr 1
  drag(h, [100, 100], [400, 300]);
  eq('badge at dpr 1', h.badge.textContent, '300 × 200');
}
{
  const h = harness(2560, 1440); // dpr 2
  drag(h, [100, 100], [400, 300]);
  eq('badge reports the real file size at dpr 2', h.badge.textContent, '600 × 400');
}

/* --- scrim tracks the frame -------------------------------------------------- */
{
  const h = harness();
  drag(h, [100, 100], [400, 300]);
  eq('scrim hole matches the frame', h.holes.at(-1), { x: 100, y: 100, w: 300, h: 200 });
}

console.log(`\nselection: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
